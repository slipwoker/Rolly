"""Remote provider: the whole voice pipeline runs on another host, this app only relays.

    browser <-> app (sessions, memory, telemetry) <== one WebSocket ==> GPU host (VAD, STT, LLM, TTS)

Why: with the pipeline in the app and the models on the GPU host, every turn paid three
network round trips (speech-to-text, language model, voice).  Measured on the hosted
deployment that made replies about twice as slow as with everything on one machine.
Here the microphone audio is forwarded as it arrives and the provider events come back
on the same connection, so a turn pays the network once.

Wire protocol (see `backend/gpu_worker.py`, endpoint `/v1/session`):
  app -> host   text  {"type":"start","ctx":{...SessionContext...}}
                bytes PCM16 16 kHz mono microphone audio
                text  {"type":"text","text":...} | {"type":"interrupt"}
  host -> app   text  {"type":"ready","describe":{...}}
                text  {"type":"event","event":<provider event type>,"data":{...}}
                bytes 4-byte big-endian header length, JSON header {"event","data","sample_rate"}, PCM16 audio
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import struct
import time
from typing import Optional
from urllib.parse import urlsplit

import websockets

from . import base
from .base import VoiceProvider

_describe_cache: dict[str, tuple[float, dict]] = {}


def session_urls(base_url: str) -> tuple[str, str]:
    """(websocket URL, describe URL) for a worker base URL such as https://host/v1."""
    b = base_url.rstrip("/")
    ws = ("wss://" + b[8:]) if b.startswith("https://") else ("ws://" + b[7:]) if b.startswith("http://") else b
    return ws + "/session", b + "/session/describe"


def pack_audio(event: str, data: dict, sample_rate: int, pcm: bytes) -> bytes:
    head = json.dumps({"event": event, "data": data, "sample_rate": sample_rate}, default=_jsonable).encode()
    return struct.pack(">I", len(head)) + head + pcm


def unpack_audio(frame: bytes) -> tuple[dict, bytes]:
    n = struct.unpack(">I", frame[:4])[0]
    return json.loads(frame[4:4 + n]), frame[4 + n:]


def _jsonable(o):
    try:
        return float(o)
    except Exception:
        return str(o)


class RemoteProvider(VoiceProvider):
    architecture = "modular"

    def __init__(self, provider_id: str, config: dict):
        super().__init__(provider_id, config)
        self.architecture = config.get("architecture", "modular")
        self.ws_url, self.describe_url = session_urls(config["url"])
        key_env = config.get("api_key_env")
        self.api_key = (os.environ.get(key_env) if key_env else None) or config.get("api_key") or "not-needed"
        self.ws = None
        self._reader: Optional[asyncio.Task] = None
        self._closed = False
        self._remote_info = self._fetch_describe()

    def _fetch_describe(self) -> dict:
        """What actually runs on the remote host (models, endpointing); cached for a minute."""
        hit = _describe_cache.get(self.describe_url)
        if hit and time.monotonic() - hit[0] < 60:
            return hit[1]
        info: dict = {}
        try:
            import httpx
            r = httpx.get(self.describe_url, headers={"Authorization": f"Bearer {self.api_key}"}, timeout=5)
            if r.status_code == 200:
                info = r.json()
        except Exception:
            info = {}
        if info:
            _describe_cache[self.describe_url] = (time.monotonic(), info)
        return info

    def describe(self) -> dict:
        info = dict(self._remote_info)
        info.update({"provider_id": self.provider_id, "architecture": self.architecture,
                     "pipeline_host": urlsplit(self.ws_url).hostname, "relay": "websocket"})
        return info

    # -- lifecycle ---------------------------------------------------------------
    async def _start(self) -> None:
        self.ws = await websockets.connect(self.ws_url, additional_headers={"Authorization": f"Bearer {self.api_key}"},
                                           max_size=None, open_timeout=15, ping_interval=20, ping_timeout=20)
        await self.ws.send(json.dumps({"type": "start", "ctx": dataclasses.asdict(self.ctx)}, default=_jsonable))
        first = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=30))
        if first.get("type") != "ready":
            raise RuntimeError(f"remote pipeline refused the session: {str(first)[:200]}")
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            async for frame in self.ws:
                if isinstance(frame, (bytes, bytearray)):
                    head, pcm = unpack_audio(bytes(frame))
                    await self.emit(head["event"], audio=pcm, sample_rate=int(head.get("sample_rate") or base.CLIENT_OUTPUT_SAMPLE_RATE),
                                    **(head.get("data") or {}))
                    continue
                msg = json.loads(frame)
                if msg.get("type") != "event":
                    continue
                if msg["event"] == base.AGENT_INTERRUPTED:
                    self.reset_playback_clock()
                await self.emit(msg["event"], **(msg.get("data") or {}))
        except asyncio.CancelledError:
            raise
        except websockets.ConnectionClosed as e:
            if not self._closed:
                await self.emit(base.ERROR, message=f"connection to the pipeline host was lost ({e.code})", fatal=True)
        except Exception as e:
            if not self._closed:
                await self.emit(base.ERROR, message=f"remote pipeline: {e!r}"[:300], fatal=True)
        else:
            if not self._closed:
                await self.emit(base.ERROR, message="the pipeline host closed the session", fatal=True)

    async def push_audio(self, pcm16: bytes) -> None:
        if self.ws is not None and not self._closed:
            try:
                await self.ws.send(pcm16)
            except websockets.ConnectionClosed:
                pass  # reported once by the reader

    async def _send(self, **msg) -> None:
        if self.ws is not None and not self._closed:
            try:
                await self.ws.send(json.dumps(msg))
            except websockets.ConnectionClosed:
                pass

    async def send_text(self, text: str) -> None:
        await self._send(type="text", text=text)

    async def interrupt(self) -> None:
        await self._send(type="interrupt")

    async def close(self) -> None:
        self._closed = True
        if self._reader and not self._reader.done():
            self._reader.cancel()
        if self.ws is not None:
            try:
                await asyncio.wait_for(self.ws.close(), timeout=3)
            except Exception:
                pass
