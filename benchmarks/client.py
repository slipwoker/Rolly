"""Synthetic voice client used by the tests and the benchmark suite.

It behaves like the browser client: an always-on microphone sending 20 ms PCM16 frames
in real time (speech, silence, or a noise bed), and a receiver that timestamps every
event and audio chunk.  All latencies are measured on the client clock:

  response_latency_ms = t(first agent audio byte received) - t(last user speech sample sent)

which is the "end of user speech to first audible response" metric minus the playout
buffer of the real client (reported separately by the browser).
"""
from __future__ import annotations

import asyncio
import json
import struct
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import websockets

FRAME_MS = 20
SR_IN = 16000
SR_OUT = 24000
FRAME_SAMPLES = SR_IN * FRAME_MS // 1000


@dataclass
class AgentTurn:
    seq: int
    proactive: bool = False
    t_started: Optional[float] = None
    t_first_audio: Optional[float] = None
    t_last_audio: Optional[float] = None
    t_done: Optional[float] = None
    t_interrupted: Optional[float] = None
    audio_bytes: int = 0
    text: str = ""
    server_latency: dict = field(default_factory=dict)
    # simulated playout buffer: audio is played in real time in arrival order
    playback_end: Optional[float] = None
    underruns: int = 0  # times the playout buffer ran dry in the middle of a turn (audible gap)
    gap_ms: float = 0.0  # total duration of those gaps

    @property
    def audio_s(self) -> float:
        return self.audio_bytes / 2 / SR_OUT

    def add_audio(self, now: float, n_bytes: int) -> None:
        dur = n_bytes / 2 / SR_OUT
        if self.t_first_audio is None:
            self.t_first_audio = now
            self.playback_end = now
        if now > self.playback_end + 0.02:
            self.underruns += 1
            self.gap_ms += (now - self.playback_end) * 1000
        self.playback_end = max(self.playback_end, now) + dur
        self.t_last_audio = now
        self.audio_bytes += n_bytes


