"""Concurrency ramp: N simultaneous real-time conversations against one server.

Each simulated user holds a real-time session (always-on microphone at 1x speed) and takes
`--turns` turns.  For every level the script reports response-latency percentiles, failed
turns/sessions, playout underruns and server CPU/GPU utilisation, and decides whether the
level is "sustainable" against the latency targets (median <= 800 ms and p95 <= 1500 ms by
default - override for CPU-only smoke runs).

    python -m benchmarks.concurrency --provider modular-selfhosted --levels 1 5 10 20 50 --admin-token ...

Results: benchmarks/results/concurrency_<provider>_<timestamp>.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import platform
import random
import time
import urllib.request
from pathlib import Path

from telemetry.recorder import summarize

from .client import SimClient
from .synth import user_speech

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "benchmarks" / "results"

LINES = {
    "en": ["Yes, let's continue with that topic.", "What do you think is the biggest risk here?",
           "Okay, and what would be a good first step this week?", "Can you summarise what we decided so far?",
           "I am not sure I agree. Give me the counter argument.", "How many interviews do I still have to schedule?"],
    "he": ["כן, בואי נמשיך עם הנושא הזה.", "מה לדעתך הסיכון הכי גדול כאן?", "אוקיי, ומה יהיה צעד ראשון טוב לשבוע הזה?",
           "תסכמי לי בבקשה מה החלטנו עד עכשיו.", "אני לא בטוחה שאני מסכימה. תני לי את הטיעון הנגדי.", "מה הייתה האפשרות השלישית שדיברנו עליה?"],
}


async def one_user(i: int, url: str, provider: str, lang: str, turns: int, tag: str, timeout: float, stagger: float,
                   options: dict | None = None) -> dict:
    await asyncio.sleep(stagger)
    rnd = random.Random(i)
    c = SimClient(url, {"provider": provider, "user_id": "noa" if lang == "he" else "daniel", "language": lang, "tag": tag,
                        "ephemeral": True, "skip_summary": True, "journey": {"duration_min": 25}, "options": options or {}})
    out = {"user": i, "lang": lang, "latencies": [], "failed_turns": 0, "underruns": 0, "error": None, "opener_ms": None}
    t_session = time.monotonic()
    try:
        await c.connect()
        opener = await c.wait_turn(c.t_connected - 1, timeout, proactive=True)
        if opener is None:
            out["error"] = "no opener"
        else:
            out["opener_ms"] = round((opener.t_first_audio - c.t_connected) * 1000)
            await c.wait_turn_complete(opener, timeout=timeout)
            out["underruns"] += opener.underruns
        for _ in range(turns):
            if c.closed.is_set():
                out["error"] = out["error"] or "session closed early"
                break
            await asyncio.sleep(rnd.uniform(0.3, 1.5))  # human-like pause before answering
            said = await c.say(await user_speech(rnd.choice(LINES[lang]), lang))
            turn = await c.wait_turn(said["t_end"], timeout, proactive=False)
            if turn is None:
                out["failed_turns"] += 1
                continue
            out["latencies"].append(round((turn.t_first_audio - said["t_end"]) * 1000))
            await c.wait_turn_complete(turn, timeout=timeout)
            out["underruns"] += turn.underruns
        out["errors"] = c.errors
        out["late_mic_frames"] = c.late_frames
        out["session_s"] = time.monotonic() - t_session
        await c.close(end=not c.closed.is_set(), wait_summary_s=30)
    except Exception as e:
        out["error"] = repr(e)[:200]
    return out


def resources(http: str, token: str) -> dict | None:
    if not token:
        return None
    try:
        return json.loads(urllib.request.urlopen(f"{http}/api/resources?token={token}", timeout=5).read())
    except Exception:
        return None


async def main_async(a) -> None:
    http = a.url.replace("ws://", "http://").replace("wss://", "https://").rsplit("/ws", 1)[0]
    for lang in set(a.langs):  # pre-synthesise so client-side TTS never competes with the test
        for line in LINES[lang]:
            await user_speech(line, lang)
    out = {"benchmark": "concurrency", "provider": a.provider, "hardware_note": a.hardware, "host": platform.platform(),
           "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "turns_per_user": a.turns, "session_options": json.loads(a.options) if a.options else {},
           "targets_ms": {"median": a.target_median, "p95": a.target_p95}, "levels": []}
    path = RESULTS / f"concurrency_{a.provider}_{out['started'].replace(':', '').replace('-', '')}.json"
    RESULTS.mkdir(parents=True, exist_ok=True)
    for n in a.levels:
        t0 = time.time()
        before = (resources(http, a.admin_token) or {}).get("now") or {}
        users = await asyncio.gather(*[
            one_user(i, a.url, a.provider, a.langs[i % len(a.langs)], a.turns, f"{a.tag}-c{n}", a.timeout, stagger=i * a.stagger,
                     options=json.loads(a.options) if a.options else None)
            for i in range(n)])
        res = resources(http, a.admin_token)
        after = (res or {}).get("now") or {}
        session_s = sum(u.get("session_s", 0.0) for u in users)
        proc_cpu = (after.get("process_cpu_s", 0) - before.get("process_cpu_s", 0)) if before and after else None
        lat = [x for u in users for x in u["latencies"]]
        s = summarize(lat)
        attempted = n * a.turns
        failed_turns = sum(u["failed_turns"] for u in users) + sum(a.turns - len(u["latencies"]) - u["failed_turns"] for u in users)
        level = {
            "concurrent_sessions": n, "wall_s": round(time.time() - t0, 1), "response_latency_ms": s,
            "turns_attempted": attempted, "turns_failed": failed_turns,
            "sessions_failed": sum(1 for u in users if u["error"]), "errors": sorted({u["error"] for u in users if u["error"]}),
            "underruns": sum(u["underruns"] for u in users), "opener_first_audio_ms": summarize([u["opener_ms"] for u in users if u["opener_ms"]]),
            "client_late_mic_frames": sum(u.get("late_mic_frames", 0) for u in users),
            "server_resources_last_60s": (res or {}).get("last_60s"),
            "session_seconds_total": round(session_s, 1), "server_process_cpu_s": round(proc_cpu, 2) if proc_cpu is not None else None,
            "server_cpu_s_per_session_s": round(proc_cpu / session_s, 5) if proc_cpu and session_s else None,
            "server_process_rss_mb": after.get("process_rss_mb"),
            "sustainable": bool(s.get("n")) and s["median"] <= a.target_median and s["p95"] <= a.target_p95 and failed_turns == 0,
        }
        out["levels"].append(level)
        print(f"N={n:3d} median={s.get('median')} p95={s.get('p95')} failed_turns={failed_turns}/{attempted} "
              f"sessions_failed={level['sessions_failed']} underruns={level['underruns']} sustainable={level['sustainable']}", flush=True)
        ok = [lv["concurrent_sessions"] for lv in out["levels"] if lv["sustainable"]]
        out["max_sustainable_concurrency"] = max(ok) if ok else 0
        path.write_text(json.dumps(out, indent=1), encoding="utf-8")
        if a.stop_on_fail and not level["sustainable"]:
            break
        await asyncio.sleep(a.cooldown)
    print("max sustainable:", out["max_sustainable_concurrency"], "| saved", path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8000/ws")
    ap.add_argument("--provider", required=True)
    ap.add_argument("--levels", type=int, nargs="+", default=[1, 5, 10, 20, 50])
    ap.add_argument("--turns", type=int, default=4)
    ap.add_argument("--langs", nargs="+", default=["he", "en"])
    ap.add_argument("--tag", default="bench-concurrency")
    ap.add_argument("--timeout", type=float, default=60)
    ap.add_argument("--stagger", type=float, default=0.25, help="seconds between session starts within a level")
    ap.add_argument("--cooldown", type=float, default=5)
    ap.add_argument("--target-median", type=float, default=800)
    ap.add_argument("--target-p95", type=float, default=1500)
    ap.add_argument("--stop-on-fail", action="store_true")
    ap.add_argument("--admin-token", default="")
    ap.add_argument("--hardware", default="unspecified")
    ap.add_argument("--options", default="", help="JSON session options passed to every session")
    asyncio.run(main_async(ap.parse_args()))
