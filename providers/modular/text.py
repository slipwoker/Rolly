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
