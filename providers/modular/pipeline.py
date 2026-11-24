"""Architecture B (and D): streaming modular pipeline.

    mic -> Silero VAD/endpointing -> STT -> LLM (streaming) -> sentence chunker -> TTS -> playback

The same class implements the hybrid architecture: each stage is chosen by config, so a
self-hosted STT can be combined with a commercial LLM and a commercial or local TTS.

Latency techniques implemented and individually switchable for benchmarking:
  * speculative turn: STT+LLM+TTS start at a short "eager" silence and are only released
    to the user once the endpoint is confirmed (cancelled if the user resumes speaking)
  * early first chunk: the first TTS chunk is cut at a clause boundary
  * barge-in: user speech while the agent is audible cancels LLM/TTS immediately and the
    spoken part of the reply is what gets stored in the conversation history
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Optional

import numpy as np

from memory.context import END_MARKER

from .. import base
from ..base import VoiceProvider
from .llm import LLMResult, OpenAICompatLLM
from .stt import get_stt
from .text import SentenceChunker, clean_for_speech, user_wants_to_end
from .tts import TTSRouter
from .vad import Endpointer, SileroVAD, VadConfig

_llm_clients: dict[str, OpenAICompatLLM] = {}


def get_llm(cfg: dict) -> OpenAICompatLLM:
    key = repr(sorted((k, repr(v)) for k, v in cfg.items()))
    if key not in _llm_clients:
        _llm_clients[key] = OpenAICompatLLM(cfg)
    return _llm_clients[key]


class _Gate:
    """Buffers provider events of a speculative turn until the endpoint is confirmed."""

    def __init__(self, provider: "ModularProvider", committed: bool):
        self._p = provider
        self.committed = committed
        self._buf: list[tuple[str, Optional[bytes], int, dict]] = []
        self.commit_time: Optional[float] = time.monotonic() if committed else None

    async def emit(self, type_: str, audio: bytes | None = None, sample_rate: int = base.CLIENT_OUTPUT_SAMPLE_RATE, **data) -> None:
        if self.committed:
            await self._p.emit(type_, audio=audio, sample_rate=sample_rate, **data)
        else:
            self._buf.append((type_, audio, sample_rate, data))

    async def commit(self) -> None:
        if self.committed:
            return
        self.committed = True
        self.commit_time = time.monotonic()
        buf, self._buf = self._buf, []
        for type_, audio, sr, data in buf:
            await self._p.emit(type_, audio=audio, sample_rate=sr, **data)


class ModularProvider(VoiceProvider):
    architecture = "modular"

    def __init__(self, provider_id: str, config: dict):
        super().__init__(provider_id, config)
        self.architecture = config.get("architecture", "modular")
        self.vad_cfg = VadConfig.from_dict(config.get("vad"))
        self.stt = get_stt(config["stt"])
        self.llm = get_llm(config["llm"])
        self.tts = TTSRouter(config["tts"])
        self.tts.warm()
        self.max_history_turns = int(config.get("max_history_turns", 40))
        self.history: list[dict] = []
        self._turn: Optional[asyncio.Task] = None
        self._gate: Optional[_Gate] = None
        self._turn_state: dict = {}
        self._closed = False

    def describe(self) -> dict:
        return {
            "provider_id": self.provider_id, "architecture": self.architecture,
            "stt": self.stt.name, "llm": self.llm.name, "tts": self.tts.name,
            "vad": {"engine": "silero", **self.vad_cfg.__dict__},
        }

    # -- lifecycle ---------------------------------------------------------------
    async def _start(self) -> None:
        opts = self.ctx.options or {}
        for k in ("endpoint_silence_ms", "eager_silence_ms", "bargein_min_speech_ms"):
            if k in opts:
                setattr(self.vad_cfg, k, float(opts[k]))
        self.endpointer = Endpointer(SileroVAD(self.config.get("vad_model", "models/silero_vad.onnx")), self.vad_cfg)
        if self.ctx.proactive and self.ctx.opener_instruction:
            gate = _Gate(self, committed=True)
            self._gate = gate
            self._turn = asyncio.create_task(self._run_turn(gate, text=self.ctx.opener_instruction, proactive=True))

    async def close(self) -> None:
        self._closed = True
        await self._cancel_turn(emit_interrupt=False)

    # -- audio in ----------------------------------------------------------------
    def _agent_audible(self) -> bool:
        active = self._turn is not None and not self._turn.done() and self._gate is not None and self._gate.committed
        return active or self.client_is_playing()

    async def push_audio(self, pcm16: bytes) -> None:
        if self._closed:
            return
        for ev in self.endpointer.feed(pcm16, agent_audible=self._agent_audible()):
            if ev.kind == "start":
                await self.emit(base.USER_SPEECH_STARTED, audio_ms=ev.audio_ms)
                if self._agent_audible():
                    await self._cancel_turn(emit_interrupt=True, detect_audio_ms=self.endpointer._stream_ms)
                elif self._turn and not self._turn.done():
                    await self._cancel_turn(emit_interrupt=False)
            elif ev.kind == "eager":
                gate = _Gate(self, committed=False)
                self._gate = gate
                self._turn = asyncio.create_task(self._run_turn(gate, audio=ev.audio, speculative=True))
            elif ev.kind == "resume":
                if self._gate is not None and not self._gate.committed:
                    await self._cancel_turn(emit_interrupt=False)
            elif ev.kind == "end":
                await self.emit(base.USER_SPEECH_STOPPED, audio_end_ms=ev.audio_ms)
                if self._gate is not None and not self._gate.committed and self._turn and not self._turn.done():
                    await self._gate.commit()
                elif self._gate is not None and not self._gate.committed and self._turn and self._turn.done():
                    # speculative turn already finished generating: just release it
                    await self._gate.commit()
                    await self._finalize_committed(self._turn_state)
                else:
                    gate = _Gate(self, committed=True)
                    self._gate = gate
                    self._turn = asyncio.create_task(self._run_turn(gate, audio=ev.audio))

    async def send_text(self, text: str) -> None:
        await self._cancel_turn(emit_interrupt=self._agent_audible())
        gate = _Gate(self, committed=True)
        self._gate = gate
        self._turn = asyncio.create_task(self._run_turn(gate, text=text, typed=True))

    async def interrupt(self) -> None:
        await self._cancel_turn(emit_interrupt=True)

    # -- turn handling -----------------------------------------------------------
    async def _cancel_turn(self, emit_interrupt: bool, detect_audio_ms: float | None = None) -> None:
        task, gate, state = self._turn, self._gate, self._turn_state
        was_committed = gate is not None and gate.committed
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if was_committed and state and not state.get("finalized"):
            # keep in history only what the user could actually have heard
            await self._finalize_committed(state, interrupted=True)
        elif was_committed and state and state.get("finalized") and self.client_is_playing():
            self._truncate_last_assistant(state)
        rid = state.get("rid") if state else None
        self.reset_playback_clock()
        self._turn, self._gate = None, None
        if emit_interrupt and was_committed and rid:
            await self.emit(base.AGENT_INTERRUPTED, response_id=rid, detect_audio_ms=detect_audio_ms,
                            heard_text=state.get("heard_text", ""))

    def _heard_text(self, state: dict) -> str:
        """Text of the chunks whose audio had started playing at the moment of interruption."""
        first = state.get("first_audio_t")
        if first is None:
            return ""
        gate = state.get("gate")
        # speculative audio is only released at commit time, so playback cannot start earlier
        first = max(first, (gate.commit_time or first) if gate else first)
        played = time.monotonic() - first
        heard, acc = [], 0.0
        for chunk_text, dur in state.get("chunks", []):
            if acc < played:
                heard.append(chunk_text)
            acc += dur
        return " ".join(heard)

    def _truncate_last_assistant(self, state: dict) -> None:
        heard = self._heard_text(state)
        state["heard_text"] = heard
        if self.history and self.history[-1]["role"] == "assistant":
            if heard:
                self.history[-1]["content"] = heard + " —"
            else:
                self.history.pop()

    async def _finalize_committed(self, state: dict, interrupted: bool = False) -> None:
        if state.get("finalized"):
            return
        state["finalized"] = True
        user_text = state.get("user_text")
        if user_text:
            if self.history and self.history[-1]["role"] == "user":
                self.history[-1]["content"] += "\n" + user_text
            else:
                self.history.append({"role": "user", "content": user_text})
        if interrupted:
            spoken = self._heard_text(state)
            state["heard_text"] = spoken
            if spoken:
                self.history.append({"role": "assistant", "content": spoken + " —"})
        else:
            spoken = clean_for_speech(state.get("agent_text", ""))
            if spoken:
                self.history.append({"role": "assistant", "content": spoken})
        if len(self.history) > self.max_history_turns * 2:
            self.history = self.history[-self.max_history_turns * 2:]
            while self.history and self.history[0]["role"] != "user":
                self.history.pop(0)

    def _messages(self, user_text: str) -> list[dict]:
        msgs = [{"role": "system", "content": self.ctx.system_prompt}] + [dict(m) for m in self.history]
        if msgs[-1]["role"] == "user":
            msgs[-1]["content"] += "\n" + user_text
        else:
            msgs.append({"role": "user", "content": user_text})
        return msgs

    async def _run_turn(self, gate: _Gate, audio: np.ndarray | None = None, text: str | None = None,
                        proactive: bool = False, speculative: bool = False, typed: bool = False) -> None:
        rid = uuid.uuid4().hex[:8]
        state: dict = {"rid": rid, "chunks": [], "agent_text": "", "finalized": False, "gate": gate}
        self._turn_state = state
        t_start = time.monotonic()
        lang_hint = self.ctx.language if self.ctx.language in ("he", "en") else None
        try:
            # 1) speech-to-text -----------------------------------------------------
            if audio is not None:
                res = await self.stt.transcribe(audio, lang_hint)
                text = res.text
                await gate.emit(base.METRIC, name="stt_ms", value_ms=res.ms, response_id=rid)
                await gate.emit(base.METRIC, name="stt_queue_ms", value_ms=res.queue_ms, response_id=rid)
                await gate.emit(base.USAGE, kind="stt", audio_s=res.audio_s, engine=self.stt.name)
                await gate.emit(base.USER_TRANSCRIPT, text=text, final=True, language=res.language,
                                avg_logprob=res.avg_logprob, no_speech_prob=res.no_speech_prob)
                if not text:
                    state["finalized"] = True
                    return
                if res.language in ("he", "en"):
                    lang_hint = res.language
            elif typed:
                await gate.emit(base.USER_TRANSCRIPT, text=text, final=True, language=lang_hint, typed=True)
            # for a proactive turn the journey-start event stays in history as the first user message
            state["user_text"] = text
            messages = self._messages(text)

            # 2) LLM -> chunker -> TTS ---------------------------------------------
            await gate.emit(base.AGENT_TURN_STARTED, response_id=rid, proactive=proactive, speculative=speculative)
            llm_res = LLMResult()
            chunk_q: asyncio.Queue = asyncio.Queue()
            t_llm = time.monotonic()

            async def produce() -> None:
                chunker = SentenceChunker()
                first_chunk = True
                try:
                    async for delta in self.llm.stream(messages, llm_res):
                        state["agent_text"] += delta
                        visible = delta.replace(END_MARKER, "")
                        if visible:
                            await gate.emit(base.AGENT_TEXT, response_id=rid, delta=visible)
                        for c in chunker.feed(delta):
                            if first_chunk:
                                first_chunk = False
                                await gate.emit(base.METRIC, name="llm_first_chunk_ms",
                                                value_ms=(time.monotonic() - t_llm) * 1000, response_id=rid)
                            await chunk_q.put(c)
                    for c in chunker.flush():
                        await chunk_q.put(c)
                finally:
                    await chunk_q.put(None)

            producer = asyncio.create_task(produce())
            tts_chars, tts_audio_s, first_audio = 0, 0.0, True
            try:
                while True:
                    chunk = await chunk_q.get()
                    if chunk is None:
                        break
                    t_tts = time.monotonic()
                    chunk_dur = 0.0
                    first_piece = True
                    async for pcm, sr, lang, _engine in self.tts.synth(chunk, lang_hint):
                        if first_piece:
                            first_piece = False
                            if first_audio:
                                first_audio = False
                                await gate.emit(base.METRIC, name="tts_ttfa_ms", value_ms=(time.monotonic() - t_tts) * 1000, response_id=rid)
                                await gate.emit(base.METRIC, name="pipeline_ms", value_ms=(time.monotonic() - t_start) * 1000, response_id=rid)
                                state["first_audio_t"] = time.monotonic()
                        chunk_dur += len(pcm) / 2 / sr
                        await gate.emit(base.AGENT_AUDIO, audio=pcm, sample_rate=sr, response_id=rid)
                    state["chunks"].append((chunk, chunk_dur))
                    tts_chars += len(chunk)
                    tts_audio_s += chunk_dur
                await producer
            finally:
                if not producer.done():
                    producer.cancel()

            if llm_res.ttft_ms is not None:
                await gate.emit(base.METRIC, name="llm_ttft_ms", value_ms=llm_res.ttft_ms, response_id=rid)
            if llm_res.total_ms is not None:
                await gate.emit(base.METRIC, name="llm_total_ms", value_ms=llm_res.total_ms, response_id=rid)
            await gate.emit(base.USAGE, kind="llm", prompt_tokens=llm_res.prompt_tokens, completion_tokens=llm_res.completion_tokens,
                            cached_tokens=llm_res.cached_tokens, model=self.llm.name)
            await gate.emit(base.USAGE, kind="tts", chars=tts_chars, audio_s=tts_audio_s, engine=self.tts.name)
            ended = END_MARKER in state["agent_text"]
            if ended and (proactive or not user_wants_to_end(text)):
                ended = False
                await gate.emit(base.METRIC, name="end_marker_ignored", value_ms=0, response_id=rid)
            await gate.emit(base.AGENT_TURN_DONE, response_id=rid, text=clean_for_speech(state["agent_text"]), interrupted=False,
                            proactive=proactive, usage={"prompt_tokens": llm_res.prompt_tokens, "completion_tokens": llm_res.completion_tokens})
            if ended:
                await gate.emit(base.END_REQUESTED, reason="user_ended", after_s=tts_audio_s)
            if gate.committed:
                await self._finalize_committed(state)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.emit(base.ERROR, message=f"modular pipeline: {e!r}"[:400], fatal=False)
