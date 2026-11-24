"""Scripted conversation benchmark.

Drives every scenario in benchmarks/scenarios/scenarios.json against one provider through
the real WebSocket endpoint with a simulated real-time microphone, and records per turn:

  * response latency (client clock: last speech sample sent -> first agent audio byte received)
  * the provider's transcript vs. what was said (word error rate)
  * interruption: user speech onset -> interrupt signalled (client clock)
  * playout stability (buffer underruns, i.e. audible gaps inside an agent turn)
  * scripted checks (context retention, correction handling, topic switch, proactive opener, summary)

    python -m benchmarks.run_scenarios --provider modular-selfhosted --tag bench-cpu

Results: benchmarks/results/scenarios_<provider>_<timestamp>.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import platform
import time
from pathlib import Path

import jiwer

from telemetry.recorder import summarize

from .client import SimClient
from .stt_wer import normalize
from .synth import gain_for_snr, road_noise, user_speech

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "benchmarks" / "results"


def _has_any(text: str, keys: list[str]) -> bool:
    low = (text or "").lower()
    return any(k.lower() in low for k in keys)


async def run_scenario(url: str, provider: str, sc: dict, tag: str, turn_timeout: float, opener_timeout: float,
                       options: dict | None = None) -> dict:
    lang = sc.get("language", "en")
    speech_lang = lambda text: "he" if any("֐" <= c <= "׿" for c in text) else "en"  # noqa: E731
    noise, gain = None, 0.0
    if sc.get("snr_db") is not None:
        noise = road_noise(30.0)
        ref = await user_speech(next(s["say"] for s in sc["steps"] if "say" in s), speech_lang(next(s["say"] for s in sc["steps"] if "say" in s)))
        gain = gain_for_snr(ref, float(sc["snr_db"]))
    c = SimClient(url, {"provider": provider, "user_id": sc["user"], "language": lang, "tag": tag, "ephemeral": True,
                        "journey": {"duration_min": 25}, "options": options or {}}, noise=noise, noise_gain=gain)
    res: dict = {"id": sc["id"], "title": sc["title"], "language": lang, "snr_db": sc.get("snr_db"), "turns": [], "checks": [],
                 "interruptions": [], "error": None}
    t_begin = time.monotonic()
    try:
        await c.connect()
        opener = await c.wait_turn(c.t_connected - 1, opener_timeout, proactive=True)
        if opener is None:
            res["error"] = "no proactive opener"
            res["checks"].append({"check": "proactive_opener_spoken", "pass": False})
        else:
            await c.wait_turn_complete(opener, timeout=opener_timeout)
            res["opener"] = {"first_audio_ms": round((opener.t_first_audio - c.t_connected) * 1000), "text": opener.text,
                             "audio_s": round(opener.audio_s, 2), "underruns": opener.underruns, "gap_ms": round(opener.gap_ms)}
            res["checks"].append({"check": "proactive_opener_spoken", "pass": True})
        last = opener
        for step in sc["steps"]:
            if c.closed.is_set() and "expect" not in step and "expect_summary" not in step and "expect_end" not in step:
                break
            if "expect_opener" in step:
                res["checks"].append({"check": "opener_references_memory", "pass": bool(opener and _has_any(opener.text, step["expect_opener"])),
                                      "text": opener.text if opener else None})
            elif "expect" in step:
                res["checks"].append({"check": "reply_contains_expected", "expected_any": step["expect"],
                                      "pass": bool(last and _has_any(last.text, step["expect"])), "text": last.text if last else None})
            elif "expect_end" in step:
                await c.wait_for(lambda: c.closed.is_set(), 90)
                res["checks"].append({"check": "session_ended_naturally", "pass": c.closed.is_set() and bool(c.stats)
                                      and c.stats.get("end_reason") == "user_ended"})
            elif "barge_in" in step:
                # ask something that produces a long reply, then cut in `after_s` into its audio
                text = step["barge_in"]
                audio = await user_speech(text, speech_lang(text))
                target = last
                if target is None or target.t_first_audio is None:
                    continue
                wait = target.t_first_audio + step.get("after_s", 1.5) - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                still_playing = target.playback_end is not None and time.monotonic() < target.playback_end
                task = asyncio.create_task(c.say(audio))
                await c.wait_for(lambda: target.t_interrupted is not None, 5)
                said = await task
                rec = {"agent_was_audible": still_playing, "interrupted": target.t_interrupted is not None}
                if target.t_interrupted is not None:
                    rec["onset_to_interrupt_ms"] = round((target.t_interrupted - said["t_start"]) * 1000)
                    rec["audio_after_interrupt_ms"] = round(max(0.0, (target.t_last_audio - target.t_interrupted)) * 1000)
                    srv = [e for e in c.events if e.get("type") == "agent.interrupted" and e.get("seq") == target.seq]
                    rec["server_interrupt_detect_ms"] = srv[0].get("interrupt_detect_ms") if srv else None
                res["interruptions"].append(rec)
                nxt = await c.wait_turn(said["t_end"], turn_timeout, proactive=False)
                if nxt:
                    await c.wait_turn_complete(nxt, timeout=turn_timeout)
                    last = nxt
            elif "say" in step:
                text = step["say"]
                audio = await user_speech(text, speech_lang(text))
                # for the interruption scenario the next step cuts into this reply, so do not wait for playback
                idx = sc["steps"].index(step)
                next_is_barge = idx + 1 < len(sc["steps"]) and "barge_in" in sc["steps"][idx + 1]
                said = await c.say(audio)
                turn = await c.wait_turn(said["t_end"], turn_timeout, proactive=False)
                rec = {"said": text, "speech_s": round(len(audio) / 16000, 2)}
                if turn is None:
                    rec["error"] = "no response"
                    res["turns"].append(rec)
                    continue
                if not next_is_barge:
                    await c.wait_turn_complete(turn, timeout=turn_timeout)
                tr = c.transcript_after(said["t_start"])
                heard = tr["text"] if tr else None
                rec.update({
                    "heard": heard,
                    "wer": round(jiwer.wer(normalize(text, "he"), normalize(heard, "he")), 3) if heard else None,
                    "latency_ms": round((turn.t_first_audio - said["t_end"]) * 1000),
                    "server_latency_ms": turn.server_latency.get("response_latency_ms"),
                    "agent": turn.text, "agent_audio_s": round(turn.audio_s, 2), "underruns": turn.underruns, "gap_ms": round(turn.gap_ms),
                    "overlong": turn.overlong,
                })
                res["turns"].append(rec)
                last = turn
        want_summary = [s for s in sc["steps"] if "expect_summary" in s]
        if not c.closed.is_set():
            await c.close(end=True, wait_summary_s=240)
        else:
            await c.close(end=False)
        for s in want_summary:
            spec = s["expect_summary"]
            val = json.dumps((c.summary or {}).get(spec["field"], ""), ensure_ascii=False)
            res["checks"].append({"check": f"summary_{spec['field']}", "pass": _has_any(val, spec["any"]), "text": val,
                                  "summary_method": (c.summary or {}).get("method")})
        res["summary"] = c.summary
        res["stats"] = c.stats
        res["errors"] = c.errors
        res["late_mic_frames"] = c.late_frames
    except Exception as e:
        res["error"] = repr(e)[:300]
        try:
            await c.close(end=False)
        except Exception:
            pass
    res["wall_s"] = round(time.monotonic() - t_begin, 1)
    return res


def aggregate(results: list[dict]) -> dict:
    lat = [t["latency_ms"] for r in results for t in r["turns"] if t.get("latency_ms") is not None]
    by_lang = {}
    for lang in ("he", "en", "auto"):
        refs = [normalize(t["said"], "he") for r in results if r["language"] == lang for t in r["turns"] if t.get("heard") is not None]
        hyps = [normalize(t["heard"], "he") for r in results if r["language"] == lang for t in r["turns"] if t.get("heard") is not None]
        clean_refs = [normalize(t["said"], "he") for r in results if r["language"] == lang and r.get("snr_db") is None for t in r["turns"] if t.get("heard") is not None]
        clean_hyps = [normalize(t["heard"], "he") for r in results if r["language"] == lang and r.get("snr_db") is None for t in r["turns"] if t.get("heard") is not None]
        if refs:
            by_lang[lang] = {"n": len(refs), "wer_all": round(jiwer.wer(refs, hyps), 4),
                             "wer_clean": round(jiwer.wer(clean_refs, clean_hyps), 4) if clean_refs else None}
    checks = [c for r in results for c in r["checks"]]
    ints = [i for r in results for i in r["interruptions"]]
    turns = [t for r in results for t in r["turns"]]
    stage: dict[str, list] = {}
    for r in results:
        for name, s in ((r.get("stats") or {}).get("stages") or {}).items():
            if s.get("n"):
                stage.setdefault(name, []).append(s["median"])
    return {
        "scenarios": len(results), "scenarios_failed": sum(1 for r in results if r.get("error")),
        "turns": len(turns), "turns_without_response": sum(1 for t in turns if t.get("error")),
        "response_latency_ms": summarize(lat),
        "wer_synthetic_speech": by_lang,
        "checks_passed": sum(1 for c in checks if c["pass"]), "checks_total": len(checks),
        "checks_failed": [f'{r["id"]}:{c["check"]}' for r in results for c in r["checks"] if not c["pass"]],
        "interruptions": {"attempted": len(ints), "detected": sum(1 for i in ints if i.get("interrupted")),
                          "onset_to_interrupt_ms": summarize([i["onset_to_interrupt_ms"] for i in ints if "onset_to_interrupt_ms" in i]),
                          "audio_after_interrupt_ms": summarize([i["audio_after_interrupt_ms"] for i in ints if "audio_after_interrupt_ms" in i])},
        "playout_underruns_per_turn": round(sum(t.get("underruns", 0) for t in turns) / max(1, len(turns)), 2),
        "stage_medians_ms": {k: summarize(v) for k, v in stage.items()},
        "opener_first_audio_ms": summarize([r["opener"]["first_audio_ms"] for r in results if r.get("opener")]),
    }


async def main_async(a) -> None:
    spec = json.loads((ROOT / "benchmarks/scenarios/scenarios.json").read_text(encoding="utf-8"))
    scenarios = [s for s in spec["scenarios"] if a.only is None or any(s["id"].startswith(o) for o in a.only)]
    out = {"benchmark": "scenarios", "provider": a.provider, "url": a.url, "tag": a.tag, "hardware_note": a.hardware,
           "host": platform.platform(), "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "repeat": a.repeat,
           "session_options": json.loads(a.options) if a.options else {}, "results": []}
    path = RESULTS / f"scenarios_{a.provider}_{out['started'].replace(':', '').replace('-', '')}.json"
    RESULTS.mkdir(parents=True, exist_ok=True)
    for rep in range(a.repeat):
        for sc in scenarios:
            try:  # a scenario may never block the whole run
                r = await asyncio.wait_for(run_scenario(a.url, a.provider, sc, a.tag, a.turn_timeout, a.opener_timeout,
                                                        json.loads(a.options) if a.options else None), timeout=a.scenario_timeout)
            except asyncio.TimeoutError:
                r = {"id": sc["id"], "title": sc["title"], "language": sc.get("language", "en"), "snr_db": sc.get("snr_db"), "turns": [],
                     "checks": [], "interruptions": [], "error": f"scenario exceeded {a.scenario_timeout:.0f} s and was abandoned"}
            r["repeat"] = rep
            out["results"].append(r)
            lat = [t.get("latency_ms") for t in r["turns"]]
            print(f"{sc['id']:26s} turns={len(r['turns'])} latency_ms={lat} checks={[c['pass'] for c in r['checks']]} err={r.get('error')}", flush=True)
            out["aggregate"] = aggregate(out["results"])
            path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out["aggregate"], ensure_ascii=False, indent=1))
    print("saved", path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8000/ws")
    ap.add_argument("--provider", required=True)
    ap.add_argument("--tag", default="bench-scenarios")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--turn-timeout", type=float, default=90)
    ap.add_argument("--opener-timeout", type=float, default=120)
    ap.add_argument("--hardware", default="unspecified", help="free-text description of the server hardware, stored with the results")
    ap.add_argument("--options", default="", help='JSON session options, e.g. {"endpoint_silence_ms": 320, "eager_silence_ms": 160}')
    ap.add_argument("--scenario-timeout", type=float, default=480)
    asyncio.run(main_async(ap.parse_args()))
