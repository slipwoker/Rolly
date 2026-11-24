"""Structured telemetry shared by all providers.

The recorder turns provider-agnostic events into the latency / interruption / usage
metrics reported in BENCHMARKS.md.  Because it sits in the session layer, every
architecture is measured by the same code.

Key definitions
---------------
response_latency_ms  : wall time between the TRUE end of user speech (the arrival time of
                       the last speech sample, taken from the provider's `audio_end_ms`)
                       and the moment the first agent audio chunk is handed to the socket.
                       Client-side playout buffering and network are added by the client
                       measurement (`client_latency_ms`) / the benchmark client.
endpoint_delay_ms    : how long the system waited after the true end of speech before it
                       declared the turn finished (VAD hangover / semantic endpointing).
interrupt_detect_ms  : wall time between the arrival of the first sample of the
                       interrupting speech and the interrupt being issued.
"""
from __future__ import annotations

import bisect
import json
import os
import statistics
import time
from pathlib import Path
from typing import Optional


def percentile(values: list[float], p: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p / 100.0
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def summarize(values: list[float]) -> dict:
    vals = [v for v in values if v is not None]
    if not vals:
        return {"n": 0}
    return {
        "n": len(vals), "median": round(statistics.median(vals), 1), "mean": round(statistics.fmean(vals), 1),
        "p90": round(percentile(vals, 90), 1), "p95": round(percentile(vals, 95), 1),
        "min": round(min(vals), 1), "max": round(max(vals), 1),
    }


class AudioClock:
    """Maps input-stream time (ms of audio received) to wall-clock arrival time."""

    def __init__(self) -> None:
        self._ms: list[float] = []
        self._t: list[float] = []
        self.total_ms = 0.0

    def add(self, n_samples: int, sample_rate: int = 16000) -> None:
        self.total_ms += n_samples * 1000.0 / sample_rate
        self._ms.append(self.total_ms)
        self._t.append(time.monotonic())

    def wall_at(self, audio_ms: float) -> Optional[float]:
        if not self._ms:
            return None
        i = bisect.bisect_left(self._ms, audio_ms)
        i = min(i, len(self._ms) - 1)
        return self._t[i]


class SessionRecorder:
    def __init__(self, session_id: str, store=None, jsonl_dir: str | os.PathLike | None = None, meta: dict | None = None):
        self.session_id = session_id
        self.store = store
        self.meta = meta or {}
        self.clock = AudioClock()
        self.t0 = time.monotonic()
        self._rows: list[tuple] = []
        self._jsonl = None
        if jsonl_dir:
            Path(jsonl_dir).mkdir(parents=True, exist_ok=True)
            self._jsonl = open(Path(jsonl_dir) / f"{session_id}.jsonl", "a", encoding="utf-8")
        # counters
        self.bytes_up = 0
        self.bytes_down = 0
        self.audio_in_s = 0.0
        self.audio_out_s = 0.0
        self.errors = 0
        self.usage: dict[str, dict] = {}
        # turn tracking
        self._speech_start_audio_ms: Optional[float] = None
        self._speech_end_wall: Optional[float] = None
        self._awaiting_first_audio = False
        self._first_audio_seen: set[str] = set()
        self.response_latencies: list[float] = []
        self.endpoint_delays: list[float] = []
        self.interrupt_detects: list[float] = []
        self.client_latencies: list[float] = []
        self.client_stop_ms: list[float] = []
        self.stage: dict[str, list[float]] = {}
        self.turns_user = 0
        self.turns_agent = 0
        self.interruptions = 0
        self.proactive_first_audio_ms: Optional[float] = None
        self.event("session.meta", **self.meta)

    # -- raw events --------------------------------------------------------------
    def event(self, type_: str, **data) -> None:
        now_w, now_m = time.time(), time.monotonic()
        payload = json.dumps(data, ensure_ascii=False, default=str)
        self._rows.append((self.session_id, now_w, now_m, type_, payload))
        if self._jsonl:
            self._jsonl.write(json.dumps({"session_id": self.session_id, "t_wall": round(now_w, 4),
                                          "t_rel_ms": round((now_m - self.t0) * 1000, 1), "type": type_, **data},
                                         ensure_ascii=False, default=str) + "\n")
        if len(self._rows) >= 200:
            self.flush()

    def flush(self) -> None:
        if self.store and self._rows:
            rows, self._rows = self._rows, []
            try:
                self.store.add_events(rows)
            except Exception:
                self.errors += 1
        if self._jsonl:
            self._jsonl.flush()

    # -- audio accounting --------------------------------------------------------
    def audio_in(self, n_bytes: int) -> None:
        self.bytes_up += n_bytes
        self.audio_in_s += n_bytes / 2 / 16000
        self.clock.add(n_bytes // 2)

    def audio_out(self, n_bytes: int, sample_rate: int) -> None:
        self.bytes_down += n_bytes
        self.audio_out_s += n_bytes / 2 / sample_rate

    # -- provider events ---------------------------------------------------------
    def on_speech_started(self, audio_ms: Optional[float]) -> None:
        self._speech_start_audio_ms = audio_ms
        self.event("user.speech_started", audio_ms=audio_ms)

    def on_speech_stopped(self, audio_end_ms: Optional[float]) -> None:
        now = time.monotonic()
        wall = self.clock.wall_at(audio_end_ms) if audio_end_ms is not None else None
        self._speech_end_wall = wall or now
        self._awaiting_first_audio = True
        delay = (now - self._speech_end_wall) * 1000
        self.endpoint_delays.append(delay)
        self.event("user.speech_stopped", audio_end_ms=audio_end_ms, endpoint_delay_ms=round(delay, 1))

    def on_agent_audio(self, response_id: str, proactive: bool = False) -> Optional[dict]:
        """Call for every audio chunk; returns a latency record on the first chunk of a response."""
        if response_id in self._first_audio_seen:
            return None
        self._first_audio_seen.add(response_id)
        now = time.monotonic()
        rec: dict = {"response_id": response_id}
        if proactive:
            self.proactive_first_audio_ms = (now - self.t0) * 1000
            rec["proactive_first_audio_ms"] = round(self.proactive_first_audio_ms, 1)
        elif self._awaiting_first_audio and self._speech_end_wall is not None:
            lat = (now - self._speech_end_wall) * 1000
            self.response_latencies.append(lat)
            self._awaiting_first_audio = False
            rec["response_latency_ms"] = round(lat, 1)
        self.event("agent.first_audio", **rec)
        return rec

    def on_interrupted(self, response_id: str, detect_audio_ms: Optional[float]) -> Optional[float]:
        self.interruptions += 1
        det = None
        start_ms = self._speech_start_audio_ms
        if start_ms is not None:
            wall = self.clock.wall_at(start_ms)
            if wall is not None:
                det = (time.monotonic() - wall) * 1000
                self.interrupt_detects.append(det)
        self.event("agent.interrupted", response_id=response_id, interrupt_detect_ms=round(det, 1) if det is not None else None)
        return det

    def on_metric(self, name: str, value_ms: float, response_id: str | None = None) -> None:
        self.stage.setdefault(name, []).append(float(value_ms))
        self.event("metric", name=name, value_ms=round(float(value_ms), 1), response_id=response_id)

    def on_usage(self, kind: str, **data) -> None:
        agg = self.usage.setdefault(kind, {})
        for k, v in data.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                agg[k] = agg.get(k, 0) + v
            elif v is not None and k not in agg:
                agg[k] = v
        self.event("usage", kind=kind, **data)

    def on_client(self, data: dict) -> None:
        if data.get("event") == "first_audio" and data.get("latency_ms") is not None:
            self.client_latencies.append(float(data["latency_ms"]))
        if data.get("event") == "flushed" and data.get("stop_ms") is not None:
            self.client_stop_ms.append(float(data["stop_ms"]))
        self.event("client.playback", **data)

    # -- summary -----------------------------------------------------------------
    def stats(self) -> dict:
        dur = time.monotonic() - self.t0
        return {
            "duration_s": round(dur, 2),
            "turns_user": self.turns_user,
            "turns_agent": self.turns_agent,
            "interruptions": self.interruptions,
            "errors": self.errors,
            "response_latency_ms": summarize(self.response_latencies),
            "endpoint_delay_ms": summarize(self.endpoint_delays),
            "interrupt_detect_ms": summarize(self.interrupt_detects),
            "client_latency_ms": summarize(self.client_latencies),
            "client_stop_ms": summarize(self.client_stop_ms),
            "proactive_first_audio_ms": round(self.proactive_first_audio_ms, 1) if self.proactive_first_audio_ms else None,
            "stages": {k: summarize(v) for k, v in self.stage.items()},
            "audio_in_s": round(self.audio_in_s, 2),
            "audio_out_s": round(self.audio_out_s, 2),
            "bytes_up": self.bytes_up,
            "bytes_down": self.bytes_down,
            "kbps_up_raw": round(self.bytes_up * 8 / 1000 / dur, 1) if dur > 0 else None,
            "kbps_down_raw": round(self.bytes_down * 8 / 1000 / dur, 1) if dur > 0 else None,
            "usage": self.usage,
        }

    def close(self) -> None:
        self.flush()
        if self._jsonl:
            self._jsonl.close()
            self._jsonl = None
