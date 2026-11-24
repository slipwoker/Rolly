"""Speech-to-text engines for the modular pipeline.

* FasterWhisperSTT  - self-hosted Whisper-family models through CTranslate2 (CPU or CUDA).
* OpenAICompatSTT   - any `/v1/audio/transcriptions` endpoint (OpenAI, Groq, self-hosted
                      speaches / faster-whisper-server, vLLM audio models...).

Engines are process-wide singletons so concurrent sessions share one loaded model.
"""
from __future__ import annotations

import asyncio
import io
import os
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class STTResult:
    text: str
    language: Optional[str] = None
    ms: float = 0.0
    audio_s: float = 0.0
    queue_ms: float = 0.0
    avg_logprob: Optional[float] = None
    no_speech_prob: Optional[float] = None
    detect_ms: float = 0.0


# Whisper is known to emit these on silence / noise; treat them as "nothing was said".
HALLUCINATIONS = {
    "thanks for watching", "thank you for watching", "thank you.", "you", "bye.", ".",
    "תודה רבה", "תודה רבה.", "תודה.", "תודה על הצפייה", "תודה שצפיתם", "כתוביות מופעלות על ידי",
}


class FasterWhisperSTT:
    def __init__(self, cfg: dict):
        from faster_whisper import WhisperModel

        self.model_id = cfg.get("model", "small")
        self.device = cfg.get("device", "auto")
        self.compute_type = cfg.get("compute_type", "default")
        self.beam_size = int(cfg.get("beam_size", 1))
        self.allowed_languages = cfg.get("languages", ["he", "en"])
        self.initial_prompt = cfg.get("initial_prompt")
        workers = int(cfg.get("num_workers", 1))
        t0 = time.monotonic()
        self.model = WhisperModel(
            self.model_id,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=int(cfg.get("cpu_threads", 0)),
            num_workers=workers,
            download_root=cfg.get("download_root"),
        )
        self.load_s = time.monotonic() - t0
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="stt")
        self.name = f"faster-whisper:{self.model_id}:{self.model.model.device}:{self.model.model.compute_type}"

    def _run(self, audio: np.ndarray, language: Optional[str], t_submit: float) -> STTResult:
        t0 = time.monotonic()
        lang = language if language in ("he", "en") else None
        if lang is None and len(audio) > 0:
            # Restrict auto-detection to the product languages: unrestricted Whisper detection
            # regularly mislabels short Hebrew utterances as Arabic.
            try:
                _, _, probs = self.model.detect_language(audio)
                allowed = [(l, p) for l, p in probs if l in self.allowed_languages]
                lang = max(allowed, key=lambda lp: lp[1])[0] if allowed else None
            except Exception:
                lang = None
        segments, info = self.model.transcribe(
            audio,
            language=lang,
            beam_size=self.beam_size,
            vad_filter=False,
            condition_on_previous_text=False,
            without_timestamps=True,
            initial_prompt=self.initial_prompt,
            temperature=0.0,
        )
        segs = list(segments)
        text = " ".join(s.text.strip() for s in segs).strip()
        avg_lp = float(np.mean([s.avg_logprob for s in segs])) if segs else None
        nsp = float(np.max([s.no_speech_prob for s in segs])) if segs else None
        if text.lower().strip() in HALLUCINATIONS and (len(audio) / 16000 < 1.2 or (nsp or 0) > 0.5):
            text = ""
        return STTResult(text=text, language=lang or info.language, ms=(time.monotonic() - t0) * 1000,
                         audio_s=len(audio) / 16000, queue_ms=(t0 - t_submit) * 1000, avg_logprob=avg_lp, no_speech_prob=nsp)

    async def transcribe(self, audio: np.ndarray, language: Optional[str]) -> STTResult:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self._run, audio, language, time.monotonic())


def _wav_bytes(audio: np.ndarray, sr: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


class OpenAICompatSTT:
    def __init__(self, cfg: dict):
        import httpx

        self.base_url = cfg["base_url"].rstrip("/")
        self.model = cfg.get("model", "whisper-1")
        key_env = cfg.get("api_key_env")
        self.api_key = (os.environ.get(key_env) if key_env else None) or cfg.get("api_key") or "not-needed"
        self._client = httpx.AsyncClient(timeout=30)
        self.name = f"stt-api:{self.model}@{self.base_url}"

    async def transcribe(self, audio: np.ndarray, language: Optional[str]) -> STTResult:
        t0 = time.monotonic()
        data = {"model": self.model, "response_format": "json"}
        if language in ("he", "en"):
            data["language"] = language
        resp = await self._client.post(
            f"{self.base_url}/audio/transcriptions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            data=data,
            files={"file": ("audio.wav", _wav_bytes(audio), "audio/wav")},
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"STT HTTP {resp.status_code}: {resp.text[:300]}")
        text = (resp.json().get("text") or "").strip()
        return STTResult(text=text, language=language, ms=(time.monotonic() - t0) * 1000, audio_s=len(audio) / 16000)


class STTRouter:
    """Per-language STT.  Measured in this POC (FLEURS): the Hebrew-tuned Whisper is much better on
    Hebrew (18.9 % vs 28.6 % WER) but much worse on English (29.0 % vs 5.6 %) than stock
    large-v3-turbo, so each language gets its own model.  For mixed/unknown language the
    detector engine decides Hebrew vs English first and the audio is then routed."""

    def __init__(self, cfg: dict):
        self.default = cfg.get("default", "he")
        self.engines = {k: get_stt(v) for k, v in cfg.items() if isinstance(v, dict)}
        self.detector = self.engines.get(cfg.get("detect_with", "en")) or next(iter(self.engines.values()))
        self.name = "routed[" + ", ".join(f"{k}={e.name}" for k, e in self.engines.items()) + f"; mixed->{self.default}]"

    async def transcribe(self, audio: np.ndarray, language: Optional[str]) -> STTResult:
        if language in self.engines:
            return await self.engines[language].transcribe(audio, language)
        # unknown / code-switching session: detect he vs en, then route
        t0 = time.monotonic()
        lang = None
        if isinstance(self.detector, FasterWhisperSTT) and len(audio):
            loop = asyncio.get_running_loop()
            try:
                _, _, probs = await loop.run_in_executor(self.detector._pool, self.detector.model.detect_language, audio)
                allowed = [(l, p) for l, p in probs if l in self.engines]
                lang = max(allowed, key=lambda lp: lp[1])[0] if allowed else None
            except Exception:
                lang = None
        detect_ms = (time.monotonic() - t0) * 1000
        lang = lang or self.default
        res = await self.engines[lang].transcribe(audio, lang)
        res.detect_ms = detect_ms
        return res


_engines: dict[str, object] = {}
_lock = threading.RLock()


def get_stt(cfg: dict):
    if "engine" not in cfg and any(isinstance(v, dict) for v in cfg.values()):
        return STTRouter(cfg)
    key = repr(sorted(cfg.items()))
    with _lock:
        if key not in _engines:
            engine = cfg.get("engine", "faster_whisper")
            if engine == "faster_whisper":
                _engines[key] = FasterWhisperSTT(cfg)
            elif engine == "openai_compat":
                _engines[key] = OpenAICompatSTT(cfg)
            else:
                raise ValueError(f"unknown STT engine {engine}")
        return _engines[key]
