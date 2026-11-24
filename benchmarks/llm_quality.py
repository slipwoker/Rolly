"""Text-level LLM probes with the exact context the voice agent uses.

Three controlled tests, scored by transparent keyword rules (no LLM judge):
  * context retention  : facts that ARE in the injected profile / memory must be recalled
  * hallucination      : questions about things that are NOT in memory must not be answered with
                         invented specifics (the reply must signal that it does not know / was not discussed)
  * general facts      : a few closed questions with one correct answer
plus time-to-first-token and output speed, and a long-context retention probe (a fact stated
early, recalled after N filler turns).

    python -m benchmarks.llm_quality --base-url http://127.0.0.1:8081/v1 --model local --label qwen3-4b-q4-cpu
"""
from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
import time
from pathlib import Path

from memory.context import build_context, seed_store
from memory.store import MemoryStore
from providers.modular.llm import LLMResult, OpenAICompatLLM
from telemetry.recorder import summarize

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "benchmarks" / "results"

# (user, question, any-of expected substrings)
RETENTION = [
    ("daniel", "How many customer interviews have I completed so far?", ["four", "4"]),
    ("daniel", "What was the go-to-market question we left open?", ["agenc", "famil"]),
    ("daniel", "Which verbs do I keep confusing in Spanish?", ["ser", "estar"]),
    ("daniel", "Where is my family trip going, and when?", ["madrid", "june"]),
    ("daniel", "What am I building in my workshop?", ["bookshel", "walnut"]),
    ("daniel", "How long is my commute?", ["30", "thirty"]),
    ("noa", "מה היו שלוש האפשרויות שדיברנו עליהן אתמול לגבי הכיוון של החברה?", ["גרמני", "תשלומים"]),
    ("noa", "מתי ישיבת הדירקטוריון?", ["15", "חמש עשר", "חמישה עשר", "חמש-עשר"]),
    ("noa", "ממי הייתי צריכה לבקש הערכת מאמץ למודול התשלומים?", ["יואב", "yoav"]),
    ("noa", "לאיזה מרוץ אני מתאמנת?", ["מרתון"]),
    ("noa", "כמה אנשים יש בצוות שלי?", ["שמונה", "8"]),
    ("noa", "כמה זמן לוקחת לי הנסיעה בבוקר?", ["25", "עשרים וחמש"]),
]
# questions with NO answer in memory: a good reply says it does not know / it was not discussed
UNKNOWN = [
    ("daniel", "What did we decide last week about hiring a chief financial officer?"),
    ("daniel", "What is the name of the investor I met on Tuesday?"),
    ("daniel", "How much did I say the fall-detection device will cost to manufacture?"),
    ("daniel", "What was my daughter's exam grade that I told you about?"),
    ("noa", "מה החלטנו בשבוע שעבר לגבי גיוס סמנכ\"ל כספים?"),
    ("noa", "איך קוראים למשקיע שפגשתי ביום שלישי?"),
    ("noa", "כמה אמרתי שעולה לנו לקוח חדש?"),
    ("noa", "מה היה הזמן שלי בריצת עשרת הקילומטרים האחרונה שסיפרתי לך עליה?"),
]
ABSTAIN = ["don't know", "do not know", "not sure", "no record", "didn't discuss", "did not discuss", "haven't discussed", "have not discussed",
           "don't have", "do not have", "didn't mention", "did not mention", "haven't mentioned", "not something we", "no memory", "don't recall",
           "do not recall", "didn't tell", "did not tell", "haven't told", "not aware", "wasn't", "we never", "you haven't", "you didn't",
           "לא יודע", "לא דיברנו", "לא זוכר", "לא סיפרת", "לא אמרת", "אין לי", "לא הזכרת", "לא עלה", "לא ידוע", "לא מצא", "לא החלטנו", "לא נאמר", "לא דנו"]
FACTS = [
    ("daniel", "Quick one: what is the capital of Australia?", ["canberra"]),
    ("daniel", "How many minutes are there in two and a half hours?", ["150", "one hundred and fifty", "one hundred fifty"]),
    ("daniel", "In Spanish, which verb is used for someone's profession, ser or estar?", ["ser"]),
    ("noa", "שאלה קצרה: מהי בירת צרפת?", ["פריז", "פריס"]),
    ("noa", "כמה זה שבע כפול שמונה?", ["56", "חמישים ושש"]),
    ("noa", "באיזו שנה הוקמה מדינת ישראל?", ["1948", "ארבעים ושמונה"]),
]
FILLER = ["Let's talk about how I should structure the customer interviews.", "What is a good opening question for an interview?",
          "How do I avoid leading questions?", "Should I record the interviews?", "How many notes should I take?",
          "What do I do if the customer goes off topic?", "How do I ask about budget without being rude?",
          "How long should each interview be?", "Who else should I interview besides adult children?",
          "What is the best way to summarise the findings?"]


def has_any(text: str, keys: list[str]) -> bool:
    low = text.lower()
    return any(k.lower() in low for k in keys)


