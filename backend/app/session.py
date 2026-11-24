"""One live voice conversation: WebSocket <-> provider, with shared memory and telemetry.

Wire protocol (identical for every provider)
--------------------------------------------
client -> server
  text  {"type":"session.start", provider, user_id, language, journey{duration_min,...}, proactive, options, tag}
  bytes PCM16 mono 16 kHz microphone audio (any frame size, 20 ms recommended)
  text  {"type":"client.playback", event:"first_audio"|"flushed"|"idle", seq, ...}
  text  {"type":"interrupt"} | {"type":"text", text} | {"type":"event", name} | {"type":"ping", t} | {"type":"session.end"}
server -> client
  text  session.created / user.speech_started / user.speech_stopped / user.transcript / agent.turn_started /
        agent.text / agent.turn_done / agent.interrupted / turn.latency / session.summary / session.closed / error / pong
  bytes 4-byte little-endian response sequence number + PCM16 mono 24 kHz agent audio
"""
from __future__ import annotations

import asyncio
import json
import struct
import time
import uuid
import wave
from typing import Optional

import numpy as np
import soxr
from fastapi import WebSocket, WebSocketDisconnect

from memory.context import END_MARKER, build_context
from memory.summarizer import persist_summary, summarize_session
from providers import base
from providers.base import CLIENT_OUTPUT_SAMPLE_RATE, ProviderEvent, SessionContext
from telemetry.recorder import SessionRecorder

EVENT_PROMPTS = {
    "arrival_soon": "[arrival_soon event - this is not something the user said] The user will arrive in about one minute. "
                    "Wrap up now in at most two short sentences: name the main takeaway and the next step, and say goodbye. "
                    f"Then append {END_MARKER}.",
}


