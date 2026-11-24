"""Endpointing and barge-in detection benchmark (hardware independent).

Runs the Silero VAD endpointer directly on audio streams, frame by frame, and reports:
  * onset detection delay   : true speech onset -> "start" event (this is the barge-in detection delay)
  * endpoint delay          : true end of speech -> eager point / committed end of turn
  * false starts per minute : noise only (with the stricter threshold used while the agent is audible)
  * missed utterances       : speech in noise that never triggers a start

Speech: FLEURS (real human recordings, CC BY 4.0).  Noise: synthetic road noise.
True onset/offset come from the energy envelope of the clean recording.

    python -m benchmarks.vad_bench --n 30
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from providers.modular.vad import Endpointer, SileroVAD, VadConfig
from telemetry.recorder import summarize

from .stt_wer import load_fleurs
from .synth import SR, gain_for_snr, road_noise

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "benchmarks" / "results"


def true_bounds(audio: np.ndarray) -> tuple[float, float]:
    """(onset_ms, offset_ms) of speech in a clean recording from its energy envelope."""
    frame = SR // 100
    n = len(audio) // frame
    e = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame) ** 2, axis=1))
    thr = max(e.max() * 0.05, 1e-4)
    idx = np.where(e > thr)[0]
    return float(idx[0] * 10), float((idx[-1] + 1) * 10)


def run_stream(audio: np.ndarray, cfg: VadConfig, model: str, agent_audible: bool) -> list:
    ep = Endpointer(SileroVAD(model), cfg)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    events = []
    step = 640  # 20 ms frames, like the client
    for i in range(0, len(pcm), step):
        for ev in ep.feed(pcm[i:i + step], agent_audible=agent_audible):
            events.append((ev.kind, ev.audio_ms, ep._stream_ms))  # (kind, position it refers to, stream time when emitted)
    return events


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--snr", nargs="+", default=["clean", "10", "5", "0"])
    ap.add_argument("--model", default=str(ROOT / "models/silero_vad.onnx"))
    a = ap.parse_args()
    cfg = VadConfig()
    noise = road_noise(120.0)
    items = load_fleurs("he", a.n // 2) + load_fleurs("en", a.n - a.n // 2)
    out = {"benchmark": "vad_endpointing", "vad": "silero-vad v5 onnx", "config": cfg.__dict__, "n_utterances": len(items),
           "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "conditions": [], "noise_only": []}
    lead, tail = 1.0, 1.5
    for snr in a.snr:
        onset, eager, end, missed, split = [], [], [], 0, 0
        for agent_audible in (False, True):
            for it in items:
                on_ms, off_ms = true_bounds(it["audio"])
                x = np.concatenate([np.zeros(int(lead * SR), np.float32), it["audio"], np.zeros(int(tail * SR), np.float32)])
                if snr != "clean":
                    g = gain_for_snr(it["audio"], float(snr))
                    x = x + noise[np.arange(len(x)) % len(noise)] * g
                ev = run_stream(x, cfg, a.model, agent_audible)
                starts = [e for e in ev if e[0] == "start"]
                ends = [e for e in ev if e[0] == "end"]
                if not starts:
                    missed += 1
                    continue
                if agent_audible:
                    onset.append(starts[0][2] - (lead * 1000 + on_ms))  # detection moment vs. true onset
                    continue
                if len(ends) > 1:
                    split += 1  # a mid-sentence pause was treated as end of turn
                if ends:
                    true_end = lead * 1000 + off_ms
                    end.append(ends[-1][2] - true_end)
                    eg = [e for e in ev if e[0] == "eager"]
                    if eg:
                        eager.append(eg[-1][2] - true_end)
        out["conditions"].append({
            "snr_db": snr, "barge_in_onset_detect_ms": summarize(onset), "eager_point_after_speech_end_ms": summarize(eager),
            "endpoint_after_speech_end_ms": summarize(end), "missed_utterances": missed, "utterances_split_by_pause": split,
            "n_per_mode": len(items)})
        c = out["conditions"][-1]
        print(f"snr={snr:>5} onset(barge-in) median={c['barge_in_onset_detect_ms'].get('median')} p95={c['barge_in_onset_detect_ms'].get('p95')} | "
              f"endpoint median={c['endpoint_after_speech_end_ms'].get('median')} p95={c['endpoint_after_speech_end_ms'].get('p95')} | "
              f"missed={missed} split={split}", flush=True)
    # false barge-ins on noise only: 2 minutes of road noise at several absolute levels (RMS re full scale)
    for rms_db in (-40, -30, -20, -12):
        g = 10 ** (rms_db / 20)
        ev = run_stream(noise * g, cfg, a.model, agent_audible=True)
        fs = sum(1 for e in ev if e[0] == "start")
        out["noise_only"].append({"noise_rms_dbfs": rms_db, "false_starts_per_min": round(fs / (len(noise) / SR / 60), 2)})
        print(f"noise only {rms_db} dBFS: false starts/min = {out['noise_only'][-1]['false_starts_per_min']}", flush=True)
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"vad_endpointing_{out['started'].replace(':', '').replace('-', '')}.json"
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("saved", path)


if __name__ == "__main__":
    main()
