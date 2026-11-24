"""Synthetic user speech + synthetic road noise for repeatable benchmarks.

All benchmark audio is either synthesised here (no real person's voice) or taken from the
FLEURS dataset (CC BY 4.0) for word-error-rate tests.  Utterances are cached as WAV files
keyed by a hash of (voice, text) so runs are reproducible.
"""
from __future__ import annotations

import asyncio
import hashlib
import wave
from pathlib import Path

import numpy as np
import soxr

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "benchmarks" / "audio_cache"
SR = 16000

_engines: dict[str, object] = {}


def _engine(lang: str):
    if lang not in _engines:
        if lang == "he":
            from providers.modular.tts_hebrew import RenikudPiperTTS
            _engines[lang] = RenikudPiperTTS({"model_dir": str(ROOT / "models/hebrew-tts"), "num_threads": 2})
        else:
            from providers.modular.tts import SherpaTTS
            # A different voice family from the agent's default voice, so the benchmark does not
            # feed the agent its own voice.
            _engines[lang] = SherpaTTS({"kind": "vits", "model_dir": str(ROOT / "models/vits-piper-en_US-lessac-medium"),
                                        "model_file": "en_US-lessac-medium.onnx", "num_threads": 2})
    return _engines[lang]


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    return soxr.resample(x, sr, SR) if sr != SR else x


def write_wav(path: Path, audio: np.ndarray, sr: int = SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


async def _synth(text: str, lang: str) -> np.ndarray:
    eng = _engine(lang)
    buf = b""
    async for pcm in eng.synth(text, lang):
        buf += pcm
    x = np.frombuffer(buf, dtype="<i2").astype(np.float32) / 32768.0
    x = soxr.resample(x, eng.sample_rate, SR)
    peak = float(np.max(np.abs(x))) or 1.0
    return trim_silence((x / peak * 0.6).astype(np.float32))


def trim_silence(x: np.ndarray, margin_ms: float = 20.0) -> np.ndarray:
    """Remove leading/trailing silence so that the end of the clip IS the end of speech.
    Client-side latency is measured from the last sample sent, so trailing TTS silence would
    otherwise make every latency look shorter than it is."""
    frame = SR // 100
    n = len(x) // frame
    if n < 3:
        return x
    e = np.sqrt(np.mean(x[: n * frame].reshape(n, frame) ** 2, axis=1))
    idx = np.where(e > max(e.max() * 0.03, 1e-4))[0]
    m = int(margin_ms / 10)
    return x[max(0, idx[0] - m) * frame: min(n, idx[-1] + 1 + m) * frame]


async def user_speech(text: str, lang: str) -> np.ndarray:
    """Return 16 kHz float32 audio of `text` spoken by the synthetic user voice."""
    key = hashlib.sha1(f"{lang}:{text}".encode()).hexdigest()[:16]
    path = CACHE / f"{lang}_{key}_t.wav"
    if path.exists():
        return read_wav(path)
    audio = await _synth(text, lang)
    write_wav(path, audio)
    return audio


def user_speech_sync(text: str, lang: str) -> np.ndarray:
    return asyncio.run(user_speech(text, lang))


def road_noise(seconds: float = 30.0, seed: int = 7) -> np.ndarray:
    """Synthetic in-car noise: low-frequency rumble (1/f^2 shaped), engine harmonics, wind hiss
    and occasional bumps.  Unit RMS; scale with `gain_for_snr`."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    shape = 1.0 / np.maximum(f, 20.0) ** 1.0  # road/tyre rumble dominates below ~500 Hz
    shape *= 1.0 / (1.0 + (f / 2500.0) ** 2)
    rumble = np.fft.irfft(spec * shape, n)
    rumble /= np.sqrt(np.mean(rumble ** 2))
    t = np.arange(n) / SR
    rpm_hz = 38 + 4 * np.sin(2 * np.pi * 0.05 * t)  # slowly varying engine fundamental
    phase = 2 * np.pi * np.cumsum(rpm_hz) / SR
    engine = sum(a * np.sin(k * phase + rng.uniform(0, 6.28)) for k, a in ((1, 1.0), (2, 0.6), (3, 0.35), (4, 0.2)))
    engine /= np.sqrt(np.mean(engine ** 2))
    hiss_spec = np.fft.rfft(rng.standard_normal(n)) * ((f > 800) & (f < 6000)) / np.maximum(f, 800.0) ** 0.5
    hiss = np.fft.irfft(hiss_spec, n)
    hiss /= np.sqrt(np.mean(hiss ** 2))
    bumps = np.zeros(n)
    for start in rng.integers(0, n - SR // 4, size=max(1, int(seconds / 6))):
        m = SR // 8
        bumps[start:start + m] += rng.standard_normal(m) * np.exp(-np.arange(m) / (SR * 0.02)) * 6
    x = 1.0 * rumble + 0.5 * engine + 0.25 * hiss + 0.3 * bumps
    return (x / np.sqrt(np.mean(x ** 2))).astype(np.float32)


def speech_rms(audio: np.ndarray) -> float:
    """RMS over the active part of an utterance (frames above -40 dB of the peak)."""
    frame = SR // 50
    n = len(audio) // frame
    if n == 0:
        return float(np.sqrt(np.mean(audio ** 2)) or 1e-6)
    e = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame) ** 2, axis=1))
    active = e[e > e.max() * 0.01]
    return float(np.sqrt(np.mean(active ** 2))) if len(active) else 1e-6


def gain_for_snr(speech: np.ndarray, snr_db: float) -> float:
    """Gain to apply to unit-RMS noise so that speech/noise = snr_db."""
    return speech_rms(speech) / (10 ** (snr_db / 20.0))


def mix_at_snr(speech: np.ndarray, noise: np.ndarray, snr_db: float, pad_s: float = 0.3) -> np.ndarray:
    pad = np.zeros(int(pad_s * SR), dtype=np.float32)
    x = np.concatenate([pad, speech, pad])
    idx = np.arange(len(x)) % len(noise)
    y = x + noise[idx] * gain_for_snr(speech, snr_db)
    peak = float(np.max(np.abs(y)))
    return (y / peak * 0.9 if peak > 0.95 else y).astype(np.float32)