class VoiceSession:
    def __init__(self, ws: WebSocket, app_state, start: dict):
        self.ws = ws
        self.app = app_state
        self.start = start
        self.session_id = start.get("session_id") or uuid.uuid4().hex[:12]
        self.provider = None
        self.rec: Optional[SessionRecorder] = None
        self._seq: dict[str, int] = {}
        self._next_seq = 1
        self._proactive_rids: set[str] = set()
        self._resamplers: dict[tuple[str, int], soxr.ResampleStream] = {}
        self._turn_idx = 0
        self._turns: list[dict] = []
        self._agent_partial: dict[str, str] = {}
        self._send_lock = asyncio.Lock()
        self._closing = asyncio.Event()
        self._end_reason = "client_disconnect"
        self._end_task: Optional[asyncio.Task] = None
        self._audio_dump = None
        self._first_send_t: dict[int, float] = {}

    # -- sending -----------------------------------------------------------------
    async def _send_json(self, type_: str, **data) -> None:
        try:
            async with self._send_lock:
                await self.ws.send_text(json.dumps({"type": type_, **data}, ensure_ascii=False))
        except Exception:
            self._closing.set()

    async def _send_audio(self, seq: int, pcm: bytes) -> None:
        try:
            async with self._send_lock:
                await self.ws.send_bytes(struct.pack("<I", seq) + pcm)
        except Exception:
            self._closing.set()

    def _seq_for(self, rid: str) -> int:
        if rid not in self._seq:
            self._seq[rid] = self._next_seq
            self._next_seq += 1
        return self._seq[rid]

    def _resample(self, rid: str, pcm: bytes, sr: int) -> bytes:
        if sr == CLIENT_OUTPUT_SAMPLE_RATE:
            return pcm
        key = (rid, sr)
        rs = self._resamplers.get(key)
        if rs is None:
            rs = soxr.ResampleStream(sr, CLIENT_OUTPUT_SAMPLE_RATE, 1, dtype="int16", quality="HQ")
            self._resamplers = {k: v for k, v in self._resamplers.items() if k[0] == rid}
            self._resamplers[key] = rs
        out = rs.resample_chunk(np.frombuffer(pcm, dtype="<i2"))
        return out.astype("<i2").tobytes()

    # -- provider events ---------------------------------------------------------
    async def _on_event(self, ev: ProviderEvent) -> None:
        rec = self.rec
        t, d = ev.type, ev.data
        if t == base.AGENT_AUDIO:
            rid = d.get("response_id", "?")
            seq = self._seq_for(rid)
            pcm = self._resample(rid, ev.audio, ev.sample_rate)
            if not pcm:
                return
            first = rec.on_agent_audio(rid, proactive=rid in self._proactive_rids)
            rec.audio_out(len(pcm), CLIENT_OUTPUT_SAMPLE_RATE)
            if first is not None:
                self._first_send_t[seq] = time.monotonic()
                await self._send_json("turn.latency", seq=seq, **first)
            await self._send_audio(seq, pcm)
        elif t == base.USER_SPEECH_STARTED:
            rec.on_speech_started(d.get("audio_ms"))
            await self._send_json(t)
        elif t == base.USER_SPEECH_STOPPED:
            rec.on_speech_stopped(d.get("audio_end_ms"))
            await self._send_json(t)
        elif t == base.USER_TRANSCRIPT:
            if d.get("final"):
                text = (d.get("text") or "").strip()
                rec.event("user.transcript", **d)
                if text:
                    rec.turns_user += 1
                    self._add_turn("user", text, {"language": d.get("language")})
            await self._send_json(t, text=d.get("text", ""), final=bool(d.get("final")), language=d.get("language"))
        elif t == base.AGENT_TURN_STARTED:
            rid = d["response_id"]
            if d.get("proactive"):
                self._proactive_rids.add(rid)
            rec.event(t, **d)
            await self._send_json(t, seq=self._seq_for(rid), proactive=bool(d.get("proactive")))
        elif t == base.AGENT_TEXT:
            rid = d["response_id"]
            self._agent_partial[rid] = self._agent_partial.get(rid, "") + d.get("delta", "")
            await self._send_json(t, seq=self._seq_for(rid), delta=d.get("delta", ""))
        elif t == base.AGENT_TURN_DONE:
            rid = d["response_id"]
            text = (d.get("text") or self._agent_partial.get(rid, "")).replace(END_MARKER, "").strip()
            rec.turns_agent += 1
            rec.event(t, response_id=rid, text=text, interrupted=False, proactive=rid in self._proactive_rids, usage=d.get("usage"))
            if text:
                self._add_turn("agent", text, {"proactive": rid in self._proactive_rids})
            self._agent_partial.pop(rid, None)
            await self._send_json(t, seq=self._seq_for(rid), text=text)
        elif t == base.AGENT_INTERRUPTED:
            rid = d.get("response_id", "?")
            det = rec.on_interrupted(rid, d.get("detect_audio_ms"))
            heard = d.get("heard_text")
            partial = self._agent_partial.pop(rid, "")
            if heard is None:
                heard = partial
            # a turn that already completed was stored in full: replace it by what was actually heard
            if self._turns and self._turns[-1]["role"] == "agent" and self._turns[-1].get("rid") == rid:
                self._turns[-1]["text"] = heard or self._turns[-1]["text"]
                self._turns[-1]["meta"]["interrupted"] = True
            elif heard:
                rec.turns_agent += 1
                self._add_turn("agent", heard, {"interrupted": True}, rid=rid)
            await self._send_json(t, seq=self._seq_for(rid), interrupt_detect_ms=round(det, 1) if det is not None else None)
        elif t == base.METRIC:
            rec.on_metric(d["name"], d["value_ms"], d.get("response_id"))
        elif t == base.USAGE:
            rec.on_usage(d.pop("kind", "other"), **d)
        elif t == base.END_REQUESTED:
            rec.event(t, **d)
            if self._end_task is None:
                self._end_task = asyncio.create_task(self._end_after_playback(d.get("reason", "agent_ended")))
        elif t == base.ERROR:
            rec.errors += 1
            rec.event(t, **d)
            await self._send_json(t, message=d.get("message", ""), fatal=bool(d.get("fatal")))
            if d.get("fatal"):
                self._end_reason = "provider_error"
                self._closing.set()

    def _add_turn(self, role: str, text: str, meta: dict, rid: str | None = None) -> None:
        self._turns.append({"idx": self._turn_idx, "role": role, "text": text, "meta": meta, "rid": rid})
        self._turn_idx += 1

    async def _end_after_playback(self, reason: str) -> None:
        await asyncio.sleep(min(20.0, self.provider.playback_remaining_s() + 0.6))
        self._end_reason = reason
        self._closing.set()

    # -- main loop ---------------------------------------------------------------
    async def run(self) -> None:
        app, s = self.app, self.start
        store, registry, settings = app.store, app.registry, app.settings
        try:
            pid = registry.resolve(s.get("provider") or settings.default_provider or next(iter(registry.entries)))
        except KeyError:
            await self._send_json("error", message=f"unknown provider '{s.get('provider')}'", fatal=True)
            return
        user_id = s.get("user_id") or "daniel"
        journey = dict(s.get("journey") or {})
        journey.setdefault("duration_min", 25)
        journey["proactive"] = bool(s.get("proactive", True))
        ctx_d = build_context(store, user_id, s.get("language"), journey, system_prompt_override=s.get("system_prompt"))
        ctx = SessionContext(
            session_id=self.session_id, user_id=user_id, language=ctx_d["language"], system_prompt=ctx_d["system_prompt"],
            opener_instruction=ctx_d["opener_instruction"], proactive=journey["proactive"], journey=journey,
            profile=ctx_d["profile"], options=dict(s.get("options") or {}),
        )
        try:
            # model loading (first use) must not block the event loop for other sessions
            self.provider = await asyncio.get_running_loop().run_in_executor(None, registry.create, pid)
        except Exception as e:
            await self._send_json("error", message=str(e)[:300], fatal=True)
            return
        info = self.provider.describe()
        label = registry.label(pid)
        self.rec = SessionRecorder(self.session_id, store=store, jsonl_dir=settings.telemetry_dir,
                                   meta={"provider_id": pid, "blind_label": label, "user_id": user_id, "language": ctx.language,
                                         "journey": journey, "provider_info": info, "tag": s.get("tag"),
                                         "system_prompt_chars": len(ctx.system_prompt)})
        store.create_session(self.session_id, user_id, pid, label, ctx.language, journey, info, tag=s.get("tag"))
        if settings.retain_audio:
            settings.audio_dir.mkdir(parents=True, exist_ok=True)
            self._audio_dump = wave.open(str(settings.audio_dir / f"{self.session_id}_user.wav"), "wb")
            self._audio_dump.setnchannels(1)
            self._audio_dump.setsampwidth(2)
            self._audio_dump.setframerate(16000)
        app.active_sessions[self.session_id] = self
        await self._send_json("session.created", session_id=self.session_id, label=label, input_sample_rate=16000,
                              output_sample_rate=CLIENT_OUTPUT_SAMPLE_RATE, language=ctx.language, proactive=ctx.proactive,
                              user_name=ctx.profile.get("name"), retain_audio=settings.retain_audio)
        deadline = time.monotonic() + settings.max_session_minutes * 60
        try:
            t_start = time.monotonic()
            await self.provider.start(ctx, self._on_event)
            self.rec.on_metric("provider_start_ms", (time.monotonic() - t_start) * 1000)
            recv = asyncio.create_task(self._recv_loop())
            closer = asyncio.create_task(self._closing.wait())
            while True:
                timeout = max(0.1, deadline - time.monotonic())
                done, _ = await asyncio.wait({recv, closer}, return_when=asyncio.FIRST_COMPLETED, timeout=timeout)
                if not done:
                    self._end_reason = "max_duration"
                break
            for task in (recv, closer):
                if not task.done():
                    task.cancel()
            if recv.done() and not recv.cancelled() and recv.exception():
                raise recv.exception()
        except WebSocketDisconnect:
            self._end_reason = "client_disconnect"
        except Exception as e:  # provider crashed: count it as a session failure
            self._end_reason = "error"
            self.rec.errors += 1
            self.rec.event("session.error", error=repr(e)[:500])
            await self._send_json("error", message=repr(e)[:300], fatal=True)
        finally:
            await self._finalize()

    async def _recv_loop(self) -> None:
        while True:
            msg = await self.ws.receive()
            if msg["type"] == "websocket.disconnect":
                self._end_reason = "client_disconnect"
                return
            data = msg.get("bytes")
            if data is not None:
                self.rec.audio_in(len(data))
                if self._audio_dump:
                    self._audio_dump.writeframes(data)
                await self.provider.push_audio(data)
                continue
            text = msg.get("text")
            if not text:
                continue
            try:
                m = json.loads(text)
            except json.JSONDecodeError:
                continue
            mt = m.get("type")
            if mt == "client.playback":
                m.pop("type")
                self.rec.on_client(m)
            elif mt == "ping":
                await self._send_json("pong", t=m.get("t"), t_server=time.time())
            elif mt == "interrupt":
                await self.provider.interrupt()
            elif mt == "text":
                try:
                    await self.provider.send_text(str(m.get("text", ""))[:2000])
                except NotImplementedError:
                    await self._send_json("error", message="typed input is not supported by this provider", fatal=False)
            elif mt == "event" and m.get("name") in EVENT_PROMPTS:
                self.rec.event("journey.event", name=m["name"])
                try:
                    await self.provider.send_text(EVENT_PROMPTS[m["name"]])
                except NotImplementedError:
                    pass
            elif mt == "session.end":
                self._end_reason = "client_end"
                return

    async def _drain(self) -> None:
        """Keep reading (and discarding) client frames while the summary is produced, so that
        WebSocket keep-alives are still answered and the client is not back-pressured."""
        try:
            while True:
                msg = await self.ws.receive()
                if msg["type"] == "websocket.disconnect":
                    return
        except Exception:
            return

    async def _finalize(self) -> None:
        app = self.app
        app.active_sessions.pop(self.session_id, None)
        drain = asyncio.create_task(self._drain())
        try:
            await self._finalize_inner()
        finally:
            drain.cancel()
            try:
                await self.ws.close()
            except Exception:
                pass

    async def _finalize_inner(self) -> None:
        app = self.app
        if self._end_task and not self._end_task.done():
            self._end_task.cancel()
        try:
            if self.provider:
                await asyncio.wait_for(self.provider.close(), timeout=10)
        except Exception:
            pass
        if self._audio_dump:
            self._audio_dump.close()
        if not self.rec:
            return
        rec, store, settings = self.rec, app.store, app.settings
        visible = [t for t in self._turns if not t["text"].startswith("[")]
        summary = None
        if any(t["role"] == "user" for t in visible) and not self.start.get("skip_summary"):
            open_topics = [m["content"] for m in store.get_memories(self.start.get("user_id") or "daniel", "open_topic", limit=20)]
            t0 = time.monotonic()
            summary = await summarize_session(app.utility_llm, visible, open_topics)
            rec.on_metric("summary_ms", (time.monotonic() - t0) * 1000)
            if not self.start.get("ephemeral"):
                persist_summary(store, self.start.get("user_id") or "daniel", self.session_id, summary)
        if settings.store_transcripts:
            for t in self._turns:
                store.add_turn(self.session_id, t["idx"], t["role"], t["text"], t["meta"])
        stats = rec.stats()
        stats["end_reason"] = self._end_reason
        rec.event("session.end", reason=self._end_reason, stats=stats)
        store.end_session(self.session_id, summary, stats)
        rec.close()
        await self._send_json("session.summary", session_id=self.session_id, summary=summary, stats=stats)
        await self._send_json("session.closed", reason=self._end_reason)
