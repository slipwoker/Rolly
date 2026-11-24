"""Extended-session soak test (30-60 minutes of continuous conversation in one session).

A simulated user keeps talking with the agent for `--minutes`.  Reported: completed turns,
failed turns, whether the session survived, latency drift (first vs. last third), playout
underruns, growth of the LLM prompt (history) and a memory probe at the end (a fact stated
in the first minute).

    python -m benchmarks.long_session --provider modular-selfhosted --minutes 30
"""
from __future__ import annotations

import argparse
import asyncio
import json
import platform
import time
from pathlib import Path

from telemetry.recorder import summarize

from .client import SimClient
from .concurrency import LINES
from .synth import user_speech

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "benchmarks" / "results"


async def main_async(a) -> None:
    lang = a.lang
    c = SimClient(a.url, {"provider": a.provider, "user_id": "noa" if lang == "he" else "daniel", "language": lang, "tag": a.tag,
                          "ephemeral": True, "journey": {"duration_min": a.minutes}})
    out = {"benchmark": "long_session", "provider": a.provider, "hardware_note": a.hardware, "host": platform.platform(),
           "target_minutes": a.minutes, "language": lang, "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "turns": []}
    t0 = time.monotonic()
    await c.connect()
    opener = await c.wait_turn(c.t_connected - 1, a.timeout, proactive=True)
    if opener:
        await c.wait_turn_complete(opener, timeout=a.timeout)
    fact = {"en": "By the way, remember this for later: my locker code at the gym is seven four two nine.",
            "he": "דרך אגב, תזכרי בשבילי להמשך: הקוד של הלוקר שלי בחדר הכושר הוא שבע ארבע שתיים תשע."}[lang]
    probe = {"en": "One last thing. What is my locker code at the gym?", "he": "דבר אחרון. מה הקוד של הלוקר שלי בחדר הכושר?"}[lang]
    script = [fact] + LINES[lang]
    i = 0
    while time.monotonic() - t0 < a.minutes * 60 and not c.closed.is_set():
        text = script[i] if i < len(script) else LINES[lang][i % len(LINES[lang])]
        i += 1
        said = await c.say(await user_speech(text, lang))
        turn = await c.wait_turn(said["t_end"], a.timeout, proactive=False)
        rec = {"t_min": round((time.monotonic() - t0) / 60, 2), "said": text}
        if turn is None:
            rec["error"] = "no response"
        else:
            await c.wait_turn_complete(turn, timeout=a.timeout)
            rec.update({"latency_ms": round((turn.t_first_audio - said["t_end"]) * 1000), "underruns": turn.underruns,
                        "agent_chars": len(turn.text)})
        out["turns"].append(rec)
        await asyncio.sleep(1.0)
    survived = not c.closed.is_set()
    probe_ok = None
    if survived:
        said = await c.say(await user_speech(probe, lang))
        turn = await c.wait_turn(said["t_end"], a.timeout, proactive=False)
        if turn:
            await c.wait_turn_complete(turn, timeout=a.timeout)
            digits = turn.text.replace("-", " ").lower()
            probe_ok = all(k in digits for k in (("7", "4", "2", "9") if any(ch.isdigit() for ch in digits) else
                                                 (("seven", "four", "two", "nine") if lang == "en" else ("שבע", "ארבע", "שתיים", "תשע"))))
            out["memory_probe"] = {"reply": turn.text, "pass": probe_ok}
    await c.close(end=not c.closed.is_set(), wait_summary_s=300)
    lat = [t["latency_ms"] for t in out["turns"] if "latency_ms" in t]
    third = max(1, len(lat) // 3)
    out.update({
        "actual_minutes": round((time.monotonic() - t0) / 60, 2), "session_survived": survived,
        "turns_completed": len(lat), "turns_failed": sum(1 for t in out["turns"] if "error" in t),
        "response_latency_ms": summarize(lat), "latency_first_third_ms": summarize(lat[:third]), "latency_last_third_ms": summarize(lat[-third:]),
        "underruns": sum(t.get("underruns", 0) for t in out["turns"]), "errors": c.errors, "stats": c.stats,
        "summary_method": (c.summary or {}).get("method"), "client_late_mic_frames": c.late_frames,
    })
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"long_session_{a.provider}_{out['started'].replace(':', '').replace('-', '')}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ("actual_minutes", "session_survived", "turns_completed", "turns_failed", "response_latency_ms",
                                          "latency_first_third_ms", "latency_last_third_ms", "underruns", "errors")}, indent=1))
    print("memory probe:", out.get("memory_probe"), "| saved", path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8000/ws")
    ap.add_argument("--provider", required=True)
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--lang", default="en", choices=["en", "he"])
    ap.add_argument("--tag", default="bench-long")
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("--hardware", default="unspecified")
    asyncio.run(main_async(ap.parse_args()))
