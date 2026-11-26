"""Text utilities for speech: incremental sentence chunking and language routing."""
from __future__ import annotations

import re

from memory.context import END_MARKER

_HEB = re.compile(r"[֐-׿]")
_LAT = re.compile(r"[A-Za-z]")
_STRIP = re.compile(r"[*_#`~>|]+|\[(?:[^\]]*)\]\([^)]*\)")
_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️]")
# The LLM may *propose* ending the session with the end marker, but small models over-use it,
# so the pipeline only honours it when the user's last words plausibly ask to stop.
END_INTENT = re.compile(
    r"\b(bye|goodbye|good night|that'?s enough|that is enough|let'?s stop|stop (for )?(now|today|here)|enough for (now|today)|"
    r"we('| ha)ve arrived|i('m| am) (here|done)|we'?re (here|done)|see you|talk (to you )?later|end the (conversation|session|call))\b"
    r"|להתראות|ביי|מספיק|נעצור|תעצרי|תעצור|הגעתי|הגענו|נדבר אחר כך|נדבר מחר|סיימנו|נסיים|לילה טוב",
    re.I,
)


def user_wants_to_end(user_text: str | None) -> bool:
    if not user_text:
        return False
    return user_text.lstrip().startswith("[") or bool(END_INTENT.search(user_text))


_HARD = ".!?…\n"
_SOFT = ",;:—–"


def dominant_language(text: str, default: str = "en") -> str:
    h, l = len(_HEB.findall(text)), len(_LAT.findall(text))
    if h == 0 and l == 0:
        return default
    return "he" if h >= l * 0.5 and h > 0 else "en"


_QUESTION_END = re.compile(r"\?[\s\"'”’»)\]]*$")


def ends_with_question(text: str) -> bool:
    """True when a reply ends with a question (ignoring the end marker and the " —" of a cut-off reply)."""
    t = (text or "").replace(END_MARKER, " ").strip().rstrip("—-").strip()
    return bool(_QUESTION_END.search(t))


# Appended to the user's message (never stored in history) when Rolly's previous reply was a question.
# The persona already says "do not end every turn with a question", but a small model loses that rule in a long
# system prompt; a note next to the turn is followed far more reliably (owner's phone tests, 2026-11-25).
QUESTION_GUARD_NOTE = (
    "[Note for this turn only, not said by the user: your previous reply ended with a question. "
    "This time do not ask anything. React briefly, then say something of your own: an opinion, an idea, "
    "something interesting, or pick one concrete topic and start talking about it. "
    "End with a statement, not a question.]")


def question_guard_note(history: list[dict]) -> str | None:
    """The note to add to this turn when the last thing Rolly said was a question, else None."""
    last = next((m for m in reversed(history) if m.get("role") == "assistant"), None)
    return QUESTION_GUARD_NOTE if last and ends_with_question(last.get("content", "")) else None


# Hebrew words the voice front end reads wrongly without vowels.  Applied only to the text sent to a Hebrew voice
# (history and transcripts keep the plain spelling).  Value: vocalised spelling with the intended reading.
#   זאפי (the owner's company, "Zappy"): read as "zaffy" because an unmarked פ in the middle is read as f.  The vocalised
#   spelling זַאפִּי did not fix it for the owner's ear; written in Latin letters the Hebrew voice says it right
#   (listening samples, 2026-11-26: the owner chose "Zappy" and מָאוֹר).
#   מאור (a first name, "Ma-or"): read as "Me-or" without vowels.
HE_PRONUNCIATION: dict[str, str] = {
    "זאפי": "Zappy",
    "מאור": "מָאוֹר",
}
_HE_LETTER = "א-ת"


def _he_pattern(word: str) -> re.Pattern:
    # optional one- or two-letter prefixes (ו, ה, ב, ל, מ, ש, כ: "בזאפי", "ושזאפי"); not inside a longer word
    return re.compile(rf"(?<![{_HE_LETTER}])([והבלמשכ]{{0,2}}){re.escape(word)}(?![{_HE_LETTER}])")


_HE_PATTERNS = [(_he_pattern(w), v) for w, v in HE_PRONUNCIATION.items()]


