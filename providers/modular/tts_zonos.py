"""ZONOS3-Mini voice (Zyphra, Apache-2.0 weights) through its own HTTP server.

Chosen for Hebrew after the first listening tests found the Piper voice robotic, flat and accented:
ZONOS3-Mini reads unvocalised Hebrew directly, clones a voice from a short recording and has a
speaking-rate control.  The server (`zonos3-server`, C++/ggml, CPU or GPU) runs next to the pipeline;
see infrastructure/zonos_setup.sh.

The voice is a file of pre-encoded reference codes (`reference_codes`, an int array [frames, 10] saved by
`zonos3-cli --save-reference`).  It is derived from a person's recording, so it is kept on the host and
never committed to the repository.
"""
from __future__ import annotations

import os
from typing import AsyncIterator

import numpy as np


class ZonosTTS:
    sample_rate = 44100

    def __init__(self, cfg: dict):
        import httpx

        self.base_url = cfg.get("base_url", "http://127.0.0.1:1919").rstrip("/")
        self.language = cfg.get("language", "he")
        # UTF-8 bytes per second (a Hebrew letter is 2 bytes).  Applied only to texts of at least `rate_min_chars`:
        # measured, a rate condition on a two- or three-word text makes the model drop the last word.
        self.speaking_rate = float(cfg.get("speaking_rate") or 0)
        self.rate_min_chars = int(cfg.get("rate_min_chars", 30))
        self.seed = cfg.get("seed")
        self.extra = dict(cfg.get("extra_body") or {})
        self.codes_path = cfg.get("reference_codes") or ""
        self.max_frames = int(cfg.get("reference_frames") or 0)  # 15 frames per second of reference; 0 = all
        self._codes = None
        self._codes_mtime = 0.0
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=2))
        self.name = f"zonos3-mini:cloned-voice:rate{self.speaking_rate:g}@{self.base_url}"

    def _voice(self) -> list:
        """The reference codes, re-read when the file changes (a new voice can be uploaded without a restart)."""
        mtime = os.path.getmtime(self.codes_path)  # raises if the voice was never uploaded: the router falls back
        if self._codes is None or mtime != self._codes_mtime:
            codes = np.load(self.codes_path).astype(int)
            if self.max_frames:
                codes = codes[: self.max_frames]
            self._codes, self._codes_mtime = codes.tolist(), mtime
        return self._codes

    async def synth(self, text: str, language: str | None = None) -> AsyncIterator[bytes]:
        # no silence prefill: measured, the default 3 frames also truncated short texts, and it delays the first audio
        body = {"text": text, "language": self.language, "stream": True, "format": "pcm", "silence_prefill_frames": 0,
                "speaker_reference_codes": self._voice(), "speaker_mode": "reference", **self.extra}
        if self.speaking_rate and len(text) >= self.rate_min_chars:
            body["condition_values"] = {"speaking_rate": self.speaking_rate}
        if self.seed is not None:
            body["seed"] = int(self.seed)
        async with self._client.stream("POST", f"{self.base_url}/v2/generate", json=body) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"ZONOS3 HTTP {resp.status_code}: {(await resp.aread())[:300]!r}")
            carry = b""
            async for chunk in resp.aiter_bytes():
                chunk = carry + chunk
                n = len(chunk) - len(chunk) % 4  # float32 samples
                chunk, carry = chunk[:n], chunk[n:]
                if chunk:
                    x = np.frombuffer(chunk, dtype="<f4")
                    yield (np.clip(np.nan_to_num(x), -1.0, 1.0) * 32767).astype("<i2").tobytes()