class SimClient:
    def __init__(self, url: str, start: dict, noise: Optional[np.ndarray] = None, noise_gain: float = 0.0,
                 keep_audio: bool = False):
        self.url = url
        self.start = {"type": "session.start", **start}
        self.noise = noise  # float32 16 kHz noise bed, looped
        self.noise_gain = noise_gain
        self.keep_audio = keep_audio
        self.ws = None
        self.session: dict = {}
        self.events: list[dict] = []
        self.turns: dict[int, AgentTurn] = {}
        self.user_transcripts: list[dict] = []
        self.summary: Optional[dict] = None
        self.stats: Optional[dict] = None
        self.errors: list[str] = []
        self.closed = asyncio.Event()
        self.audio_out: dict[int, bytearray] = {}
        self._speech_q: asyncio.Queue = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._noise_pos = 0
        self._new_event = asyncio.Condition()
        self.frames_sent = 0
        self.late_frames = 0
        self.t_connected: Optional[float] = None

    # -- connection --------------------------------------------------------------
    async def connect(self) -> None:
        self.ws = await websockets.connect(self.url, max_size=None, proxy=None, open_timeout=30)
        self.t_connected = time.monotonic()
        await self.ws.send(json.dumps(self.start))
        self._mic_task = asyncio.create_task(self._mic())
        self._tasks = [asyncio.create_task(self._recv()), self._mic_task]

    async def close(self, end: bool = True, wait_summary_s: float = 120) -> None:
        try:
            if end and self.ws is not None:
                self._mic_task.cancel()  # the microphone closes when the user ends the journey
                await self.ws.send(json.dumps({"type": "session.end"}))
                try:
                    await asyncio.wait_for(self.closed.wait(), timeout=wait_summary_s)
                except asyncio.TimeoutError:
                    self.errors.append("timeout waiting for session summary")
        finally:
            for t in self._tasks:
                t.cancel()
            if self.ws is not None:
                try:
                    await self.ws.close()
                except Exception:
                    pass

    # -- microphone --------------------------------------------------------------
    def _noise_frame(self) -> np.ndarray:
        if self.noise is None or self.noise_gain <= 0:
            return np.zeros(FRAME_SAMPLES, dtype=np.float32)
        idx = (self._noise_pos + np.arange(FRAME_SAMPLES)) % len(self.noise)
        self._noise_pos = (self._noise_pos + FRAME_SAMPLES) % len(self.noise)
        return self.noise[idx] * self.noise_gain

    async def _mic(self) -> None:
        """Send one frame every 20 ms, forever (speech if queued, otherwise silence/noise)."""
        current: Optional[dict] = None
        t_next = time.monotonic()
        try:
            while True:
                if current is None and not self._speech_q.empty():
                    current = self._speech_q.get_nowait()
                    current["pos"] = 0
                    current["t_start"] = time.monotonic()
                frame = self._noise_frame()
                if current is not None:
                    x = current["audio"]
                    seg = x[current["pos"]: current["pos"] + FRAME_SAMPLES]
                    frame[: len(seg)] += seg
                    current["pos"] += FRAME_SAMPLES
                pcm = (np.clip(frame, -1, 1) * 32767).astype("<i2").tobytes()
                await self.ws.send(pcm)
                self.frames_sent += 1
                if current is not None and current["pos"] >= len(current["audio"]):
                    current["t_end"] = time.monotonic()
                    current["done"].set()
                    current = None
                t_next += FRAME_MS / 1000
                delay = t_next - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                else:
                    if delay < -0.1:  # we are falling behind: do not burst, resync the clock
                        self.late_frames += 1
                        t_next = time.monotonic()
        except (asyncio.CancelledError, websockets.ConnectionClosed):
            pass

    async def say(self, audio: np.ndarray) -> dict:
        """Speak `audio` (float32, 16 kHz).  Returns {'t_start','t_end'} on the client clock."""
        item = {"audio": np.asarray(audio, dtype=np.float32), "done": asyncio.Event()}
        await self._speech_q.put(item)
        # the session can be closed by the server while we are speaking: never wait forever
        done = asyncio.create_task(item["done"].wait())
        closed = asyncio.create_task(self.closed.wait())
        await asyncio.wait({done, closed}, return_when=asyncio.FIRST_COMPLETED)
        for t in (done, closed):
            t.cancel()
        now = time.monotonic()
        return {"t_start": item.get("t_start", now), "t_end": item.get("t_end", now), "aborted": "t_end" not in item}

    async def send_json(self, **msg) -> None:
        await self.ws.send(json.dumps(msg))

    # -- receiver ----------------------------------------------------------------
    def _turn(self, seq: int) -> AgentTurn:
        if seq not in self.turns:
            self.turns[seq] = AgentTurn(seq=seq)
        return self.turns[seq]

    async def _recv(self) -> None:
        try:
            async for msg in self.ws:
                now = time.monotonic()
                if isinstance(msg, (bytes, bytearray)):
                    seq = struct.unpack("<I", msg[:4])[0]
                    turn = self._turn(seq)
                    turn.add_audio(now, len(msg) - 4)
                    if self.keep_audio:
                        self.audio_out.setdefault(seq, bytearray()).extend(msg[4:])
                else:
                    ev = json.loads(msg)
                    ev["_t"] = now
                    self.events.append(ev)
                    t = ev.get("type")
                    if t == "session.created":
                        self.session = ev
                    elif t == "agent.turn_started":
                        turn = self._turn(ev["seq"])
                        turn.t_started = now
                        turn.proactive = bool(ev.get("proactive"))
                    elif t == "agent.text":
                        self._turn(ev["seq"]).text += ev.get("delta", "")
                    elif t == "agent.turn_done":
                        turn = self._turn(ev["seq"])
                        turn.t_done = now
                        turn.text = ev.get("text") or turn.text
                    elif t == "agent.interrupted":
                        self._turn(ev["seq"]).t_interrupted = now
                    elif t == "turn.latency":
                        self._turn(ev["seq"]).server_latency = {k: v for k, v in ev.items() if k.endswith("_ms")}
                    elif t == "user.transcript" and ev.get("final"):
                        self.user_transcripts.append(ev)
                    elif t == "session.summary":
                        self.summary, self.stats = ev.get("summary"), ev.get("stats")
                    elif t == "error":
                        self.errors.append(ev.get("message", ""))
                    elif t == "session.closed":
                        self.closed.set()
                async with self._new_event:
                    self._new_event.notify_all()
        except (asyncio.CancelledError, websockets.ConnectionClosed):
            pass
        finally:
            self.closed.set()
            async with self._new_event:
                self._new_event.notify_all()

    # -- waiting helpers ---------------------------------------------------------
    async def wait_for(self, predicate, timeout: float):
        deadline = time.monotonic() + timeout
        async with self._new_event:
            while True:
                r = predicate()
                if r:
                    return r
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.closed.is_set():
                    return predicate()
                try:
                    await asyncio.wait_for(self._new_event.wait(), timeout=min(remaining, 0.25))
                except asyncio.TimeoutError:
                    pass

    async def wait_turn(self, after_t: float, timeout: float = 60, proactive: bool = False) -> Optional[AgentTurn]:
        """Wait for the first agent turn whose audio starts after `after_t`."""
        def pred():
            for turn in sorted(self.turns.values(), key=lambda x: x.seq):
                if turn.t_first_audio is not None and turn.t_first_audio >= after_t and (turn.proactive == proactive or proactive is None):
                    return turn
            return None
        return await self.wait_for(pred, timeout)

    async def wait_turn_complete(self, turn: AgentTurn, timeout: float = 120, listen: bool = True) -> AgentTurn:
        """Wait until the agent finished generating the turn and (optionally) until a real client
        would have finished playing it."""
        await self.wait_for(lambda: turn.t_done is not None or turn.t_interrupted is not None, timeout)
        while listen and turn.playback_end is not None and turn.t_interrupted is None:
            delay = turn.playback_end - time.monotonic()
            if delay <= 0:
                break
            await asyncio.sleep(min(delay, 0.25))
        return turn

    def transcript_after(self, t: float) -> Optional[dict]:
        for ev in self.user_transcripts:
            if ev["_t"] >= t:
                return ev
        return None
