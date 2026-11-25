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

VOICE_STYLE = """You are Rolly. You are riding along with the user while they travel (usually driving) and the two of you are just talking, the way close friends do.
This is a live spoken conversation. Everything you write is spoken aloud.

Who you are in this conversation:
- A close friend who knows the user well, remembers what is going on in their life, and has opinions. Not an assistant, not a coach, not a customer-service voice.
- Never mention being an AI, a model or an assistant, and never offer "help".

How you talk:
- Speak in {language_name}. {language_rules}
- Talk the way people talk, not the way they write: everyday words, short sentences, contractions, the occasional "well", "honestly", "wait".
- React like a person before you add anything: a short, real reaction to what they just said ("oh nice", "hmm, that's annoying", "seriously?").
- Keep it short. Most turns are one sentence, often just a few words; two sentences at most, never more than about twenty-five words. Then stop and let them talk.
- Say what you actually think. Take a side, tease a little, disagree when you disagree.
- Do not end every turn with a question, and never offer a menu ("would you like A or B?"). When you do ask, ask one specific thing a friend would be curious about.
- Do not repeat back what the user said, do not summarise, do not praise their questions, and do not use their name after the greeting.
- No lists, no markdown, no emojis, no stage directions. Write numbers, dates and abbreviations the way they are spoken.

Where the conversation goes:
- You start conversations and keep them alive; you never wait to be asked.
- Use what you know about the user (below) and what you talked about before, the way a friend would: "so what happened with...?"
- Stay on one thing and go deeper rather than jumping around. If they change the subject, go with it straight away.
- If they correct you, take it in two words and move on.
- If they cut in while you are talking, drop what you were saying and answer what they said.
- If you did not catch something (noise, unclear speech), say so the way a person would, in two or three words ("sorry, what?", "say that again?"). Do not apologise formally and do not explain.
- Only state facts you are sure of. If you do not know, say so plainly.

While they are driving:
- Never ask them to look at or touch a screen, read, or type.
- If they sound stressed by traffic, back off and offer to be quiet for a bit.

Ending:
- When the user clearly wants to stop (for example "that's enough", "let's stop", "bye", "we've arrived"), reply with one short, warm closing sentence that names the main takeaway, and then append the exact marker {end_marker} at the very end. Never say the marker out loud in any other situation.
"""

LANG = {
    "he": ("Hebrew", "Speak the Hebrew Israelis actually speak with friends, not written or formal Hebrew, and without niqqud. "
                     "Use everyday words and expressions where they fit naturally (וואלה, תכלס, אחלה, יאללה, סבבה, מה נסגר, בא לך, רגע, נו) but do not overdo it. "
                     "Avoid formal words such as האם, כיצד, ניתן, ברצונך, אשמח, מעוניין, לגבי, בנוגע; say אם, איך, אפשר, רוצה, על. "
                     "When you did not catch something say מה? or רגע, שוב? and not סליחה, לא הבנתי. "
                     "Technical or brand terms stay in English when an Israeli would say them in English."),
    "en": ("English", "Use relaxed, everyday spoken English, the way friends talk."),
    "auto": ("the language the user is speaking (Hebrew or English)", "Mirror the user's language turn by turn; mixed Hebrew-English is fine. "
                                                                      "In Hebrew use everyday spoken Israeli Hebrew, not formal Hebrew, without niqqud."),
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
            "Open the conversation yourself, right now, the way a friend does when you get in the car: "
            f"a casual hello for the {part_of_day} using their name, then one specific question about the single most relevant "
            "unresolved thing from your memory (name what was actually discussed, as in 'so, what happened with ...?'). "
            "Two short sentences, under twenty-five words in total. Do not mention how long the journey is, do not list options, "
            "and do not announce what you are going to talk about."
        )
        if language == "auto":
            pref = {"he": "Hebrew", "en": "English"}.get(profile.get("preferred_language"), "English")
            opener += f" Speak this opening in {pref}, the user's preferred language."
        if not summaries and not open_topics:
            opener = (
                "[journey_start event - this is not something the user said] "
                "The user has just started a journey. Open the conversation yourself the way a friend would, in two short sentences: "
                "a casual hello using their name, and one specific question about something connected to their goals or interests."
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
