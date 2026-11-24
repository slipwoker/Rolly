"""Host resource sampler (CPU, RAM, GPU) used during benchmarks and concurrency tests."""
from __future__ import annotations

import asyncio
import shutil
import subprocess
import time
from typing import Optional

import psutil


def gpu_snapshot() -> Optional[list[dict]]:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw",
             "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
        gpus = []
        for line in out.strip().splitlines():
            idx, name, util, mem_used, mem_total, power = [x.strip() for x in line.split(",")]
            gpus.append({"index": int(idx), "name": name, "util_pct": float(util), "mem_used_mb": float(mem_used),
                         "mem_total_mb": float(mem_total), "power_w": float(power) if power not in ("[N/A]", "") else None})
        return gpus
    except Exception:
        return None


_proc = psutil.Process()


def process_usage() -> dict:
    """CPU time and memory of this server process (used to derive CPU cost per session)."""
    t = _proc.cpu_times()
    return {"process_cpu_s": round(t.user + t.system, 3), "process_rss_mb": round(_proc.memory_info().rss / 1e6, 1),
            "process_threads": _proc.num_threads()}


def snapshot() -> dict:
    vm = psutil.virtual_memory()
    return {
        **process_usage(),
        "t": time.time(),
        "cpu_pct": psutil.cpu_percent(interval=None),
        "cpu_count": psutil.cpu_count(),
        "load1": psutil.getloadavg()[0],
        "ram_used_mb": round((vm.total - vm.available) / 1e6, 1),
        "ram_total_mb": round(vm.total / 1e6, 1),
        "gpu": gpu_snapshot(),
    }


class ResourceSampler:
    def __init__(self, interval_s: float = 2.0, keep: int = 1800):
        self.interval_s = interval_s
        self.keep = keep
        self.samples: list[dict] = []
        self._task: Optional[asyncio.Task] = None

    async def _loop(self) -> None:
        psutil.cpu_percent(interval=None)
        while True:
            await asyncio.sleep(self.interval_s)
            self.samples.append(snapshot())
            if len(self.samples) > self.keep:
                self.samples = self.samples[-self.keep:]

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    def window(self, since: float) -> dict:
        rows = [s for s in self.samples if s["t"] >= since]
        if not rows:
            return {"n": 0}
        out = {
            "n": len(rows),
            "cpu_pct_mean": round(sum(r["cpu_pct"] for r in rows) / len(rows), 1),
            "cpu_pct_max": max(r["cpu_pct"] for r in rows),
            "ram_used_mb_max": max(r["ram_used_mb"] for r in rows),
            "cpu_count": rows[-1]["cpu_count"],
        }
        g = [r["gpu"][0] for r in rows if r.get("gpu")]
        if g:
            out.update({
                "gpu_name": g[-1]["name"],
                "gpu_util_pct_mean": round(sum(x["util_pct"] for x in g) / len(g), 1),
                "gpu_util_pct_max": max(x["util_pct"] for x in g),
                "gpu_mem_used_mb_max": max(x["mem_used_mb"] for x in g),
                "gpu_mem_total_mb": g[-1]["mem_total_mb"],
            })
        return out