async def ask(llm: OpenAICompatLLM, system: str, history: list[dict], q: str) -> tuple[str, LLMResult]:
    res = LLMResult()
    msgs = [{"role": "system", "content": system}] + history + [{"role": "user", "content": q}]
    async for _ in llm.stream(msgs, res, max_tokens=120, temperature=0.0):
        pass
    return res.text.strip(), res


async def main_async(a) -> None:
    llm = OpenAICompatLLM({"base_url": a.base_url, "model": a.model, "api_key_env": a.key_env, "max_tokens": 120})
    store = MemoryStore(Path(tempfile.mkdtemp()) / "m.sqlite3")
    seed_store(store)
    ctx = {u: build_context(store, u, None, {"duration_min": 25, "proactive": False}) for u in ("daniel", "noa")}
    out = {"benchmark": "llm_quality", "label": a.label, "model": a.model, "base_url": a.base_url, "hardware_note": a.hardware,
           "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "scoring": "keyword rules (see benchmarks/llm_quality.py)", "items": []}
    ttft, tps = [], []

    async def run(kind: str, user: str, q: str, check) -> None:
        text, res = await ask(llm, ctx[user]["system_prompt"], [], q)
        ok = check(text)
        if res.ttft_ms is not None:
            ttft.append(res.ttft_ms)
        if res.completion_tokens and res.total_ms and res.ttft_ms is not None and res.total_ms > res.ttft_ms:
            tps.append(res.completion_tokens / ((res.total_ms - res.ttft_ms) / 1000))
        out["items"].append({"kind": kind, "lang": ctx[user]["language"], "q": q, "a": text, "pass": ok,
                             "ttft_ms": round(res.ttft_ms or 0), "prompt_tokens": res.prompt_tokens, "completion_tokens": res.completion_tokens})
        print(f"[{kind:13s}] {'PASS' if ok else 'FAIL'} | {q[:50]} -> {text[:90]!r}", flush=True)

    for u, q, exp in RETENTION:
        await run("retention", u, q, lambda t, exp=exp: has_any(t, exp))
    for u, q in UNKNOWN:
        await run("hallucination", u, q, lambda t: has_any(t, ABSTAIN))
    for u, q, exp in FACTS:
        await run("fact", u, q, lambda t, exp=exp: has_any(t, exp))

    # long-context retention: a fact stated in turn 1 must survive N filler turns
    history: list[dict] = [{"role": "user", "content": "Before we start: my new pilot customer is called Meridian Home Care and they have 240 caregivers."},
                           {"role": "assistant", "content": "Got it, Meridian Home Care with 240 caregivers. What do you want to work on?"}]
    for depth in a.depths:
        while len(history) < 2 + depth * 2:
            f = FILLER[(len(history) // 2) % len(FILLER)]
            text, _ = await ask(llm, ctx["daniel"]["system_prompt"], history, f)
            history += [{"role": "user", "content": f}, {"role": "assistant", "content": text}]
        text, res = await ask(llm, ctx["daniel"]["system_prompt"], history, "By the way, what is my pilot customer called and how many caregivers do they have?")
        ok = has_any(text, ["meridian"]) and has_any(text, ["240", "two hundred and forty", "two hundred forty"])
        out["items"].append({"kind": "long_context", "filler_turns": depth, "a": text, "pass": ok, "prompt_tokens": res.prompt_tokens,
                             "ttft_ms": round(res.ttft_ms or 0)})
        print(f"[long_context ] {'PASS' if ok else 'FAIL'} after {depth} filler turns (prompt {res.prompt_tokens} tok) -> {text[:90]!r}", flush=True)

    def rate(kind: str, lang: str | None = None) -> dict:
        xs = [i for i in out["items"] if i["kind"] == kind and (lang is None or i.get("lang") == lang)]
        return {"n": len(xs), "passed": sum(i["pass"] for i in xs), "rate": round(sum(i["pass"] for i in xs) / len(xs), 3) if xs else None}

    out["summary"] = {
        "context_retention": {"all": rate("retention"), "en": rate("retention", "en"), "he": rate("retention", "he")},
        "no_hallucination_on_unknowns": {"all": rate("hallucination"), "en": rate("hallucination", "en"), "he": rate("hallucination", "he")},
        "general_facts": {"all": rate("fact"), "en": rate("fact", "en"), "he": rate("fact", "he")},
        "long_context": rate("long_context"),
        "ttft_ms": summarize(ttft), "output_tokens_per_s": summarize(tps),
    }
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"llm_quality_{a.label}_{out['started'].replace(':', '').replace('-', '')}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out["summary"], indent=1))
    print("saved", path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8081/v1")
    ap.add_argument("--model", default="local")
    ap.add_argument("--key-env", default="ROLLY_LLM_API_KEY")
    ap.add_argument("--label", default="llm")
    ap.add_argument("--depths", type=int, nargs="+", default=[10, 20])
    ap.add_argument("--hardware", default="unspecified")
    asyncio.run(main_async(ap.parse_args()))
