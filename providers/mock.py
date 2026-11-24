"""Deterministic mock provider.

Used ONLY to test the platform plumbing (transport, telemetry, barge-in, memory) without
any model.  It is never included in benchmark comparisons.  Speech detection is a simple
energy gate and the "agent voice" is a sine tone, so results are reproducible in CI.
"""
from __future__ import annotations

import asyncio
import math
import uuid

import numpy as np

from . import base
from .base import VoiceProvider

SR_OUT = 24_000


def tone(seconds: float, freq: float = 330.0, sr: int = SR_OUT) -> bytes:
    n = int(seconds * sr)
    t = np.arange(n) / sr
    x = 0.2 * np.sin(2 * math.pi * freq * t)
    fade = min(240, n // 2)
    if fade:
        env = np.ones(n)
        env[:fade] = np.linspace(0, 1, fade)
        env[-fade:] = np.linspace(1, 0, fade)
        x *= env
    return (x * 32767).astype("<i2").tobytes()


class MockProvider(VoiceProvider):
    architecture = "mock"

    def __init__(self, provider_id: str, config: dict):
        super().__init__(provider_id, config)
        self.reply_seconds = float(config.get("reply_seconds", 3.0))
        self.think_ms = float(config.get("think_ms", 120))
        self.silence_ms = float(config.get("endpoint_silence_ms", 400))
        self.energy_threshold = float(config.get("energy_threshold", 600))
        self._speaking = False
        self._speech_ms = 0.0
        self._silence_ms = 0.0
        self._audio_ms = 0.0
        self._last_speech_ms = 0.0
        self._turn: asyncio.Task | None = None
        self._rid: str | None = None
        self._turn_no = 0

    async def _start(self) -> None:
        if self.ctx.proactive and self.ctx.opener_instruction:
            self._turn = asyncio.create_task(self._respond("Good morning. This is the mock agent opening the journey.", proactive=True))

    async def push_audio(self, pcm16: bytes) -> None:
        n = len(pcm16) // 2
        if n == 0:
            return
        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32)
        rms = float(np.sqrt(np.mean(samples * samples)))
        dur_ms = n / 16.0
        self._audio_ms += dur_ms
        loud = rms > self.energy_threshold
        if loud:
            self._silence_ms = 0.0
            self._speech_ms += dur_ms
            self._last_speech_ms = self._audio_ms
            if not self._speaking and self._speech_ms >= 60:
                self._speaking = True
                await self.emit(base.USER_SPEECH_STARTED, audio_ms=self._audio_ms - self._speech_ms)
                if (self._turn and not self._turn.done()) or self.client_is_playing():
                    await self._cancel(detect_audio_ms=self._audio_ms)
        else:
            self._silence_ms += dur_ms
            if not self._speaking:
                self._speech_ms = 0.0
            elif self._silence_ms >= self.silence_ms:
                self._speaking = False
                self._speech_ms = 0.0
                await self.emit(base.USER_SPEECH_STOPPED, audio_end_ms=self._last_speech_ms)
                self._turn_no += 1
                await self.emit(base.USER_TRANSCRIPT, text=f"(mock user utterance {self._turn_no})", final=True, language=self.ctx.language)
                self._turn = asyncio.create_task(self._respond(f"Mock reply number {self._turn_no}."))

    async def send_text(self, text: str) -> None:
        await self.emit(base.USER_TRANSCRIPT, text=text, final=True, language=self.ctx.language)
        await self._cancel()
        self._turn = asyncio.create_task(self._respond(f"You typed: {text}"))

    async def _respond(self, text: str, proactive: bool = False) -> None:
        rid = uuid.uuid4().hex[:8]
        self._rid = rid
        try:
            await asyncio.sleep(self.think_ms / 1000)
            await self.emit(base.AGENT_TURN_STARTED, response_id=rid, proactive=proactive)
            await self.emit(base.AGENT_TEXT, response_id=rid, delta=text)
            audio = tone(self.reply_seconds)
            step = SR_OUT * 2 // 10  # 100 ms chunks, sent ~4x faster than real time
            for i in range(0, len(audio), step):
                await self.emit(base.AGENT_AUDIO, audio=audio[i : i + step], sample_rate=SR_OUT, response_id=rid)
                await asyncio.sleep(0.025)
            await self.emit(base.AGENT_TURN_DONE, response_id=rid, text=text, interrupted=False, usage={})
        except asyncio.CancelledError:
            raise

    async def _cancel(self, detect_audio_ms: float | None = None) -> None:
        rid = self._rid
        if self._turn and not self._turn.done():
            self._turn.cancel()
            try:
                await self._turn
            except (asyncio.CancelledError, Exception):
                pass
        self.reset_playback_clock()
        if rid:
            await self.emit(base.AGENT_INTERRUPTED, response_id=rid, detect_audio_ms=detect_audio_ms)
            self._rid = None

    async def interrupt(self) -> None:
        await self._cancel()

    async def close(self) -> None:
        if self._turn and not self._turn.done():
            self._turn.cancel()
