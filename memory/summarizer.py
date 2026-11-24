"""Automatic session summaries and action-item extraction.

The same summariser (the "utility LLM") is used for every provider, so cross-session
memory does not depend on which voice architecture produced the transcript.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from .store import MemoryStore

SUMMARY_PROMPT = """You maintain the long-term memory of a voice companion.
Below is the transcript of one conversation between the companion (agent) and the user.
Return ONLY a JSON object with these keys:
  "summary": two to four sentences, written in English, in the third person, stating what was discussed and what was decided,
  "topics": list of short topic labels,
  "decisions": list of decisions the user made (may be empty),
  "action_items": list of concrete things the USER said they will do (may be empty),
  "unresolved_topics": list of topics that were opened but not concluded and are worth continuing next time,
  "resolved_topics": list of previously open topics that were concluded in this conversation,
  "new_user_facts": list of durable facts learned about the user (may be empty),
  "suggested_next_opener": one sentence the companion could use to open the next journey.
Do not invent anything that is not supported by the transcript. If the transcript is empty or trivial, use empty lists and say so in the summary.

Previously open topics:
{open_topics}

Transcript:
{transcript}
"""


def format_transcript(turns: list[dict], max_chars: int = 24_000) -> str:
    lines = [f"{'USER' if t['role'] == 'user' else 'AGENT'}: {t['text']}" for t in turns if t.get("text")]
    text = "\n".join(lines)
    if len(text) > max_chars:  # keep the beginning and the end
        text = text[: max_chars // 3] + "\n[...]\n" + text[-2 * max_chars // 3 :]
    return text


def _extract_json(text: str) -> Optional[dict]:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def fallback_summary(turns: list[dict]) -> dict:
    """Used when no utility LLM is reachable.  Clearly marked as a fallback."""
    user_lines = [t["text"] for t in turns if t["role"] == "user" and t.get("text")]
    return {
        "summary": ("Conversation with %d user turns. First user remark: %s" % (len(user_lines), user_lines[0][:200]))
        if user_lines else "Conversation ended before the user said anything.",
        "topics": [], "decisions": [], "action_items": [], "unresolved_topics": [], "resolved_topics": [],
        "new_user_facts": [], "suggested_next_opener": "", "method": "fallback_no_llm",
    }


async def summarize_session(llm, turns: list[dict], open_topics: list[str]) -> dict:
    """`llm` is an OpenAICompatLLM (or None)."""
    if not turns:
        return fallback_summary(turns)
    if llm is None:
        return fallback_summary(turns)
    prompt = SUMMARY_PROMPT.format(
        open_topics="\n".join(f"- {t}" for t in open_topics) or "- (none)",
        transcript=format_transcript(turns),
    )
    try:
        res = await llm.complete([{"role": "user", "content": prompt}], max_tokens=700, temperature=0.1)
        obj = _extract_json(res.text)
        if not obj or "summary" not in obj:
            raise ValueError("summariser returned no JSON")
        for k in ("topics", "decisions", "action_items", "unresolved_topics", "resolved_topics", "new_user_facts"):
            v = obj.get(k)
            obj[k] = [str(x) for x in v] if isinstance(v, list) else []
        obj["method"] = "llm"
        obj["llm"] = getattr(llm, "name", "?")
        obj["usage"] = {"prompt_tokens": res.prompt_tokens, "completion_tokens": res.completion_tokens, "ms": res.total_ms}
        return obj
    except Exception as e:  # never lose the session because the summariser failed
        fb = fallback_summary(turns)
        fb["error"] = repr(e)[:300]
        return fb


def persist_summary(store: MemoryStore, user_id: str, session_id: str, summary: dict) -> None:
    """Write the summary into long-term memory so the next journey can build on it."""
    if summary.get("method") == "fallback_no_llm" and not summary.get("summary"):
        return
    store.add_memory(user_id, "summary", summary["summary"], session_id)
    if summary.get("resolved_topics"):
        store.resolve_memories(user_id, "open_topic", summary["resolved_topics"])
    existing = [m["content"] for m in store.get_memories(user_id, "open_topic", limit=100)]
    for t in summary.get("unresolved_topics", []):
        if not any(t.lower() == e.lower() for e in existing):
            store.add_memory(user_id, "open_topic", t, session_id)
    for a in summary.get("action_items", []):
        store.add_memory(user_id, "action_item", a, session_id)
    for f in summary.get("new_user_facts", []):
        store.add_memory(user_id, "fact", f, session_id)
