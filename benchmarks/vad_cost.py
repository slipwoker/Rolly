"""CPU cost of the per-session audio front-end (Silero VAD + endpointing): CPU-seconds per second of audio.

    python -m benchmarks.vad_cost
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from providers.modular.vad import Endpointer, SileroVAD, VadConfig

from .synth import road_noise

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    audio = road_noise(60.0) * 0.05
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    ep = Endpointer(SileroVAD(str(ROOT / "models/silero_vad.onnx")), VadConfig())
    t_cpu, t_wall = time.process_time(), time.perf_counter()
    for i in range(0, len(pcm), 640):
        ep.feed(pcm[i:i + 640])
    cpu, wall = time.process_time() - t_cpu, time.perf_counter() - t_wall
    out = {"benchmark": "vad_cost", "audio_s": 60.0, "cpu_s": round(cpu, 3), "wall_s": round(wall, 3),
           "cpu_s_per_audio_s": round(cpu / 60.0, 5), "sessions_per_core_at_100pct": round(60.0 / cpu, 1),
           "note": "single thread; measured while other benchmarks may be running - CPU time, not wall time, is the reliable figure"}
    path = ROOT / "benchmarks/results" / f"vad_cost_{time.strftime('%Y%m%dT%H%M%S')}.json"
    path.write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
