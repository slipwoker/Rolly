"""Has the user finished what they were saying?

A fixed silence (544 ms) ends every turn, so a user who stops to think in the middle of a sentence is answered too early, and one
who finished is made to wait for the same silence.  After the speculative transcript of the utterance is back (pipeline.py, at
the eager point), `judge` reads its end:

  "done"      a question, or a sentence that ends with a full stop, or a one-word answer: answer at once
  "continue"  a comma, a connective, a preposition, a hesitation sound at the end: wait longer for the rest
  "unsure"    anything else: the usual silence

The rules are plain on purpose (Hebrew and English, no model call): the transcript is available when the decision is needed, and
what they get wrong is measured (a verdict followed by the user speaking again, `turn_end_resumed_*` metrics) before the decision
is applied (`turn_end: "on"`).  Mode "shadow" records and changes nothing.
"""
from __future__ import annotations

import re

DONE, CONTINUE, UNSURE = "done", "continue", "unsure"

# ending a clause: the sentence goes on
_CONNECTIVES = {
    # Hebrew: conjunctions, prepositions and discourse markers that are followed by more
    "ו", "אבל", "כי", "אז", "ש", "של", "עם", "על", "את", "אל", "ל", "ב", "מ", "כ", "ה", "כמו", "גם", "או", "אם", "כש", "כאשר",
    "כאילו", "יעני", "פשוט", "בעצם", "למשל", "כלומר", "לגבי", "בגלל", "אחרי", "לפני", "בין", "עד", "אצל", "בשביל", "ואז", "ואם",
    "וגם", "אלא", "כדי",
    # English
    "and", "but", "so", "because", "or", "if", "the", "an", "to", "of", "with", "like", "that", "which", "when", "then", "as",
    "for", "in", "on", "at", "about", "my", "your", "just", "also", "kind", "sort",
}
# hesitation sounds, said while thinking
_HESITATION = re.compile(r"^(?:א+מ+|א+ה+|ה+מ+|אה+|אממ+|אמ+|ה+ה+|u+h+m*|u+m+|h+m+|e+r+m*|m+h*)$", re.IGNORECASE)
# short answers that are complete on their own
_ANSWERS = {"כן", "לא", "סבבה", "יאללה", "אוקיי", "בסדר", "נכון", "ברור", "תודה", "טוב", "לגמרי", "בטח", "אולי", "ביי", "היי", "שלום",
            "yes", "no", "yeah", "yep", "nope", "okay", "ok", "sure", "right", "thanks", "bye", "hi", "hello", "maybe"}
_STRIP = " \t\n‏‎\"'()[]{}"


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"\s+", text.strip()) if w]


def judge(text: str | None, speech_ms: float | None = None) -> str:
    """The verdict for what the user said so far (the transcript of the utterance up to its pause)."""
    t = (text or "").strip(_STRIP)
    if not t:
        return UNSURE
    words = _words(t)
    last_char = t[-1]
    last = words[-1].strip(_STRIP + ".,!?…:;-–—").lower()
    # the end of a clause or a thought that trails off
    if last_char in ",:;-–—" or t.endswith("...") or last_char == "…":
        return CONTINUE
    if _HESITATION.match(last):
        return CONTINUE
    # a question or an exclamation is complete
    if last_char in "?!":
        return DONE
    if len(words) == 1:
        if last in _CONNECTIVES:
            return CONTINUE  # "אבל" alone: the rest is coming
        return DONE if last in _ANSWERS else UNSURE
    if last_char == "." and len(words) >= 3:  # the transcriber closed the sentence
        return DONE
    if last in _CONNECTIVES or (len(last) == 1 and last.isalpha() and last not in ("a", "i")):
        return CONTINUE
    return UNSURE


# how long the pause may last before the user is answered (ms): the first two are applied only in mode "on"
CONTINUE_SILENCE_MS = 1400.0
DONE_SILENCE_MS = 0.0  # as soon as the verdict is in


def override_for(verdict: str, mode: str) -> float | None:
    """The silence that ends this utterance in place of the usual one, or None (leave it)."""
    if mode != "on":
        return None
    if verdict == CONTINUE:
        return CONTINUE_SILENCE_MS
    if verdict == DONE:
        return DONE_SILENCE_MS
    return None


def mode_from(value) -> str:
    v = str(value or "").strip().lower()
    return v if v in ("off", "shadow", "on") else "shadow"
