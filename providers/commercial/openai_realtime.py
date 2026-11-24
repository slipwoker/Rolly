"""Architecture A: OpenAI Realtime API (speech-to-speech), bridged server-side over WebSocket.

Protocol per the `openai` SDK realtime types as summarised in docs/research/01-commercial-realtime.md.
STATUS: implemented from the documented protocol and exercised against a local protocol
emulator (tests/test_commercial_bridges.py).  It has NOT been run against the live API in
this POC because no API key was available - see BLOCKERS.md.

Barge-in on WebSocket is client-driven: on `input_audio_buffer.speech_started` we tell the
browser to flush, and send `conversation.item.truncate` with the amount of audio that was
actually played so that the model's memory matches what the user heard.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from typing import Optional

import numpy as np
import soxr
import websockets

from memory.context import END_MARKER

from .. import base
from ..base import VoiceProvider

SR_API = 24_000


class OpenAIRealtimeProvider(VoiceProvider):
    architecture = "commercial"

    def __init__(self, provider_id: str, config: dict):
        super().__init__(provider_id, config)
        self.model = config.get("model", "gpt-realtime-2.1")
        self.voice = config.get("voice", "marin")
        self.url = config.get("url") or f"wss://api.openai.com/v1/realtime?model={self.model}"
        self.api_key = os.environ.get(config.get("api_key_env", "OPENAI_API_KEY")) or config.get("api_key") or "proxy-injected"
        self.turn_detection = config.get("turn_detection", "semantic_vad")
        self.transcription_model = config.get("transcription_model") or None
        self.noise_reduction = config.get("noise_reduction", "far_field")
        self.ws = None
        self._reader: Optional[asyncio.Task] = None
        self._up = soxr.ResampleStream(base.INPUT_SAMPLE_RATE, SR_API, 1, dtype="int16", quality="HQ")
        self._item_id: Optional[str] = None  # assistant item currently being spoken
        self._rid: Optional[str] = None
        self._first_audio_t: Optional[float] = None
        self._audio_ms_sent = 0.0
        self._text: dict[str, str] = {}
        self._proactive_rid: Optional[str] = None
        self._opener_pending = False
        self._closed = False

    def describe(self) -> dict:
        return {"provider_id": self.provider_id, "architecture": self.architecture, "model": self.model, "voice": self.voice,
                "turn_detection": self.turn_detection, "transport": "websocket (server-side bridge)"}

    async def _send(self, **event) -> None:
        if self.ws is not None and not self._closed:
            await self.ws.send(json.dumps(event))

    async def _start(self) -> None:
        self.ws = await websockets.connect(self.url, additional_headers={"Authorization": f"Bearer {self.api_key}"},
                                           max_size=None, open_timeout=20)
        td: dict = {"type": self.turn_detection, "create_response": True, "interrupt_response": True}
        if self.turn_detection == "semantic_vad":
            td["eagerness"] = self.config.get("eagerness", "auto")
        else:
            td["silence_duration_ms"] = int(self.config.get("silence_duration_ms", 500))
        audio_in: dict = {"format": {"type": "audio/pcm", "rate": SR_API}, "turn_detection": td}
        if self.noise_reduction:
            audio_in["noise_reduction"] = {"type": self.noise_reduction}
        if self.transcription_model:
            tr = {"model": self.transcription_model}
            if self.ctx.language in ("he", "en"):
                tr["language"] = self.ctx.language
            audio_in["transcription"] = tr
        instructions = self.ctx.system_prompt.replace(
            f"append the exact marker {END_MARKER} at the very end. Never say the marker out loud in any other situation.",
            "call the end_conversation tool.")
        await self._send(type="session.update", session={
            "type": "realtime", "instructions": instructions, "output_modalities": ["audio"],
            "audio": {"input": audio_in, "output": {"format": {"type": "audio/pcm", "rate": SR_API}, "voice": self.voice}},
            "tools": [{"type": "function", "name": "end_conversation",
                       "description": "Call after your closing sentence when the user clearly wants to stop the conversation.",
                       "parameters": {"type": "object", "properties": {}}}],
            "tool_choice": "auto",
        })
        self._reader = asyncio.create_task(self._read())
        if self.ctx.proactive and self.ctx.opener_instruction:
            self._opener_pending = True
            # The journey-start event goes in as a conversation item.  Per-response `instructions` would REPLACE the
            # session instructions for that response (observed in the first live run: the opener ignored the memory).
            await self._send(type="conversation.item.create",
                             item={"type": "message", "role": "user", "content": [{"type": "input_text", "text": self.ctx.opener_instruction}]})
            await self._send(type="response.create")

    async def push_audio(self, pcm16: bytes) -> None:
        if self.ws is None or self._closed:
            return
        up = self._up.resample_chunk(np.frombuffer(pcm16, dtype="<i2")).astype("<i2").tobytes()
        if up:
            await self._send(type="input_audio_buffer.append", audio=base64.b64encode(up).decode())

    async def send_text(self, text: str) -> None:
        await self._send(type="conversation.item.create",
                         item={"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]})
        await self._send(type="response.create")

    async def interrupt(self) -> None:
        await self._handle_barge_in(None)
        await self._send(type="response.cancel")

    def _played_ms(self) -> float:
        if self._first_audio_t is None:
            return 0.0
        return min(self._audio_ms_sent, (time.monotonic() - self._first_audio_t) * 1000)

    async def _handle_barge_in(self, audio_start_ms: Optional[float]) -> None:
        if self._rid is None or not (self.client_is_playing() or self._item_id):
            return
        rid, item, played = self._rid, self._item_id, self._played_ms()
        self.reset_playback_clock()
        await self.emit(base.AGENT_INTERRUPTED, response_id=rid, detect_audio_ms=audio_start_ms,
                        heard_text=None)
        if item and played < self._audio_ms_sent:
            await self._send(type="conversation.item.truncate", item_id=item, content_index=0, audio_end_ms=int(played))
        self._rid, self._item_id, self._first_audio_t, self._audio_ms_sent = None, None, None, 0.0

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                ev = json.loads(raw)
                await self._on_server_event(ev)
        except websockets.ConnectionClosed as e:
            if not self._closed:
                await self.emit(base.ERROR, message=f"OpenAI realtime connection closed: {e}", fatal=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.emit(base.ERROR, message=f"OpenAI realtime bridge: {e!r}"[:300], fatal=True)

    async def _on_server_event(self, ev: dict) -> None:
        t = ev.get("type", "")
        if t == "input_audio_buffer.speech_started":
            await self.emit(base.USER_SPEECH_STARTED, audio_ms=ev.get("audio_start_ms"))
            await self._handle_barge_in(ev.get("audio_start_ms"))
        elif t == "input_audio_buffer.speech_stopped":
            await self.emit(base.USER_SPEECH_STOPPED, audio_end_ms=ev.get("audio_end_ms"))
        elif t == "conversation.item.input_audio_transcription.completed":
            await self.emit(base.USER_TRANSCRIPT, text=(ev.get("transcript") or "").strip(), final=True, language=self.ctx.language)
        elif t == "response.created":
            rid = ev.get("response", {}).get("id", "")
            self._rid = rid
            self._first_audio_t, self._audio_ms_sent = None, 0.0
            proactive = self._opener_pending
            self._opener_pending = False
            await self.emit(base.AGENT_TURN_STARTED, response_id=rid, proactive=proactive)
        elif t == "response.output_audio.delta":
            rid = ev.get("response_id") or self._rid or "?"
            pcm = base64.b64decode(ev.get("delta", ""))
            if rid != self._rid:  # late audio of a cancelled response
                return
            self._item_id = ev.get("item_id") or self._item_id
            if self._first_audio_t is None:
                self._first_audio_t = time.monotonic()
            self._audio_ms_sent += len(pcm) / 2 / SR_API * 1000
            await self.emit(base.AGENT_AUDIO, audio=pcm, sample_rate=SR_API, response_id=rid)
        elif t == "response.output_audio_transcript.delta":
            rid = ev.get("response_id") or self._rid or "?"
            self._text[rid] = self._text.get(rid, "") + ev.get("delta", "")
            await self.emit(base.AGENT_TEXT, response_id=rid, delta=ev.get("delta", ""))
        elif t == "response.function_call_arguments.done" and ev.get("name") == "end_conversation":
            await self.emit(base.END_REQUESTED, reason="user_ended")
        elif t == "response.done":
            resp = ev.get("response", {})
            rid = resp.get("id", "")
            usage = resp.get("usage") or {}
            if usage:
                ind, outd = usage.get("input_token_details") or {}, usage.get("output_token_details") or {}
                cached = ind.get("cached_tokens_details") or {}
                await self.emit(base.USAGE, kind="realtime", model=self.model,
                                input_text_tokens=ind.get("text_tokens"), input_audio_tokens=ind.get("audio_tokens"),
                                cached_tokens=ind.get("cached_tokens"), cached_text_tokens=cached.get("text_tokens"),
                                cached_audio_tokens=cached.get("audio_tokens"),
                                output_text_tokens=outd.get("text_tokens"), output_audio_tokens=outd.get("audio_tokens"))
            if resp.get("status") in ("completed", "incomplete") and rid == self._rid:
                await self.emit(base.AGENT_TURN_DONE, response_id=rid, text=self._text.pop(rid, ""), interrupted=False, usage=usage)
                self._item_id = None
        elif t == "error":
            err = ev.get("error", {})
            # cancelling when nothing is in progress is harmless
            if err.get("code") not in ("response_cancel_not_active",):
                await self.emit(base.ERROR, message=f"OpenAI: {err.get('message', err)}"[:300], fatal=False)

    async def close(self) -> None:
        self._closed = True
        if self._reader:
            self._reader.cancel()
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
