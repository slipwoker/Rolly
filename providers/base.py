"""Provider abstraction shared by every voice architecture.

A provider receives 16 kHz mono PCM16 microphone audio and emits provider-agnostic
events (speech boundaries, transcripts, agent text, agent audio).  The session layer
(`backend/app/session.py`) owns the WebSocket, telemetry and memory, so every
architecture is measured by exactly the same code path.
"""
from __future__ import annotations

import abc
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

INPUT_SAMPLE_RATE = 16_000  # what the client sends
CLIENT_OUTPUT_SAMPLE_RATE = 24_000  # what the client plays


@dataclass
class SessionContext:
    """Everything a provider needs to run one conversation.  Identical across providers."""

    session_id: str
    user_id: str
    language: str  # "he" | "en" | "auto"
    system_prompt: str
    opener_instruction: Optional[str]  # set when the agent must speak first (journey start)
    proactive: bool = True
    journey: dict = field(default_factory=dict)
    profile: dict = field(default_factory=dict)
    options: dict = field(default_factory=dict)  # per-session overrides (endpointing, voice...)


@dataclass
class ProviderEvent:
    type: str
    data: dict = field(default_factory=dict)
    audio: Optional[bytes] = None  # PCM16 mono
    sample_rate: int = CLIENT_OUTPUT_SAMPLE_RATE
    t: float = field(default_factory=time.monotonic)


EmitFn = Callable[[ProviderEvent], Awaitable[None]]

# Event types emitted by providers --------------------------------------------------
USER_SPEECH_STARTED = "user.speech_started"  # {audio_ms}
USER_SPEECH_STOPPED = "user.speech_stopped"  # {audio_end_ms}  (true end of speech in stream time)
USER_TRANSCRIPT = "user.transcript"  # {text, final, language}
AGENT_TURN_STARTED = "agent.turn_started"  # {response_id, proactive}
AGENT_TEXT = "agent.text"  # {response_id, delta}
AGENT_AUDIO = "agent.audio"  # {response_id} + audio
AGENT_TURN_DONE = "agent.turn_done"  # {response_id, text, interrupted, usage}
AGENT_INTERRUPTED = "agent.interrupted"  # {response_id, detect_audio_ms}
METRIC = "metric"  # {name, value_ms, response_id}
USAGE = "usage"  # {kind, ...} raw units for cost accounting
END_REQUESTED = "session.end_requested"  # {reason}
LOOKUP_REQUESTED = "session.lookup_requested"  # {response_id}: the reply carried the lookup marker (the caller searches)
ERROR = "error"  # {message, fatal}


class VoiceProvider(abc.ABC):
    """Base class for all architectures (commercial, modular, speech-to-speech, hybrid)."""

    #: architecture family used in reports: commercial | modular | speech_to_speech | hybrid | mock
    architecture: str = "unknown"

    def __init__(self, provider_id: str, config: dict):
        self.provider_id = provider_id
        self.config = config
        self._emit: Optional[EmitFn] = None
        self.ctx: Optional[SessionContext] = None
        # Estimated wall-clock time until which the client is still playing agent audio.
        self._playback_until = 0.0

    # -- lifecycle ---------------------------------------------------------------
    async def start(self, ctx: SessionContext, emit: EmitFn) -> None:
        self.ctx = ctx
        self._emit = emit
        await self._start()

    @abc.abstractmethod
    async def _start(self) -> None: ...

    @abc.abstractmethod
    async def push_audio(self, pcm16: bytes) -> None:
        """Feed 16 kHz mono PCM16 microphone audio (any frame size)."""

    async def send_text(self, text: str) -> None:
        """Optional typed user input (debug / accessibility)."""
        raise NotImplementedError

    async def interrupt(self) -> None:
        """Client-requested cancel of the current agent turn."""

    async def set_note(self, text: str, turns: int = 1, max_user_words: int | None = None, min_streak: int = 1) -> None:
        """Optional: a note from the caller for the model's next `turns` turns (never spoken, never stored in history).
        Providers without a note channel ignore it."""

    @abc.abstractmethod
    async def close(self) -> None: ...

    def describe(self) -> dict:
        """Static description recorded in telemetry (models, versions, hosting)."""
        return {"provider_id": self.provider_id, "architecture": self.architecture}

    # -- helpers -----------------------------------------------------------------
    async def emit(self, type_: str, audio: bytes | None = None, sample_rate: int = CLIENT_OUTPUT_SAMPLE_RATE, **data: Any) -> None:
        if audio is not None:
            now = time.monotonic()
            dur = len(audio) / 2 / sample_rate
            self._playback_until = max(self._playback_until, now) + dur
        if self._emit is not None:
            await self._emit(ProviderEvent(type=type_, data=data, audio=audio, sample_rate=sample_rate))

    def client_is_playing(self) -> bool:
        return time.monotonic() < self._playback_until

    def reset_playback_clock(self) -> None:
        self._playback_until = 0.0

    def playback_remaining_s(self) -> float:
        return max(0.0, self._playback_until - time.monotonic())
