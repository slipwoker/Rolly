"""Silero VAD (ONNX, MIT licence) + endpointing state machine.

Runs on 32 ms windows of 16 kHz audio.  The endpointer exposes three moments that matter
for conversational latency:
  * speech start          -> barge-in detection
  * "eager" point         -> short silence; we may speculatively start STT/LLM/TTS
  * endpoint (commit)     -> silence long enough to treat the user turn as finished
"""
from __future__ import annotations

import os
import threading
from collections import deque
from dataclasses import dataclass
from typing import Optional

import numpy as np
import onnxruntime as ort

WINDOW = 512  # samples @16 kHz = 32 ms
CONTEXT = 64
WINDOW_MS = WINDOW / 16.0

_session_lock = threading.Lock()
_sessions: dict[str, ort.InferenceSession] = {}


def _get_session(path: str) -> ort.InferenceSession:
    with _session_lock:
        if path not in _sessions:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            opts.log_severity_level = 3
            _sessions[path] = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        return _sessions[path]


class SileroVAD:
    """Stateful wrapper around the shared ONNX session (one instance per conversation)."""

    def __init__(self, model_path: str):
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Silero VAD model not found at {model_path}; run infrastructure/download_models.sh")
        self._sess = _get_session(model_path)
        self._sr = np.array(16000, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._ctx = np.zeros((1, CONTEXT), dtype=np.float32)

    def prob(self, window: np.ndarray) -> float:
        x = np.concatenate([self._ctx, window.reshape(1, -1)], axis=1).astype(np.float32)
        out, self._state = self._sess.run(None, {"input": x, "state": self._state, "sr": self._sr})
        self._ctx = x[:, -CONTEXT:]
        return float(out[0][0])


@dataclass
class VadConfig:
    start_threshold: float = 0.5
    end_threshold: float = 0.35
    min_speech_ms: float = 96  # consecutive speech needed to open a user turn
    # While the agent is audible the bar is higher: residual echo of the agent's own voice and other
    # people talking nearby otherwise cut it off (seen in the first hosted tests: 7 of 7 replies).
    bargein_min_speech_ms: float = 192
    bargein_start_threshold: float = 0.65
    # Loudness needed to interrupt: within `bargein_margin_db` of this user's own speech level once it is known,
    # and above `bargein_floor_db` before that (i.e. during the opening line).  0 margin disables the check.
    bargein_margin_db: float = 10.0
    bargein_floor_db: float = -38.0
    # The client is still playing for a moment after the server has sent the last audio (network and output
    # latency), so the end of the agent's sentence can come back through the microphone: keep the bar up this long.
    echo_tail_ms: float = 500.0
    # After an interruption that turned out to be false, the bar is raised again until the user is understood.
    strict_min_speech_ms: float = 480
    strict_start_threshold: float = 0.8
    eager_silence_ms: float = 256  # speculative processing point (0 disables)
    endpoint_silence_ms: float = 544  # commit point
    pre_roll_ms: float = 320
    max_utterance_s: float = 30.0

    @classmethod
    def from_dict(cls, d: dict | None) -> "VadConfig":
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class VadEvent:
    kind: str  # "start" | "eager" | "resume" | "end"
    audio_ms: float  # position in the input stream (ms) the event refers to
    audio: Optional[np.ndarray] = None  # utterance so far (float32) for eager/end
    info: Optional[dict] = None  # eager/end: level_db, max_prob, mean_prob, speech_ms of the utterance


class Endpointer:
    """Turns a stream of PCM16 frames into start / eager / resume / end events."""

    def __init__(self, vad: SileroVAD, cfg: VadConfig):
        self.vad = vad
        self.cfg = cfg
        self._buf = np.zeros(0, dtype=np.float32)
        self._pre = deque(maxlen=max(1, int(cfg.pre_roll_ms / WINDOW_MS)))
        self._utt: list[np.ndarray] = []
        self._in_speech = False
        self._speech_run = 0.0
        self._silence_run = 0.0
        self._eager_fired = False
        self._stream_ms = 0.0
        self._last_speech_ms = 0.0
        self._pending_start: list[np.ndarray] = []
        self.last_prob = 0.0
        self.strict = False  # set by the pipeline after a false interruption
        # Loudness (dBFS) a sound needs to interrupt the agent; None = no check.  Set by the pipeline from the
        # user's own level.  Echo of the agent and other people's voices pass the speech detector easily
        # (measured: probability 0.99 at -46 dBFS) but arrive much quieter than the person at the microphone.
        self.gate_db: Optional[float] = None
        self.suppressed_ms = 0.0  # speech-like sound that was too quiet to interrupt (since last read)
        self.suppressed_peak_db: Optional[float] = None
        self._probs: list[float] = []  # speech-window probabilities of the current utterance
        self._energy = 0.0  # sum of squares over its speech windows

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def feed(self, pcm16: bytes, agent_audible: bool = False) -> list[VadEvent]:
        events: list[VadEvent] = []
        x = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        self._buf = np.concatenate([self._buf, x]) if len(self._buf) else x
        while len(self._buf) >= WINDOW:
            w = self._buf[:WINDOW]
            self._buf = self._buf[WINDOW:]
            self._stream_ms += WINDOW_MS
            p = self.vad.prob(w)
            self.last_prob = p
            self._step(w, p, agent_audible, events)
        return events

    def _step(self, w: np.ndarray, p: float, agent_audible: bool, events: list[VadEvent]) -> None:
        cfg = self.cfg
        if not self._in_speech:
            if agent_audible and self.strict:
                thr, need = cfg.strict_start_threshold, cfg.strict_min_speech_ms
            elif agent_audible:
                thr, need = cfg.bargein_start_threshold, cfg.bargein_min_speech_ms
            else:
                thr, need = cfg.start_threshold, cfg.min_speech_ms
            if p >= thr:
                self._speech_run += WINDOW_MS
                self._pending_start.append(w)
                loud_enough = True
                if agent_audible and self.gate_db is not None and self._speech_run >= need:
                    recent = self._pending_start[-8:]  # the last 256 ms
                    lvl = 10 * float(np.log10(max(sum(float(np.dot(x, x)) for x in recent) / (len(recent) * WINDOW), 1e-12)))
                    if lvl < self.gate_db:
                        loud_enough = False
                        self.suppressed_ms += WINDOW_MS
                        self.suppressed_peak_db = lvl if self.suppressed_peak_db is None else max(self.suppressed_peak_db, lvl)
                        if len(self._pending_start) > 40:  # keep about a second; older audio becomes pre-roll
                            self._pre.append(self._pending_start.pop(0))
                if self._speech_run >= need and loud_enough:
                    self._in_speech = True
                    self._probs = [p]
                    self._energy = float(sum(np.dot(x, x) for x in self._pending_start))
                    self._energy_n = len(self._pending_start) * WINDOW
                    self._silence_run = 0.0
                    self._eager_fired = False
                    self._utt = list(self._pre) + self._pending_start
                    self._pending_start = []
                    self._pre.clear()
                    self._last_speech_ms = self._stream_ms
                    events.append(VadEvent("start", self._stream_ms - self._speech_run))
            else:
                if self._pending_start:
                    for pw in self._pending_start:
                        self._pre.append(pw)
                    self._pending_start = []
                self._speech_run = 0.0
                self._pre.append(w)
            return

        # in speech
        self._utt.append(w)
        if p >= cfg.end_threshold:
            if self._eager_fired:
                self._eager_fired = False
                events.append(VadEvent("resume", self._stream_ms))
            self._silence_run = 0.0
            self._last_speech_ms = self._stream_ms
            self._probs.append(p)
            self._energy += float(np.dot(w, w))
            self._energy_n += WINDOW
        else:
            self._silence_run += WINDOW_MS
            if cfg.eager_silence_ms and not self._eager_fired and self._silence_run >= cfg.eager_silence_ms \
                    and cfg.eager_silence_ms < cfg.endpoint_silence_ms:
                self._eager_fired = True
                events.append(VadEvent("eager", self._last_speech_ms, self._utterance(), self._info()))
            too_long = len(self._utt) * WINDOW_MS / 1000 >= cfg.max_utterance_s
            if self._silence_run >= cfg.endpoint_silence_ms or too_long:
                audio = self._utterance()
                self._in_speech = False
                self._speech_run = 0.0
                self._silence_run = 0.0
                self._eager_fired = False
                self._utt = []
                events.append(VadEvent("end", self._last_speech_ms, audio, self._info()))

    def _info(self) -> dict:
        """Loudness and detector confidence of the utterance, for telling the user from echo and background voices."""
        n = max(1, getattr(self, "_energy_n", 0))
        rms = (self._energy / n) ** 0.5
        return {"level_db": round(20 * float(np.log10(max(rms, 1e-6))), 1),
                "max_prob": round(max(self._probs), 3) if self._probs else None,
                "mean_prob": round(float(np.mean(self._probs)), 3) if self._probs else None,
                "speech_ms": round(len(self._probs) * WINDOW_MS)}

    def _utterance(self) -> np.ndarray:
        return np.concatenate(self._utt) if self._utt else np.zeros(0, dtype=np.float32)
