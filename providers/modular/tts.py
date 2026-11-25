"""Text-to-speech engines for the modular / hybrid pipelines.

Every engine exposes `async synth(text, language) -> AsyncIterator[bytes]` yielding PCM16
mono at `engine.sample_rate`, so self-hosted and commercial voices are interchangeable.

* SherpaTTS        - self-hosted ONNX voices (Kokoro, Piper/VITS) through sherpa-onnx.
* OpenAICompatTTS  - any `/v1/audio/speech` endpoint (OpenAI, Kokoro-FastAPI, Chatterbox servers...).
* ElevenLabsTTS    - ElevenLabs HTTP streaming (commercial Hebrew-capable fallback).
* TTSRouter        - picks an engine per chunk by language (Hebrew vs. Latin script).
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncIterator, Optional

import numpy as np

from .text import dominant_language


def _to_pcm16(samples) -> bytes:
    x = np.asarray(samples, dtype=np.float32)
    return (np.clip(x, -1.0, 1.0) * 32767).astype("<i2").tobytes()


class SherpaTTS:
    """Kokoro or Piper voices via sherpa-onnx.  Synthesis is per text chunk (sentence)."""

    def __init__(self, cfg: dict):
        import sherpa_onnx

        d = cfg["model_dir"]
        kind = cfg.get("kind", "kokoro")
        threads = int(cfg.get("num_threads", 2))
        provider = cfg.get("provider", "cpu")
        if kind == "kokoro":
            lex = ",".join(f"{d}/{n}" for n in cfg.get("lexicons", ["lexicon-us-en.txt", "lexicon-zh.txt"]))
            model = sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=f"{d}/model.onnx", voices=f"{d}/voices.bin", tokens=f"{d}/tokens.txt",
                    data_dir=f"{d}/espeak-ng-data", dict_dir=f"{d}/dict", lexicon=lex),
                num_threads=threads, provider=provider)
        elif kind == "vits":
            model = sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=f"{d}/{cfg['model_file']}", tokens=f"{d}/tokens.txt", data_dir=f"{d}/espeak-ng-data"),
                num_threads=threads, provider=provider)
        else:
            raise ValueError(f"unknown sherpa TTS kind {kind}")
        n = int(cfg.get("num_instances", 1))
        self._instances = [sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1)) for _ in range(n)]
        self._free: Optional[asyncio.Queue] = None
        self._pool = ThreadPoolExecutor(max_workers=n, thread_name_prefix="tts")
        self.sample_rate = self._instances[0].sample_rate
        self.sid = int(cfg.get("speaker_id", 0))
        self.speed = float(cfg.get("speed", 1.0))
        self.name = f"sherpa-{kind}:{os.path.basename(d)}:sid{self.sid}:{provider}"

    async def synth(self, text: str, language: str | None = None) -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        if self._free is None:
            self._free = asyncio.Queue()
            for inst in self._instances:
                self._free.put_nowait(inst)
        q: asyncio.Queue = asyncio.Queue()
        stop = threading.Event()
        inst = await self._free.get()

        def run() -> None:
            def cb(samples, progress):
                if stop.is_set():
                    return 0
                loop.call_soon_threadsafe(q.put_nowait, _to_pcm16(samples))
                return 1
            try:
                inst.generate(text, sid=self.sid, speed=self.speed, callback=cb)
                loop.call_soon_threadsafe(q.put_nowait, None)
            except Exception as e:  # pragma: no cover - surfaced to the caller
                loop.call_soon_threadsafe(q.put_nowait, e)

        fut = loop.run_in_executor(self._pool, run)
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            stop.set()
            fut.add_done_callback(lambda _f: loop.call_soon_threadsafe(self._free.put_nowait, inst))


class OpenAICompatTTS:
    def __init__(self, cfg: dict):
        import httpx

        self.base_url = cfg["base_url"].rstrip("/")
        self.model = cfg.get("model", "tts-1")
        self.voice = cfg.get("voice", "alloy")
        self.sample_rate = int(cfg.get("sample_rate", 24000))
        key_env = cfg.get("api_key_env")
        self.api_key = (os.environ.get(key_env) if key_env else None) or cfg.get("api_key") or "not-needed"
        self.extra = dict(cfg.get("extra_body") or {})
        self.send_language = str(cfg.get("send_language", "")).lower() in ("1", "true", "yes")  # our GPU worker routes voices by language
        self._client = httpx.AsyncClient(timeout=60)
        self.name = f"tts-api:{self.model}:{self.voice}@{self.base_url}"

    async def synth(self, text: str, language: str | None = None) -> AsyncIterator[bytes]:
        body = {"model": self.model, "voice": self.voice, "input": text, "response_format": "pcm", **self.extra}
        if self.send_language and language in ("he", "en"):
            body["language"] = language
        async with self._client.stream("POST", f"{self.base_url}/audio/speech",
                                       headers={"Authorization": f"Bearer {self.api_key}"}, json=body) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"TTS HTTP {resp.status_code}: {(await resp.aread())[:300]!r}")
            carry = b""
            async for chunk in resp.aiter_bytes(4800):
                chunk = carry + chunk
                if len(chunk) % 2:
                    chunk, carry = chunk[:-1], chunk[-1:]
                else:
                    carry = b""
                if chunk:
                    yield chunk


class BlueTTS(OpenAICompatTTS):
    """BlueV3 (Hebrew-first open model, MIT) through the OpenAI-compatible server that ships with BlueTTS,
    started next to the pipeline by infrastructure/blue_setup.sh.  The server returns the model's own 44.1 kHz PCM.

    Chosen for Hebrew on 2026-11-25: in the sentence-ending test all 12 utterances ended cleanly with the last word
    recognised (ZONOS3-Mini: 5 of 12), and the product owner picked this voice and speed from listening samples."""

    def __init__(self, cfg: dict):
        super().__init__({"base_url": cfg.get("blue_url", "http://127.0.0.1:1920/v1"), "model": "bluev3",
                          "voice": cfg.get("blue_voice", "daniel"), "sample_rate": int(cfg.get("blue_sample_rate", 44100)),
                          "extra_body": {"speed": float(cfg.get("blue_speed", 1.2)), "language": cfg.get("blue_language", "he"), "stream": True}})
        self.name = f"bluev3:{self.voice}:speed{self.extra['speed']:g}@{self.base_url}"


class ElevenLabsTTS:
    def __init__(self, cfg: dict):
        import httpx

        self.voice_id = cfg["voice_id"]
        self.model = cfg.get("model", "eleven_flash_v2_5")
        self.sample_rate = int(cfg.get("sample_rate", 24000))
        self.api_key = os.environ.get(cfg.get("api_key_env", "ELEVENLABS_API_KEY")) or "not-needed"
        self.base_url = cfg.get("base_url", "https://api.elevenlabs.io").rstrip("/")
        self._client = httpx.AsyncClient(timeout=60)
        self.name = f"elevenlabs:{self.model}:{self.voice_id}"

    async def synth(self, text: str, language: str | None = None) -> AsyncIterator[bytes]:
        body = {"text": text, "model_id": self.model}
        if language in ("he", "en"):
            body["language_code"] = language
        url = f"{self.base_url}/v1/text-to-speech/{self.voice_id}/stream?output_format=pcm_{self.sample_rate}"
        async with self._client.stream("POST", url, headers={"xi-api-key": self.api_key}, json=body) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"ElevenLabs HTTP {resp.status_code}: {(await resp.aread())[:300]!r}")
            carry = b""
            async for chunk in resp.aiter_bytes(4800):
                chunk = carry + chunk
                if len(chunk) % 2:
                    chunk, carry = chunk[:-1], chunk[-1:]
                else:
                    carry = b""
                if chunk:
                    yield chunk


_engines: dict[str, object] = {}
_lock = threading.Lock()


def _build(cfg: dict):
    engine = cfg.get("engine")
    if engine == "sherpa":
        return SherpaTTS(cfg)
    if engine == "openai_compat":
        return OpenAICompatTTS(cfg)
    if engine == "elevenlabs":
        return ElevenLabsTTS(cfg)
    if engine == "blue":
        return BlueTTS(cfg)
    if engine == "zonos":
        from .tts_zonos import ZonosTTS
        return ZonosTTS(cfg)
    if engine == "renikud_piper":
        from .tts_hebrew import RenikudPiperTTS
        return RenikudPiperTTS(cfg)
    raise ValueError(f"unknown TTS engine {engine}")


def get_tts_engine(cfg: dict):
    key = repr(sorted((k, repr(v)) for k, v in cfg.items()))
    with _lock:
        if key not in _engines:
            _engines[key] = _build(cfg)
        return _engines[key]


class TTSRouter:
    """Routes each text chunk to the engine configured for its language (engines load lazily)."""

    def __init__(self, cfg: dict):
        # cfg is either a single engine config or {"en": {...}, "he": {...}, "default": "en"}
        if "engine" in cfg:
            self.configs = {"default": cfg}
            self.default = "default"
        else:
            self.default = cfg.get("default", "en")
            self.configs = {k: v for k, v in cfg.items() if isinstance(v, dict)}
        self.engines: dict[str, object] = {}
        self.unavailable: dict[str, str] = {}

    @property
    def name(self) -> str:
        parts = []
        for k in self.configs:
            if k in self.engines:
                parts.append(f"{k}={self.engines[k].name}")
            elif k in self.unavailable:
                parts.append(f"{k}=UNAVAILABLE")
            else:
                parts.append(f"{k}={self.configs[k].get('engine')}(not loaded)")
        return " | ".join(parts)

    def engine_for(self, lang: str):
        key = lang if lang in self.configs else self.default if self.default in self.configs else next(iter(self.configs))
        if key in self.unavailable:
            raise RuntimeError(f"no TTS voice available for language '{key}': {self.unavailable[key]}")
        if key not in self.engines:
            try:
                self.engines[key] = get_tts_engine(self.configs[key])
            except Exception as e:
                self.unavailable[key] = repr(e)[:200]
                raise RuntimeError(f"no TTS voice available for language '{key}': {e!r}") from e
        return self.engines[key]

    def warm(self) -> None:
        for k in self.configs:
            try:
                self.engine_for(k)
            except Exception:
                pass

    def _fallback_for(self, lang: str):
        """Optional second voice for a language (`fallback:` in its config), used when the first one fails."""
        key = lang if lang in self.configs else self.default
        fb = (self.configs.get(key) or {}).get("fallback")
        if not isinstance(fb, dict):
            return None
        try:
            return get_tts_engine(fb)
        except Exception:
            return None

    async def synth(self, text: str, hint: str | None = None):
        """Yield (pcm16_bytes, sample_rate, language, engine_name)."""
        lang = dominant_language(text, default=hint if hint in ("he", "en") else self.default)
        engine = self.engine_for(lang)
        started = False
        try:
            async for pcm in engine.synth(text, lang):
                started = True
                yield pcm, engine.sample_rate, lang, engine.name
        except (asyncio.CancelledError, GeneratorExit):
            raise
        except Exception as e:
            fb = None if started else self._fallback_for(lang)
            if fb is None:
                raise
            now = time.monotonic()
            if now - getattr(self, "_last_fallback_log", 0.0) > 30:  # do not flood the log while a backend is down
                self._last_fallback_log = now
                print(f"[tts] {engine.name} failed ({e!r}); using {fb.name}"[:300], flush=True)
            async for pcm in fb.synth(text, lang):
                yield pcm, fb.sample_rate, lang, fb.name
