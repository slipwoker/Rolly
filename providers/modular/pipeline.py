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
from .stt import discard_reason, get_stt
from .text import FOREIGN_LANGS, LOOKUP_MARKER, MarkerFilter, SentenceChunker, TurnNotes, clean_for_speech, echo_like, has_stop_word, question_guard_note, user_wants_to_end
from .pronounce import get_probe, usable_name
from .turnend import judge as judge_turn_end, mode_from as turn_end_mode, override_for as turn_end_override
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


# per-session sampling options the caller may set (`options.llm`), with the range each is clamped to
LLM_OPTION_BOUNDS = {"temperature": (0.0, 1.2), "top_p": (0.1, 1.0), "presence_penalty": (-1.0, 1.5),
                     "frequency_penalty": (-1.0, 1.5), "repetition_penalty": (1.0, 1.3)}


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
        # user/agent exchanges kept verbatim before the older half is compacted into a synopsis
        self.max_history_turns = int(config.get("max_history_turns") or 24)
        # after a reply that ended with a question, tell the model (for that turn only) to answer with a statement
        # smart end of turn (turnend.py): "off", "shadow" (verdicts measured, nothing changes) or "on"
        self.turn_end_mode = turn_end_mode(config.get("turn_end"))
        self._verdict_open: dict | None = None
        self.question_guard = str(config.get("question_guard", "true")).lower() not in ("0", "false", "no", "off")
        # notes from the caller for the next turns (pacing, memory hints): shown to the model, never stored in history
        self.notes = TurnNotes()
        self.history: list[dict] = []
        self._turn: Optional[asyncio.Task] = None
        self._gate: Optional[_Gate] = None
        self._turn_state: dict = {}
        self._closed = False
        self._compacting: Optional[asyncio.Task] = None
        # false-interruption handling (echo of the agent, background voices, noise)
        self._resume: Optional[dict] = None  # what was left unsaid when the agent was last cut off
        self._utt: dict = {}  # context of the user utterance in progress (did it cut the agent off, and what was being said)
        self.max_resumes = int(config.get("max_resumes", 2))
        self.unclear_max_s = float(config.get("unclear_interjection_max_s", 1.5))
        self.unclear_logprob = float(config.get("unclear_interjection_logprob", -0.5))
        # Optional: ignore voices much quieter than this user's own (other people in the room or car).
        # Off by default until the margin is set from recorded levels; every utterance's level is logged.
        self.level_gate_db = float(config.get("level_gate_db") or 0)
        self._ref_level: Optional[float] = None
        self._echo_level: Optional[float] = None  # loudest sound so far that turned out to be the agent's own voice
        self._last_audible_t = 0.0  # last moment the agent was audible (server-side estimate)
        self._last_reply_text = ""

    def describe(self) -> dict:
        return {
            "provider_id": self.provider_id, "architecture": self.architecture,
            "stt": self.stt.name, "llm": self.llm.name, "tts": self.tts.name,
            "vad": {"engine": "silero", **self.vad_cfg.__dict__},
        }

    # -- lifecycle ---------------------------------------------------------------
    async def _start(self) -> None:
        opts = self.ctx.options or {}
        if "level_gate_db" in opts:
            self.level_gate_db = float(opts["level_gate_db"] or 0)
        for k in ("endpoint_silence_ms", "eager_silence_ms", "bargein_min_speech_ms", "bargein_start_threshold", "bargein_margin_db",
                  "bargein_floor_db"):
            if k in opts:
                setattr(self.vad_cfg, k, float(opts[k]))
        if "turn_end" in opts:
            self.turn_end_mode = turn_end_mode(opts["turn_end"])
        # Sampling for this conversation, chosen by the caller (it measures them against bot-like phrasing): a short
        # whitelist with bounded values, applied to this session's requests only.
        llm_opts = opts.get("llm") if isinstance(opts.get("llm"), dict) else {}
        self._llm_extra = {}
        for k, (lo, hi) in LLM_OPTION_BOUNDS.items():
            if k in llm_opts:
                try:
                    self._llm_extra[k] = min(hi, max(lo, float(llm_opts[k])))
                except (TypeError, ValueError):
                    pass
        # the language the user is practising, if the caller knows it: unclear foreign phrases are pronounced in it
        speech = opts.get("speech") if isinstance(opts.get("speech"), dict) else {}
        self._foreign = speech.get("foreign_language") if speech.get("foreign_language") in FOREIGN_LANGS else None
        await self._load_pronunciations()
        self.endpointer = Endpointer(SileroVAD(self.config.get("vad_model", "models/silero_vad.onnx")), self.vad_cfg)
        if self.ctx.proactive and self.ctx.opener_instruction:
            gate = _Gate(self, committed=True)
            self._gate = gate
            self._turn = asyncio.create_task(self._run_turn(gate, text=self.ctx.opener_instruction, proactive=True))

    async def _turn_end_verdict(self, text: str, utt: dict) -> None:
        """Has the user finished?  Read from the speculative transcript, while the utterance waits in its pause (turnend.py)."""
        verdict = judge_turn_end(text, utt.get("speech_ms"))
        override = turn_end_override(verdict, self.turn_end_mode)
        applied = override is not None and self.endpointer.set_endpoint_override(override)
        self._verdict_open = {"verdict": verdict, "applied": bool(applied)}
        await self.emit(base.METRIC, name=f"turn_end_{verdict}" + ("_applied" if applied else ""), value_ms=float(self.endpointer.silence_ms))

    async def _turn_end_outcome(self, kind: str) -> None:
        """What followed the verdict: the user spoke again ("resumed": a pause was not an end) or the turn ended ("ended")."""
        v, self._verdict_open = self._verdict_open, None
        if v:
            await self.emit(base.METRIC, name=f"turn_end_{kind}_{v['verdict']}", value_ms=1.0)

    async def _load_pronunciations(self) -> None:
        """How the Hebrew voice says the user's name in this conversation (pronounce.py).  The user's own correction, kept by
        the caller, wins; otherwise a name whose reading depends on its place in the sentence is pinned to the reading in the
        middle of one.  Before the opener: the greeting is where the name is said first."""
        prof = self.ctx.profile if isinstance(self.ctx.profile, dict) else {}
        word = usable_name(prof.get("name"))
        chosen = prof.get("name_pron") if isinstance(prof.get("name_pron"), dict) else None
        pins: dict[str, str] = {}
        if word and chosen and chosen.get("ipa") and usable_name(chosen.get("name")) == word:
            pins = {word: str(chosen["ipa"])}
        elif word and self.ctx.language in ("he", "auto"):
            probe = get_probe(self.config.get("pronounce_url"), self.config.get("pronounce_cache"))
            if probe.enabled:
                pins = await probe.pins(word, 3.0)
        self.tts.set_pronunciations(pins)
        if pins:
            print(f"[pron] {self.ctx.session_id[:8]}: {pins}", flush=True)
            if getattr(self, "_emit", None):  # shows in the session's metrics (stats.pod_metrics_count.name_pinned)
                await self.emit(base.METRIC, name="name_pinned", value_ms=float(len(pins)))

    async def set_pronunciations(self, words: dict) -> None:
        """The caller changed how a name is said (the user corrected it): from the next piece of speech on."""
        self.tts.set_pronunciations(words if isinstance(words, dict) else {})

    async def close(self) -> None:
        self._closed = True
        await self._cancel_turn(emit_interrupt=False)
        if self._compacting and not self._compacting.done():
            self._compacting.cancel()

    # -- audio in ----------------------------------------------------------------
    def _agent_audible(self) -> bool:
        active = self._turn is not None and not self._turn.done() and self._gate is not None and self._gate.committed
        return active or self.client_is_playing()

    def _bargein_gate(self) -> Optional[float]:
        """Loudness a sound needs right now to interrupt the agent (dBFS), or None for no check."""
        cfg = self.vad_cfg
        if not cfg.bargein_margin_db:
            return None
        strict = self.endpointer.strict  # after a false interruption: half the margin
        if self._ref_level is None:
            gate = cfg.bargein_floor_db + (6.0 if strict else 0.0)
        else:
            gate = max(cfg.bargein_floor_db, self._ref_level - cfg.bargein_margin_db / (2.0 if strict else 1.0))
        if self._echo_level is not None:  # louder than what the loudspeaker is known to put into this microphone
            gate = max(gate, self._echo_level + 4.0)
        if self._ref_level is not None:  # but never so high that the user cannot get through
            gate = min(gate, self._ref_level - 2.0)
        return gate

    async def push_audio(self, pcm16: bytes) -> None:
        if self._closed:
            return
        audible = self._agent_audible()
        now = time.monotonic()
        if audible:
            self._last_audible_t = now
        # the bar stays up for a moment after the last audio was sent: the client is still playing it
        guarded = audible or (now - self._last_audible_t) * 1000 < self.vad_cfg.echo_tail_ms
        self.endpointer.gate_db = self._bargein_gate() if guarded else None
        for ev in self.endpointer.feed(pcm16, agent_audible=guarded):
            if ev.kind == "start":
                self._verdict_open = None
                await self.emit(base.USER_SPEECH_STARTED, audio_ms=ev.audio_ms)
                if self._agent_audible():
                    st = self._turn_state or {}
                    first = st.get("first_audio_t")
                    self._utt = {"barge_in": True, "near_agent": True,
                                 "agent_text": clean_for_speech(st.get("full_reply") or st.get("agent_text", "")),
                                 "ms_into_reply": round((time.monotonic() - first) * 1000) if first else None}
                    await self._cancel_turn(emit_interrupt=True, detect_audio_ms=self.endpointer._stream_ms)
                else:
                    # just after the agent stopped, what the microphone hears may still be the end of its sentence
                    near = (time.monotonic() - self._last_audible_t) < 1.5 and bool(self._last_reply_text)
                    self._utt = {"barge_in": False, "near_agent": near, "agent_text": self._last_reply_text if near else ""}
                    if self._turn and not self._turn.done():
                        await self._cancel_turn(emit_interrupt=False)
            elif ev.kind == "eager":
                gate = _Gate(self, committed=False)
                self._gate = gate
                self._turn = asyncio.create_task(self._run_turn(gate, audio=ev.audio, speculative=True, utt={**self._utt, **(ev.info or {})}))
            elif ev.kind == "resume":
                await self._turn_end_outcome("resumed")
                if self._gate is not None and not self._gate.committed:
                    await self._cancel_turn(emit_interrupt=False)
            elif ev.kind == "end":
                await self._turn_end_outcome("ended")
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
                    self._turn = asyncio.create_task(self._run_turn(gate, audio=ev.audio, utt={**self._utt, **(ev.info or {})}))

    async def send_text(self, text: str) -> None:
        await self._cancel_turn(emit_interrupt=self._agent_audible())
        gate = _Gate(self, committed=True)
        self._gate = gate
        self._turn = asyncio.create_task(self._run_turn(gate, text=text, typed=True))

    async def interrupt(self) -> None:
        await self._cancel_turn(emit_interrupt=True)

    async def set_note(self, text: str, turns: int = 1, max_user_words: int | None = None, min_streak: int = 1) -> None:
        self.notes.add(text, turns, max_user_words, min_streak)

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
        if emit_interrupt and was_committed and rid:
            rest = self._unsaid_chunks(state)
            count = int(state.get("resume_count", 0))
            self._resume = ({"chunks": rest, "full": clean_for_speech(state.get("full_reply") or state.get("agent_text", "")),
                             "count": count, "t": time.monotonic()} if rest and count < self.max_resumes else None)
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

    def _unsaid_chunks(self, state: dict) -> list[str]:
        """Chunks of the reply that had not finished playing when it was cut off (the cut one is said again)."""
        first = state.get("first_audio_t")
        every = list(state.get("all_chunks") or [])
        if first is None:
            return every
        gate = state.get("gate")
        first = max(first, (gate.commit_time or first) if gate else first)
        played, acc, done = time.monotonic() - first, 0.0, 0
        for _text, dur in state.get("chunks", []):
            acc += dur
            if acc <= played:
                done += 1
        return every[done:]

    def _restore_assistant(self, full_text: str) -> None:
        """The reply was said in full after all: undo the truncation recorded at the false interruption."""
        if not full_text:
            return
        if self.history and self.history[-1]["role"] == "assistant" and self.history[-1]["content"].endswith(" —"):
            self.history[-1]["content"] = full_text
        elif not self.history or self.history[-1]["role"] != "assistant":
            self.history.append({"role": "assistant", "content": full_text})

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
        if state.get("is_resume"):  # a reply being said again after a false interruption: no new user message
            if not interrupted:
                self._restore_assistant(state.get("full_reply", ""))
                self._resume = None
            return
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
                self.notes.consume(user_text)  # a full reply was given with the caller's notes in view (a cut-off one does not count)
        if len(self.history) > self.max_history_turns * 2 and (self._compacting is None or self._compacting.done()):
            self._compacting = asyncio.create_task(self._compact_history())

    async def _compact_history(self) -> None:
        """Replace the older half of the conversation by a short synopsis, in one block.

        A sliding window that drops one old message per turn changes the prompt prefix on every
        turn, which defeats LLM prefix caching (measured in the 30-minute run: cached tokens fell
        from ~3,200 to 734 and time-to-first-token rose from ~2 s to ~50 s on CPU) and silently
        forgets early facts.  Compacting in blocks invalidates the cache once per block, and the
        synopsis keeps what was said."""
        cut = len(self.history) // 2
        while cut < len(self.history) and self.history[cut]["role"] != "user":
            cut += 1
        old = self.history[:cut]
        if not old:
            return
        t0 = time.monotonic()
        # An earlier synopsis is carried over verbatim and only the new turns are summarised:
        # re-summarising a summary repeatedly loses details (observed with the 4B model).
        prefix = "[Earlier in this conversation - summary] "
        previous, fresh = "", old
        if old[0]["content"].startswith(prefix):
            previous, fresh = old[0]["content"][len(prefix):], old[2:]
        text = "\n".join(f"{'USER' if m['role'] == 'user' else 'AGENT'}: {m['content']}" for m in fresh if not m["content"].startswith("[journey_start"))
        synopsis = None
        try:
            res = await self.llm.complete([{"role": "user", "content":
                "Summarise the following part of a spoken conversation in at most 120 words. Keep every concrete fact, number, name, "
                "decision and commitment the USER stated, word for word where possible. Write plain sentences.\n\n" + text}],
                max_tokens=220, temperature=0.1)
            synopsis = res.text.strip() or None
        except Exception:
            synopsis = None
        if self.history[:cut] != old:  # the conversation moved on in an unexpected way: try again later
            return
        combined = " ".join(x for x in (previous, synopsis or "") if x).strip()
        head = [{"role": "user", "content": prefix + (combined or "(earlier turns were dropped)")},
                {"role": "assistant", "content": "Understood, I remember that."}]
        self.history = head + self.history[cut:]
        await self.emit(base.METRIC, name="history_compaction_ms", value_ms=(time.monotonic() - t0) * 1000)

    async def _report_suppressed(self, gate: _Gate, rid: str) -> None:
        """Telemetry: speech-like sound that was too quiet to interrupt the agent (for tuning the loudness check)."""
        ep = self.endpointer
        if ep.suppressed_ms:
            await gate.emit(base.METRIC, name="bargein_suppressed_ms", value_ms=ep.suppressed_ms, response_id=rid)
            await gate.emit(base.METRIC, name="bargein_suppressed_peak_db", value_ms=ep.suppressed_peak_db or 0.0, response_id=rid)
            ep.suppressed_ms, ep.suppressed_peak_db = 0.0, None

    async def _say_again(self, gate: _Gate, rid: str, state: dict, resume: dict) -> None:
        """Speak the rest of a reply that was cut off by something that was not the user (no language model call)."""
        chunks = [c for c in resume["chunks"] if c.strip()]
        state.update({"is_resume": True, "resume_count": resume["count"] + 1, "full_reply": resume["full"],
                      "agent_text": " ".join(chunks), "all_chunks": list(chunks)})
        self.endpointer.strict = True  # the next interruption needs clearer evidence
        t_start = time.monotonic()
        await gate.emit(base.AGENT_TURN_STARTED, response_id=rid, proactive=False, resumed=True)
        await gate.emit(base.AGENT_TEXT, response_id=rid, delta=clean_for_speech(state["agent_text"]))
        lang_hint = self.ctx.language if self.ctx.language in ("he", "en") else None
        chars, audio_s, first = 0, 0.0, True
        for chunk in chunks:
            dur = 0.0
            async for pcm, sr, _lang, _engine in self.tts.synth(chunk, lang_hint, getattr(self, "_foreign", None)):
                if first:
                    first = False
                    await gate.emit(base.METRIC, name="resume_ttfa_ms", value_ms=(time.monotonic() - t_start) * 1000, response_id=rid)
                    state["first_audio_t"] = time.monotonic()
                dur += len(pcm) / 2 / sr
                await gate.emit(base.AGENT_AUDIO, audio=pcm, sample_rate=sr, response_id=rid)
            state["chunks"].append((chunk, dur))
            chars += len(chunk)
            audio_s += dur
        await gate.emit(base.USAGE, kind="tts", chars=chars, audio_s=audio_s, engine=self.tts.name)
        self._last_reply_text = resume["full"]
        await self._report_suppressed(gate, rid)
        await gate.emit(base.AGENT_TURN_DONE, response_id=rid, text=clean_for_speech(state["agent_text"]), interrupted=False,
                        proactive=False, resumed=True, usage={})
        if gate.committed:
            await self._finalize_committed(state)

    def _messages(self, user_text: str) -> list[dict]:
        msgs = [{"role": "system", "content": self.ctx.system_prompt}] + [dict(m) for m in self.history]
        if msgs[-1]["role"] == "user":
            msgs[-1]["content"] += "\n" + user_text
        else:
            msgs.append({"role": "user", "content": user_text})
        # copies only: the note goes to the model for this turn and is never stored in self.history
        note = question_guard_note(self.history) if self.question_guard else None
        if note:
            msgs[-1]["content"] += "\n\n" + note
        caller_notes = self.notes.text(user_text)
        if caller_notes:
            msgs[-1]["content"] += "\n\n" + caller_notes
        return msgs

    async def _run_turn(self, gate: _Gate, audio: np.ndarray | None = None, text: str | None = None,
                        proactive: bool = False, speculative: bool = False, typed: bool = False, utt: dict | None = None) -> None:
        rid = uuid.uuid4().hex[:8]
        utt = utt or {}
        state: dict = {"rid": rid, "chunks": [], "all_chunks": [], "agent_text": "", "finalized": False, "gate": gate}
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
                if res.detect_ms:
                    await gate.emit(base.METRIC, name="stt_language_detect_ms", value_ms=res.detect_ms, response_id=rid)
                await gate.emit(base.USAGE, kind="stt", audio_s=res.audio_s, engine=self.stt.name)
                why = discard_reason(text, res.audio_s, res.no_speech_prob)
                if not why and text and utt.get("near_agent") and not has_stop_word(text):
                    # Sound that started while the agent was speaking, or right after.  Was it really the user?
                    if echo_like(text, utt.get("agent_text", "")):
                        why = "echo_of_agent"  # the microphone picked up the loudspeaker
                        if utt.get("level_db") is not None:
                            self._echo_level = max(self._echo_level if self._echo_level is not None else -99.0, float(utt["level_db"]))
                    elif utt.get("barge_in") and res.audio_s < self.unclear_max_s and res.avg_logprob is not None \
                            and res.avg_logprob < self.unclear_logprob:
                        why = "unclear_interjection"  # short and poorly recognised: a cough, a far voice, residual echo
                lvl = utt.get("level_db")
                if not why and text and self.level_gate_db and self._ref_level is not None and lvl is not None \
                        and lvl < self._ref_level - self.level_gate_db and not has_stop_word(text):
                    why = "background_voice"
                rejected = text if why else None
                if why:  # treat as "nothing was said"
                    await gate.emit(base.METRIC, name=f"stt_discarded_{why}", value_ms=res.audio_s * 1000, response_id=rid)
                    text = ""
                await gate.emit(base.USER_TRANSCRIPT, text=text, final=True, language=res.language,
                                avg_logprob=res.avg_logprob, no_speech_prob=res.no_speech_prob,
                                barge_in=bool(utt.get("barge_in")), near_agent=bool(utt.get("near_agent")),
                                ms_into_reply=utt.get("ms_into_reply"), level_db=utt.get("level_db"),
                                max_prob=utt.get("max_prob"), mean_prob=utt.get("mean_prob"), speech_ms=utt.get("speech_ms"),
                                ref_level_db=round(self._ref_level, 1) if self._ref_level is not None else None,
                                discarded=why, rejected_text=rejected)
                if text and speculative and self.turn_end_mode != "off":
                    await self._turn_end_verdict(text, utt)
                if not text:
                    resume = self._resume
                    if resume and utt.get("barge_in") and time.monotonic() - resume["t"] < 20:
                        # the interruption was false: carry on with what was being said instead of leaving silence
                        await self._say_again(gate, rid, state, resume)
                    else:
                        state["finalized"] = True
                    return
                self._resume = None
                self.endpointer.strict = False  # the user was understood: normal sensitivity again
                if lvl is not None and (utt.get("speech_ms") or 0) >= 600:
                    self._ref_level = lvl if self._ref_level is None else 0.7 * self._ref_level + 0.3 * lvl
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
                chunker = SentenceChunker(merge_chars=int(self.config.get("tts_merge_chars") or 0))
                shown = MarkerFilter()  # the end and lookup markers never reach the text shown on the phone
                first_chunk = True
                try:
                    async for delta in self.llm.stream(messages, llm_res, **getattr(self, "_llm_extra", {})):
                        state["agent_text"] += delta
                        # "checking": reported as soon as the marker has been written, not at the end of the reply.  A user who
                        # speaks right after "אני בודק" cancels the reply, and a request reported only at its end was lost
                        # (2026-11-26: three of seven requests, then Rolly "reported" a search that never ran).
                        if (not state.get("lookup_sent") and LOOKUP_MARKER in state["agent_text"] and END_MARKER not in state["agent_text"]
                                and not (typed and (text or "").startswith("[lookup"))):
                            state["lookup_sent"] = True
                            await gate.emit(base.LOOKUP_REQUESTED, response_id=rid)
                        visible = shown.feed(delta)
                        if visible:
                            await gate.emit(base.AGENT_TEXT, response_id=rid, delta=visible)
                        for c in chunker.feed(delta):
                            if first_chunk:
                                first_chunk = False
                                await gate.emit(base.METRIC, name="llm_first_chunk_ms",
                                                value_ms=(time.monotonic() - t_llm) * 1000, response_id=rid)
                            state["all_chunks"].append(c)
                            await chunk_q.put(c)
                    rest = shown.flush()
                    if rest:
                        await gate.emit(base.AGENT_TEXT, response_id=rid, delta=rest)
                    for c in chunker.flush():
                        state["all_chunks"].append(c)
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
                    async for pcm, sr, lang, _engine in self.tts.synth(chunk, lang_hint, getattr(self, "_foreign", None)):
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
            self._last_reply_text = clean_for_speech(state["agent_text"])
            await self._report_suppressed(gate, rid)
            await gate.emit(base.AGENT_TURN_DONE, response_id=rid, text=clean_for_speech(state["agent_text"]), interrupted=False,
                            proactive=proactive, usage={"prompt_tokens": llm_res.prompt_tokens, "completion_tokens": llm_res.completion_tokens})
            if ended:
                await gate.emit(base.END_REQUESTED, reason="user_ended", after_s=tts_audio_s)
            # "checking": the caller looks it up and sends the answer back as a marked message.  A reply to such a
            # message cannot ask for another lookup (no loops).
            elif LOOKUP_MARKER in state["agent_text"] and not state.get("lookup_sent") and not (typed and (text or "").startswith("[lookup")):
                await gate.emit(base.LOOKUP_REQUESTED, response_id=rid)
            if gate.committed:
                await self._finalize_committed(state)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.emit(base.ERROR, message=f"modular pipeline: {e!r}"[:400], fatal=False)
