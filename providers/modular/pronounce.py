"""How the Hebrew voice says a user's name.

BlueV3's Hebrew front end ignores vowel marks and reads some names differently depending on where they stand in the
sentence (measured 2026-11-26 on 46 common first names in five contexts: 7 of them, e.g. מאור "meʔˈoʁ" alone and at the end
of a sentence, "maʔˈoʁ" in the middle).  The greeting, "היי מאור, …", is exactly where the name is said, in every ride.

`analyze` runs the front end on the name inside five carrier sentences.  A name that is read the same way everywhere is left
alone.  For one that is not, the reading in the middle of a sentence is pinned: it was the right one in all seven cases.
The pinned reading is then given to the voice as phonemes (`he_pronounce`, text.py).  The user can also correct it by
voice (the app picks one of the candidates below; the model never writes phonemes: it did so unreliably).

The front end lives in the voice server's process (infrastructure/blue_serve.py serves `/phonemize` on a local port);
`NameProbe` is the client.  Without it everything is as before.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from collections import Counter
from typing import Callable, Optional

# (carrier sentence, index of the name among its words once punctuation is split off)
CARRIERS: tuple[tuple[str, int], ...] = (
    ("{}", 0),
    ("היי {}, מה קורה?", 1),
    ("תודה {}!", 1),
    ("בכיף, {}.", 1),
    ("{} אני איתך", 0),
)
MIDDLE = 1  # the carrier whose reading is pinned
_HE_NAME = re.compile(r"^[א-ת]{2,12}$")
_TAGS = re.compile(r"</?\w+>")


def usable_name(name: str | None) -> Optional[str]:
    """The first word of the name if it is a plain Hebrew word; names in other scripts or with a prefix are left alone."""
    word = ((name or "").split() or [""])[0].strip(" ,.!?\"'")
    return word if _HE_NAME.match(word) else None


def _reading(phonemes: str, index: int) -> Optional[str]:
    text = _TAGS.sub("", phonemes)
    words = [w for w in re.split(r"[ ,.!?]+", text.strip()) if w]
    return words[index] if index < len(words) else None


def analyze(word: str, phonemize: Callable[[str], str]) -> dict:
    """`phonemize(text) -> str` is the voice's Hebrew front end.  Returns the readings by context, the candidates (most common
    first), whether they all agree and the pinned one."""
    readings = []
    for carrier, index in CARRIERS:
        try:
            readings.append(_reading(phonemize(carrier.format(word)), index))
        except Exception:
            readings.append(None)
    seen = [r for r in readings if r]
    counts = Counter(seen)
    candidates = [r for r, _ in counts.most_common()]
    pinned = readings[MIDDLE] or (candidates[0] if candidates else None)
    return {"word": word, "readings": readings, "candidates": candidates, "stable": len(counts) <= 1, "pinned": pinned}


class NameProbe:
    """Client of the front end served next to the voice (`POST {url}/phonemize`), with a cache in memory and, if `cache_path`
    is set, in a file: a name is analysed once per pod."""

    def __init__(self, url: str | None, cache_path: str | None = None, timeout: float = 3.0):
        self.url = (url or "").rstrip("/")
        self.cache_path = cache_path or None
        self.timeout = timeout
        self._cache: dict[str, dict] = {}
        self._client = None
        if self.cache_path and os.path.exists(self.cache_path):
            try:
                with open(self.cache_path, encoding="utf-8") as f:
                    self._cache = json.load(f)
            except Exception:
                self._cache = {}

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    async def lookup(self, word: str, timeout: float | None = None) -> Optional[dict]:
        if not self.enabled or not word:
            return None
        if word in self._cache:
            return self._cache[word]
        try:
            import httpx
            if self._client is None:
                self._client = httpx.AsyncClient(timeout=self.timeout)
            r = await asyncio.wait_for(self._client.post(self.url + "/phonemize", json={"word": word}), timeout or self.timeout)
            r.raise_for_status()
            result = r.json()
            if not isinstance(result, dict) or "candidates" not in result:
                return None
        except Exception:
            return None  # no probe, too slow, a failure: the voice's own reading, as before
        self._cache[word] = result
        if self.cache_path:
            try:
                tmp = self.cache_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self._cache, f, ensure_ascii=False)
                os.replace(tmp, self.cache_path)
            except Exception:
                pass
        return result

    async def pins(self, name: str | None, timeout: float | None = None) -> dict[str, str]:
        """{word: phonemes} to apply for this name: only for a name whose reading depends on the context."""
        word = usable_name(name)
        if not word:
            return {}
        result = await self.lookup(word, timeout)
        if not result or result.get("stable") or not result.get("pinned"):
            return {}
        return {word: str(result["pinned"])}


_probes: dict[tuple, NameProbe] = {}


def get_probe(url: str | None, cache_path: str | None = None) -> NameProbe:
    """One probe (and one cache) per process, shared by the conversations."""
    key = (url or "", cache_path or "")
    if key not in _probes:
        _probes[key] = NameProbe(url, cache_path)
    return _probes[key]
