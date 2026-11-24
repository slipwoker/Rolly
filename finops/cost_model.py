"""Financial feasibility model.

Reads config/pricing.yaml (every input carries a status: measured / published / unverified /
estimate / assumption) and writes:

  reports/cost_model.json   machine-readable, all scenarios
  reports/cost_model.md     the tables used in COSTS.md / FINAL_REPORT.md
  reports/cost_monthly.csv  monthly cost per architecture and DAU scenario

    python -m finops.cost_model
    python -m finops.cost_model --sessions-per-vcpu 55 --capacity-override '{"base": {"stt": 30, "llm": 80, "tts": 120}}'

Nothing in the output is a measurement unless its inputs are marked `measured`.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
UTILS = (0.30, 0.60, 0.80)


def load(path: Path | None = None) -> dict:
    return yaml.safe_load((path or ROOT / "config" / "pricing.yaml").read_text(encoding="utf-8"))


def demand(p: dict, dau: int) -> dict:
    u = p["usage"]
    daily_min = dau * u["minutes_per_user_per_day"]
    prof = [x / sum(u["hourly_profile"]) for x in u["hourly_profile"]]
    conc = [daily_min * s / 60.0 for s in prof]  # average concurrent conversations in each hour
    return {"dau": dau, "minutes_per_day": daily_min, "minutes_per_month": daily_min * u["days_per_month"],
            "hours_per_day": daily_min / 60, "avg_concurrency": daily_min / 1440, "peak_hour_share": max(prof),
            "peak_hour_concurrency": max(conc), "peak_concurrency_with_headroom": max(conc) * u["burst_headroom"],
            "hourly_concurrency": conc}


def gpu_factor(p: dict, gpu_name: str) -> float:
    cap = p["self_hosted_capacity"]
    if gpu_name.startswith("L4") and not gpu_name.startswith("L40"):
        return cap["l4_factor"]
    if gpu_name.startswith("H100"):
        return cap["h100_factor"]
    return 1.0


def gpus_per_conversation(p: dict, scenario: str, gpu_name: str, stages=("stt", "llm", "tts")) -> float:
    cap = p["self_hosted_capacity"]
    measured = cap.get("measured_combined_per_gpu")
    if measured and set(stages) == {"stt", "llm", "tts"}:
        # whole pipeline on one GPU: use the measured conversations per L40S
        return 1.0 / measured[scenario] / gpu_factor(p, gpu_name)
    c = cap["scenarios"][scenario]
    return sum(1.0 / c[s] for s in stages) / gpu_factor(p, gpu_name)


def infra_variable_per_min(p: dict, selfhosted_speech: bool = False) -> dict:
    i = p["infrastructure"]
    per_vcpu = i.get("sessions_per_vcpu_selfhosted", i["sessions_per_vcpu"])["value"] if selfhosted_speech else i["sessions_per_vcpu"]["value"]
    cpu = i["vcpu_hour"]["usd"] / 60.0 / per_vcpu
    egress = i["opus_mb_per_conv_min"]["value"] / 2 / 1024 * i["egress_gb"]["usd"]  # only the downlink half is billed egress
    storage = i["transcript_kb_per_conv_min"]["value"] / 1e6 * i["storage_gb_month"]["usd"] * 12  # kept ~12 months
    return {"cpu": cpu, "egress": egress, "storage": storage, "total": cpu + egress + storage}


def fleet(p: dict, d: dict, gpu_key: str, scenario: str, stages=("stt", "llm", "tts"), burst_gpu_key: str | None = None) -> dict:
    """GPU fleet for one DAU scenario.  Cloud on-demand is autoscaled per hour; dedicated/owned is sized for the peak."""
    g = p["gpu"][gpu_key]
    i = p["infrastructure"]
    per_conv = gpus_per_conversation(p, scenario, g["gpu"], stages)
    head = p["usage"]["burst_headroom"]
    need = [max(i["min_gpus_always_on"], math.ceil(c * head * per_conv * i["redundancy_factor"])) for c in d["hourly_concurrency"]]
    autoscaled = g["kind"].startswith("cloud")
    used_gpu_hours_day = sum(c * per_conv for c in d["hourly_concurrency"])
    if burst_gpu_key:
        # blended: own the capacity needed in the median hour, rent the rest by the hour
        b = p["gpu"][burst_gpu_key]
        base_n = sorted(need)[len(need) // 2]
        burst_hours = sum(max(0, n - base_n) for n in need)
        gpu_hours_day = base_n * 24 + burst_hours
        monthly = (base_n * 24 * g["usd_per_hour"] + burst_hours * b["usd_per_hour"]) * p["usage"]["days_per_month"]
        return {"gpu": gpu_key, "scenario": scenario, "mode": f"blended: {base_n} owned + hourly cloud burst", "peak_gpus": max(need),
                "min_gpus": base_n, "gpu_hours_per_month": gpu_hours_day * p["usage"]["days_per_month"],
                "realised_utilisation": used_gpu_hours_day / gpu_hours_day if gpu_hours_day else 0.0,
                "monthly_usd": monthly, "usd_per_min": monthly / d["minutes_per_month"]}
    gpu_hours_day = sum(need) if autoscaled else max(need) * 24
    monthly = gpu_hours_day * p["usage"]["days_per_month"] * g["usd_per_hour"]
    return {"gpu": gpu_key, "scenario": scenario, "mode": "autoscaled hourly" if autoscaled else "fixed fleet sized for peak",
            "peak_gpus": max(need), "min_gpus": min(need), "gpu_hours_per_month": gpu_hours_day * p["usage"]["days_per_month"],
            "realised_utilisation": used_gpu_hours_day / gpu_hours_day if gpu_hours_day else 0.0,
            "monthly_usd": monthly, "usd_per_min": monthly / d["minutes_per_month"]}


def tier(table: dict, dau: int):
    keys = sorted(int(k) for k in table)
    pick = keys[0]
    for k in keys:
        if dau >= k:
            pick = k
    return table[pick] if pick in table else table[str(pick)]


def interp_fixed(table: dict, dau: int) -> float:
    """Log-linear interpolation between DAU tiers so break-even curves are smooth."""
    pts = sorted((int(k), float(v)) for k, v in table.items())
    if dau <= pts[0][0]:
        return pts[0][1]
    if dau >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= dau <= x1:
            t = (math.log(dau) - math.log(x0)) / (math.log(x1) - math.log(x0))
            return y0 + t * (y1 - y0)
    return pts[-1][1]


def architectures(p: dict) -> list[dict]:
    """Every architecture as {id, family, label, api_usd_per_min, gpu (optional), stages, status}."""
    u = p["usage"]
    cc = p["commercial_components"]
    out = []
    for key, c in p["commercial_realtime"].items():
        out.append({"id": f"A:{key}", "family": "commercial", "label": c["label"], "api_usd_per_min": c["usd_per_min"], "status": c["status"]})
    stt_api = cc["stt_soniox_rt"]["usd_per_audio_min"] * min(1.0, u["user_speech_share"] + 0.1)  # VAD-gated streaming
    llm = cc["llm_gemini_3_1_flash_lite"]
    tts = cc["tts_inworld_2_flash"]
    out.append({"id": "D:all_api_list", "family": "hybrid", "label": "Hybrid, all components via APIs (list prices, LLM cache 90%)",
                "api_usd_per_min": stt_api + llm["usd_per_conv_min_cached"] + tts["usd_per_generated_min_he"] * u["agent_speech_share"],
                "status": "estimate"})
    out.append({"id": "D:all_api_committed", "family": "hybrid", "label": "Hybrid, all components via APIs (committed TTS tier, LLM cache 90%)",
                "api_usd_per_min": stt_api + llm["usd_per_conv_min_cached"] + tts["usd_per_generated_min_he_committed"] * u["agent_speech_share"],
                "status": "estimate"})
    for cap in ("low", "base", "high"):
        out.append({"id": f"D:selfhost_speech_api_llm:{cap}", "family": "hybrid",
                    "label": f"Hybrid, self-hosted STT+TTS on L40S + API LLM ({cap} capacity)",
                    "api_usd_per_min": llm["usd_per_conv_min_cached"], "gpu": "l40s_runpod", "capacity": cap, "stages": ("stt", "tts"),
                    "status": "assumption"})
        out.append({"id": f"D:selfhost_all_api_he_tts:{cap}", "family": "hybrid",
                    "label": f"Hybrid, self-hosted STT+LLM on L40S + commercial Hebrew TTS ({cap} capacity)",
                    "api_usd_per_min": tts["usd_per_generated_min_he_committed"] * u["agent_speech_share"], "gpu": "l40s_runpod",
                    "capacity": cap, "stages": ("stt", "llm"), "status": "assumption"})
    for gpu_key in p["gpu"]:
        for cap in ("low", "base", "high"):
            out.append({"id": f"B:{gpu_key}:{cap}", "family": "self_hosted", "label": f"Self-hosted modular, {p['gpu'][gpu_key]['label']} ({cap} capacity)",
                        "api_usd_per_min": 0.0, "gpu": gpu_key, "capacity": cap, "stages": ("stt", "llm", "tts"),
                        "status": "measured capacity and price" if gpu_key == "l40s_runpod" else "capacity scaled from the L40S measurement; price " + p["gpu"][gpu_key]["status"]})
    for cap in ("low", "base", "high"):
        out.append({"id": f"B:blend_owned_l40s_cloud:{cap}", "family": "self_hosted",
                    "label": f"Self-hosted modular, owned L40S base load + cloud L40S for peaks ({cap} capacity)",
                    "api_usd_per_min": 0.0, "gpu": "owned_l40s", "burst_gpu": "l40s_runpod", "capacity": cap,
                    "stages": ("stt", "llm", "tts"), "status": "measured capacity; owned-hardware cost is an estimate"})
    return out


def monthly(p: dict, arch: dict, dau: int) -> dict:
    d = demand(p, dau)
    iv = infra_variable_per_min(p, selfhosted_speech=bool(arch.get("gpu")))
    mins = d["minutes_per_month"]
    api = arch["api_usd_per_min"] * mins
    infra_var = iv["total"] * mins
    gpu_cost, fl = 0.0, None
    if arch.get("gpu"):
        fl = fleet(p, d, arch["gpu"], arch["capacity"], arch["stages"], arch.get("burst_gpu"))
        gpu_cost = fl["monthly_usd"]
    fixed_infra = interp_fixed(p["infrastructure"]["fixed_monthly_by_dau"], dau)
    people = interp_fixed(p["people"]["ops_fte"][arch["family"]], dau) * p["people"]["fte_monthly_usd"]
    variable = api + infra_var + gpu_cost
    total = variable + fixed_infra + people
    return {"arch": arch["id"], "dau": dau, "minutes": mins, "api_usd": api, "gpu_usd": gpu_cost, "infra_variable_usd": infra_var,
            "fixed_infra_usd": fixed_infra, "people_usd": people, "total_usd": total,
            "usd_per_min_variable": variable / mins, "usd_per_min_all_in": total / mins,
            "fleet": {k: v for k, v in (fl or {}).items() if k in ("mode", "peak_gpus", "min_gpus", "gpu_hours_per_month", "realised_utilisation")}}


def break_even(p: dict, a: dict, b: dict, lo: int = 20, hi: int = 2_000_000) -> int | None:
    """Smallest DAU at which architecture `b` is cheaper (all-in monthly) than `a`."""
    f = lambda n: monthly(p, b, n)["total_usd"] - monthly(p, a, n)["total_usd"]  # noqa: E731
    if f(lo) <= 0:
        return lo
    if f(hi) > 0:
        return None
    while hi - lo > max(1, lo // 200):
        mid = (lo + hi) // 2
        if f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return hi


def build(p: dict) -> dict:
    archs = architectures(p)
    by_id = {a["id"]: a for a in archs}
    iv = infra_variable_per_min(p, selfhosted_speech=True)
    out: dict = {"inputs_status_legend": "measured | published | unverified | estimate | assumption (see config/pricing.yaml)",
                 "demand": {str(n): {k: (round(v, 2) if isinstance(v, float) else v) for k, v in demand(p, n).items() if k != "hourly_concurrency"}
                            for n in p["usage"]["daily_active_users"]},
                 "infra_variable_usd_per_min": iv}
    # (1) parametric self-hosted cost per minute: GPU option x capacity scenario x utilisation
    grid = []
    for gk, g in p["gpu"].items():
        for cap in ("low", "base", "high"):
            per_conv = gpus_per_conversation(p, cap, g["gpu"])
            row = {"gpu": gk, "label": g["label"], "price_status": g["status"], "usd_per_gpu_hour": g["usd_per_hour"], "capacity": cap,
                   "conversations_per_gpu": round(1 / per_conv, 1)}
            for util in UTILS:
                row[f"usd_per_min@{int(util * 100)}%"] = g["usd_per_hour"] / 60 * per_conv / util + iv["total"]
            grid.append(row)
    out["self_hosted_usd_per_min"] = grid
    # (2) conversations per GPU needed to reach each target (GPU cost only, at 60 % utilisation)
    need = []
    for gk, g in p["gpu"].items():
        row = {"gpu": gk, "usd_per_gpu_hour": g["usd_per_hour"]}
        for t in p["targets_usd_per_min"]:
            budget = t - iv["total"]
            row[f"target_{t}"] = round(g["usd_per_hour"] / 60 / budget / 0.60, 1) if budget > 0 else None
        need.append(row)
    out["conversations_per_gpu_needed_at_60pct_util"] = need
    # (3) variable cost per minute of every architecture, and which targets it meets
    var = []
    d10k = demand(p, 10000)
    for a in archs:
        m = monthly(p, a, 10000)
        var.append({"arch": a["id"], "label": a["label"], "status": a["status"], "usd_per_min_variable": m["usd_per_min_variable"],
                    "usd_per_min_all_in_10k_dau": m["usd_per_min_all_in"],
                    "targets_met_variable": [t for t in p["targets_usd_per_min"] if m["usd_per_min_variable"] <= t]})
    out["per_minute_at_10k_dau"] = var
    # (4) monthly totals for every DAU scenario
    out["monthly"] = [monthly(p, a, n) for a in archs for n in p["usage"]["daily_active_users"]]
    # (5) break-even DAU: API architectures vs. self-hosting
    be = []
    for api_id in ("A:openai_gpt_realtime_2_1_mini", "A:openai_gpt_live_1_1", "A:gemini_3_8_live", "D:all_api_list", "D:all_api_committed"):
        for self_id in ("B:l40s_runpod:low", "B:l40s_runpod:base", "B:l40s_runpod:high", "B:blend_owned_l40s_cloud:base"):
            be.append({"api": api_id, "self_hosted": self_id, "break_even_dau": break_even(p, by_id[api_id], by_id[self_id])})
    out["break_even"] = be
    out["one_time_dev_usd"] = {k: v * p["people"]["fte_monthly_usd"] for k, v in p["people"]["one_time_dev_person_months"].items()}
    out["target_table_10k_dau"] = [{"usd_per_min": t, "monthly_usd": t * d10k["minutes_per_month"]} for t in p["targets_usd_per_min"]]
    return out


def fmt(x: float, digits: int = 4) -> str:
    return f"${x:,.{digits}f}"


def money(x: float) -> str:
    return f"${x:,.0f}"


def to_markdown(p: dict, o: dict) -> str:
    L: list[str] = ["# Cost model output", "",
                    "Generated by `python -m finops.cost_model` from `config/pricing.yaml`. **Every figure is a projection.** "
                    "The L40S price and the conversations-per-GPU of the fully self-hosted pipeline are *measured* (RunPod, 2026-11-24); "
                    "other GPU prices and OpenAI realtime token prices are *unverified*, and capacity for hybrid splits and other GPU types is "
                    "*assumed* (scaled from the L40S measurement).", ""]
    L += ["## Demand", "", "| DAU | Minutes / month | Conversation hours / day | Average concurrency | Peak-hour concurrency | Peak with headroom |", "|---:|---:|---:|---:|---:|---:|"]
    for n, d in o["demand"].items():
        L.append(f"| {int(n):,} | {d['minutes_per_month']:,.0f} | {d['hours_per_day']:,.0f} | {d['avg_concurrency']:,.1f} | {d['peak_hour_concurrency']:,.0f} | {d['peak_concurrency_with_headroom']:,.0f} |")
    L += ["", f"Peak hour carries {next(iter(o['demand'].values()))['peak_hour_share'] * 100:.0f}% of the day's minutes (assumed commute profile).", ""]
    L += ["## Self-hosted cost per conversational minute (GPU + CPU + egress + storage)", "",
          "| GPU option | $/GPU-h | Capacity scenario | Conversations per GPU | 30% utilisation | 60% utilisation | 80% utilisation |", "|---|---:|---|---:|---:|---:|---:|"]
    for r in o["self_hosted_usd_per_min"]:
        L.append(f"| {r['label']} | {r['usd_per_gpu_hour']:.2f} | {r['capacity']} | {r['conversations_per_gpu']} | {fmt(r['usd_per_min@30%'])} | {fmt(r['usd_per_min@60%'])} | {fmt(r['usd_per_min@80%'])} |")
    L += ["", "## Conversations per GPU required to hit each target (at 60% utilisation)", "",
          "| GPU option | $/GPU-h | $0.05 | $0.01 | $0.005 | $0.001 |", "|---|---:|---:|---:|---:|---:|"]
    for r in o["conversations_per_gpu_needed_at_60pct_util"]:
        L.append(f"| {p['gpu'][r['gpu']]['label']} | {r['usd_per_gpu_hour']:.2f} | {r['target_0.05']} | {r['target_0.01']} | {r['target_0.005']} | {r['target_0.001']} |")
    L += ["", "## Cost per minute by architecture at 10,000 DAU", "",
          "| Architecture | Input status | Variable $/min | All-in $/min (with people + fixed) | Targets met (variable) |", "|---|---|---:|---:|---|"]
    for r in sorted(o["per_minute_at_10k_dau"], key=lambda x: x["usd_per_min_variable"]):
        met = ", ".join(f"${t}" for t in r["targets_met_variable"]) or "none"
        L.append(f"| {r['label']} | {r['status']} | {fmt(r['usd_per_min_variable'])} | {fmt(r['usd_per_min_all_in_10k_dau'])} | {met} |")
    L += ["", "## Monthly cost by scenario (USD)", ""]
    show = ["A:openai_gpt_realtime_2_1", "A:openai_gpt_realtime_2_1_mini", "A:openai_gpt_live_1_1", "A:gemini_3_8_live", "D:all_api_list",
            "D:all_api_committed", "D:selfhost_speech_api_llm:base", "D:selfhost_all_api_he_tts:base", "B:l40s_runpod:low", "B:l40s_runpod:base",
            "B:l40s_runpod:high", "B:hetzner_gex63:base", "B:owned_l40s:base", "B:blend_owned_l40s_cloud:base"]
    labels = {a["id"]: a["label"] for a in architectures(p)}
    for n in p["usage"]["daily_active_users"]:
        L += [f"### {n:,} daily active users ({n * p['usage']['minutes_per_user_per_day'] * p['usage']['days_per_month']:,} minutes / month)", "",
              "| Architecture | API fees | GPU | CPU/egress/storage | Fixed infra | People (ops) | **Total / month** | All-in $/min | Peak GPUs | Fleet utilisation |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
        for aid in show:
            m = next(x for x in o["monthly"] if x["arch"] == aid and x["dau"] == n)
            f = m["fleet"]
            L.append(f"| {labels[aid]} | {money(m['api_usd'])} | {money(m['gpu_usd'])} | {money(m['infra_variable_usd'])} | {money(m['fixed_infra_usd'])} | "
                     f"{money(m['people_usd'])} | **{money(m['total_usd'])}** | {fmt(m['usd_per_min_all_in'])} | {f.get('peak_gpus', '–')} | "
                     f"{(str(round(f['realised_utilisation'] * 100)) + '%') if f else '–'} |")
        L.append("")
    L += ["## Break-even: daily active users above which self-hosting is cheaper (all-in monthly cost)", "",
          "| API architecture | vs. self-hosted | Break-even DAU |", "|---|---|---:|"]
    for b in o["break_even"]:
        v = "never (within 2M DAU)" if b["break_even_dau"] is None else (f"≤ {b['break_even_dau']}" if b["break_even_dau"] <= 20 else f"{b['break_even_dau']:,}")
        L.append(f"| {labels[b['api']]} | {labels[b['self_hosted']]} | {v} |")
    L += ["", "## One-time development cost of the voice stack (assumption)", "", "| Architecture | Person-months | Cost |", "|---|---:|---:|"]
    for k, v in o["one_time_dev_usd"].items():
        L.append(f"| {k} | {p['people']['one_time_dev_person_months'][k]} | {money(v)} |")
    L += ["", "## Target scenarios at 10,000 DAU (arithmetic, from the brief)", "", "| Cost per minute | Monthly cost |", "|---:|---:|"]
    for t in o["target_table_10k_dau"]:
        L.append(f"| ${t['usd_per_min']} | {money(t['monthly_usd'])} |")
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pricing", default=None)
    ap.add_argument("--sessions-per-vcpu", type=float, default=None, help="measured session-layer capacity; overrides the assumption")
    ap.add_argument("--capacity-override", default=None, help='JSON, e.g. {"base": {"stt": 30, "llm": 80, "tts": 120}} from GPU benchmarks')
    ap.add_argument("--out", default=str(ROOT / "reports"))
    a = ap.parse_args()
    p = load(Path(a.pricing) if a.pricing else None)
    if a.sessions_per_vcpu:
        p["infrastructure"]["sessions_per_vcpu"] = {"value": a.sessions_per_vcpu, "status": "measured"}
    if a.capacity_override:
        for k, v in json.loads(a.capacity_override).items():
            p["self_hosted_capacity"]["scenarios"][k].update(v)
        p["self_hosted_capacity"]["status"] = "measured (partially)"
    o = build(p)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "cost_model.json").write_text(json.dumps(o, indent=1), encoding="utf-8")
    (out / "cost_model.md").write_text(to_markdown(p, o), encoding="utf-8")
    with open(out / "cost_monthly.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["architecture", "dau", "minutes_per_month", "api_usd", "gpu_usd", "infra_variable_usd", "fixed_infra_usd", "people_usd",
                    "total_usd", "usd_per_min_variable", "usd_per_min_all_in", "peak_gpus", "fleet_utilisation"])
        for m in o["monthly"]:
            w.writerow([m["arch"], m["dau"], m["minutes"], round(m["api_usd"], 2), round(m["gpu_usd"], 2), round(m["infra_variable_usd"], 2),
                        round(m["fixed_infra_usd"], 2), round(m["people_usd"], 2), round(m["total_usd"], 2), round(m["usd_per_min_variable"], 6),
                        round(m["usd_per_min_all_in"], 6), m["fleet"].get("peak_gpus", ""), round(m["fleet"].get("realised_utilisation", 0), 3) or ""])
    print(f"wrote {out/'cost_model.json'}, {out/'cost_model.md'}, {out/'cost_monthly.csv'}")


if __name__ == "__main__":
    main()