def he_pronounce(text: str) -> str:
    """Replace words from HE_PRONUNCIATION with their vocalised reading, keeping any prefix letters."""
    for pat, v in _HE_PATTERNS:
        # a Hebrew prefix letter before a word written in Latin letters takes a hyphen, as in written Hebrew ("ב-Zappy")
        joiner = "-" if v[:1].isascii() and v[:1].isalpha() else ""
        text = pat.sub(lambda m, v=v, joiner=joiner: (m.group(1) + joiner if m.group(1) else "") + v, text)
    return text


def clean_for_speech(text: str) -> str:
    text = text.replace(END_MARKER, " ")
    text = _STRIP.sub(" ", text)
    text = _EMOJI.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


class SentenceChunker:
    """Splits a token stream into speakable chunks.

    The first chunk is released early (at a clause boundary) because time-to-first-audio
    is what the user perceives as latency; later chunks are whole sentences, which gives
    the TTS better prosody.
    """

    def __init__(self, first_min_chars: int = 24, min_chars: int = 40, max_chars: int = 220):
        self.first_min = first_min_chars
        self.min = min_chars
        self.max = max_chars
        self._buf = ""
        self._emitted = 0

    def feed(self, delta: str) -> list[str]:
        self._buf += delta
        out: list[str] = []
        while True:
            cut = self._find_cut()
            if cut < 0:
                break
            chunk, self._buf = self._buf[:cut], self._buf[cut:]
            chunk = clean_for_speech(chunk)
            if chunk:
                out.append(chunk)
                self._emitted += 1
        return out

    def _find_cut(self) -> int:
        buf = self._buf
        # never cut in the middle of a possible end marker / tag
        lt = buf.rfind("<")
        limit = len(buf) if lt < 0 or ">" in buf[lt:] else lt
        need = self.first_min if self._emitted == 0 else self.min
        for i in range(limit):
            ch = buf[i]
            if ch in _HARD and i + 1 >= min(need, 12):
                # require following whitespace/end so "3.5" or "e.g." are not split mid-token
                if i + 1 < len(buf):
                    if buf[i + 1] in " \n\"'”)":
                        return i + 1
                    if ch == "\n":
                        return i + 1
                continue
            if ch in _SOFT and i + 1 >= need and self._emitted == 0 and i + 1 < len(buf) and buf[i + 1] == " ":
                return i + 1
        if limit >= self.max:
            sp = buf.rfind(" ", 0, self.max)
            return sp + 1 if sp > 0 else self.max
        return -1

    def flush(self) -> list[str]:
        chunk = clean_for_speech(self._buf)
        self._buf = ""
        return [chunk] if chunk else []



# -- telling the agent's own voice and stray sounds from a real interruption ----------------------
# Words that always count as an interruption, however short or unclear the recognition was.
STOP_WORDS = {"רגע", "עצור", "עצרי", "די", "שנייה", "שניה", "חכה", "חכי", "סטופ", "שקט", "stop", "wait", "hold", "pause", "enough", "quiet"}
_WORD = re.compile(r"[\w\u0590-\u05ff']+")
_NIQQUD = re.compile(r"[\u0591-\u05c7]")


def _tokens(text: str) -> list[str]:
    return _WORD.findall(_NIQQUD.sub("", (text or "").replace("\u2019", "'").replace("\u05f3", "'")).lower())


def has_stop_word(text: str) -> bool:
    return any(t in STOP_WORDS for t in _tokens(text))


def echo_like(heard: str, agent_text: str) -> bool:
    """True if `heard` is (mostly) made of words the agent was just saying.

    Used only for sound that started while the agent was audible: without headphones the microphone
    picks up the loudspeaker, and what comes back is recognised as "user speech"."""
    import difflib

    h, a = _tokens(heard), _tokens(agent_text)
    if not h or not a or (len(h) == 1 and h[0] in STOP_WORDS):
        return False
    def same(w: str, x: str) -> bool:
        if w == x:
            return True
        if len(w) < 3:
            return False
        # an echo that was cut short gives the beginning of a word ("more" for "morning")
        return x.startswith(w[:3]) and (x.startswith(w) or w.startswith(x) or difflib.SequenceMatcher(None, w, x).ratio() >= 0.5) \
            or difflib.SequenceMatcher(None, w, x).ratio() >= 0.8

    hits = sum(1 for w in h if any(same(w, x) for x in a))
    return hits / len(h) >= 0.7
