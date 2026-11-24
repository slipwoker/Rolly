"""Builds the agent context (system prompt + proactive opener) from the shared memory store.

The output is plain text so the very same context is handed to every architecture:
a chat-completions LLM in the modular pipeline, `instructions` of a realtime API, or the
text prompt of a speech-to-speech model.
"""
from __future__ import annotations

import datetime as dt
import json
import time
from pathlib import Path
from typing import Optional

from .store import MemoryStore

END_MARKER = "<end_session/>"

VOICE_STYLE = """You are Rolly, a proactive voice companion who talks with the user while they are travelling (usually driving).
This is a live spoken conversation. Everything you write is converted to speech.

How you speak:
- Speak in {language_name}. {language_rules}
- Keep each turn short: one or two spoken sentences, about thirty words at most, then stop and let the user talk.
- Sound like a sharp, warm friend, not an assistant. No lists, no markdown, no emojis, no stage directions.
- Write numbers, dates and abbreviations the way they are spoken.
- Ask at most one question per turn.

How you lead:
- You lead the conversation. Do not wait to be prompted and never ask "how can I help you".
- Use what you know about the user (below) to pick topics that matter to them, and build on previous conversations.
- Go deep rather than broad: challenge assumptions, offer a concrete angle, summarise decisions out loud.
- If the user changes the subject, follow immediately and do not drag them back.
- If the user corrects you, accept the correction briefly and continue with the corrected information.
- If you are interrupted, stop, listen, and respond to what the user just said.
- If you did not understand (noise, unclear speech), say so in a few words and ask them to repeat.
- Only state facts you are confident about. If you do not know, say you do not know.

Safety while driving:
- Never ask the user to look at or touch a screen, read, or type.
- If the user sounds stressed by traffic, offer to pause.

Ending:
- When the user clearly wants to stop (for example "that's enough", "let's stop", "bye", "we've arrived"), reply with one short closing sentence that names the main takeaway, and then append the exact marker {end_marker} at the very end. Never say the marker out loud in any other situation.
"""

LANG = {
    "he": ("Hebrew", "Write natural, everyday spoken Hebrew without niqqud. Technical or brand terms may stay in English when an Israeli speaker would say them in English."),
    "en": ("English", "Use natural, conversational English."),
    "auto": ("the language the user is speaking (Hebrew or English)", "Mirror the user's language turn by turn; mixed Hebrew-English is fine. Write Hebrew without niqqud."),
}


def seed_store(store: MemoryStore, path: str | Path | None = None, overwrite: bool = False) -> int:
    """Load the synthetic profiles shipped with the POC."""
    path = Path(path or Path(__file__).with_name("seed_profiles.json"))
    data = json.loads(path.read_text(encoding="utf-8"))
    n = 0
    for u in data["users"]:
        uid = u["user_id"]
        if store.get_user(uid) and not overwrite:
            continue
        profile = {k: v for k, v in u.items() if k not in ("user_id", "seed_memories")}
        store.upsert_user(uid, profile)
        for m in u.get("seed_memories", []):
            store.add_memory(uid, m["kind"], m["content"], created_at=time.time() - 86400 * m.get("days_ago", 1))
        n += 1
    return n


def _when(ts: float, now: float) -> str:
    days = int((now - ts) // 86400)
    if days <= 0:
        return "earlier today"
    if days == 1:
        return "yesterday"
    return f"{days} days ago"


def build_context(store: MemoryStore, user_id: str, language: str | None, journey: dict | None,
                  now: Optional[dt.datetime] = None, system_prompt_override: str | None = None,
                  max_summaries: int = 3) -> dict:
    """Return {'system_prompt', 'opener_instruction', 'language', 'profile', 'memory'}."""
    profile = store.get_user(user_id) or {"name": "there", "preferred_language": "en"}
    language = language or profile.get("preferred_language", "en")
    if language not in LANG:
        language = "auto"
    journey = journey or {}
    now = now or dt.datetime.now()
    now_ts = time.time()
    lang_name, lang_rules = LANG[language]

    style = (system_prompt_override or VOICE_STYLE)
    for key, val in (("{language_name}", lang_name), ("{language_rules}", lang_rules), ("{end_marker}", END_MARKER)):
        style = style.replace(key, val)

    summaries = store.get_memories(user_id, "summary", limit=max_summaries)
    open_topics = store.get_memories(user_id, "open_topic", limit=6)
    actions = store.get_memories(user_id, "action_item", limit=6)
    facts = store.get_memories(user_id, "fact", limit=8)

    lines: list[str] = ["", "## About the user"]
    lines.append(f"Name: {profile.get('name', 'unknown')}")
    if profile.get("professional_background"):
        lines.append(f"Professional background: {profile['professional_background']}")
    if profile.get("interests"):
        lines.append("Personal interests: " + ", ".join(profile["interests"]))
    if profile.get("current_goals"):
        lines.append("Current goals:")
        lines += [f"- {g}" for g in profile["current_goals"]]
    prefs = profile.get("preferences") or {}
    if prefs:
        lines.append("Conversation preferences: " + "; ".join(f"{k}: {v}" for k, v in prefs.items()))
    if facts:
        lines.append("Known facts:")
        lines += [f"- {f['content']}" for f in facts]

    lines += ["", "## Memory of previous conversations"]
    if summaries:
        for s in summaries:
            lines.append(f"- ({_when(s['created_at'], now_ts)}) {s['content']}")
    else:
        lines.append("- This is the first conversation with this user.")
    if open_topics:
        lines.append("Unresolved topics:")
        lines += [f"- {t['content']}" for t in open_topics]
    if actions:
        lines.append("Open action items the user took on:")
        lines += [f"- {a['content']}" for a in actions]

    minutes = journey.get("duration_min")
    part_of_day = "morning" if now.hour < 12 else "afternoon" if now.hour < 17 else "evening"
    lines += ["", "## Current journey"]
    lines.append(f"Local time: {now.strftime('%A %H:%M')} ({part_of_day}).")
    if minutes:
        lines.append(f"Estimated time until arrival: about {int(minutes)} minutes. Pace the conversation to fit.")
    if journey.get("origin") or journey.get("destination"):
        lines.append(f"Route: {journey.get('origin', '?')} to {journey.get('destination', '?')}.")
    if journey.get("mode"):
        lines.append(f"Travel mode: {journey['mode']}.")

    system_prompt = style.rstrip() + "\n" + "\n".join(lines) + "\n"

    opener = None
    if journey.get("proactive", True):
        opener = (
            "[journey_start event - this is not something the user said] "
            f"The user has just started a journey{f' of about {int(minutes)} minutes' if minutes else ''}. "
            "Open the conversation yourself, right now, in two or three short spoken sentences (under forty words): "
            f"greet them by name for the {part_of_day}, mention roughly how long you have together, "
            "and propose continuing the single most relevant unresolved topic from your memory "
            "(refer to what was actually discussed), ending with one simple question that lets them accept or choose something else."
        )
        if not summaries and not open_topics:
            opener = (
                "[journey_start event - this is not something the user said] "
                "The user has just started a journey. Open the conversation yourself in at most three short sentences: "
                "greet them by name, and propose one topic connected to their goals or interests, ending with a simple question."
            )

    return {
        "system_prompt": system_prompt,
        "opener_instruction": opener,
        "language": language,
        "profile": profile,
        "memory": {
            "summaries": [s["content"] for s in summaries],
            "open_topics": [t["content"] for t in open_topics],
            "action_items": [a["content"] for a in actions],
        },
    }
