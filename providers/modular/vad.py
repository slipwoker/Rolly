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
    bargein_min_speech_ms: float = 160  # stricter while the agent is audible (echo / road noise)
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
            if p >= cfg.start_threshold:
                self._speech_run += WINDOW_MS
                self._pending_start.append(w)
                need = cfg.bargein_min_speech_ms if agent_audible else cfg.min_speech_ms
                if self._speech_run >= need:
                    self._in_speech = True
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
        else:
            self._silence_run += WINDOW_MS
            if cfg.eager_silence_ms and not self._eager_fired and self._silence_run >= cfg.eager_silence_ms \
                    and cfg.eager_silence_ms < cfg.endpoint_silence_ms:
                self._eager_fired = True
                events.append(VadEvent("eager", self._last_speech_ms, self._utterance()))
            too_long = len(self._utt) * WINDOW_MS / 1000 >= cfg.max_utterance_s
            if self._silence_run >= cfg.endpoint_silence_ms or too_long:
                audio = self._utterance()
                self._in_speech = False
                self._speech_run = 0.0
                self._silence_run = 0.0
                self._eager_fired = False
                self._utt = []
                events.append(VadEvent("end", self._last_speech_ms, audio))

    def _utterance(self) -> np.ndarray:
        return np.concatenate(self._utt) if self._utt else np.zeros(0, dtype=np.float32)
