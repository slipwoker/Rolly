"""Architecture A: Google Gemini Live API (native audio), bridged server-side over WebSocket.

Protocol per the `google-genai` SDK / cookbook as summarised in docs/research/01-commercial-realtime.md.
STATUS: implemented from the documented protocol and exercised against a local protocol
emulator (tests/test_commercial_bridges.py).  It has NOT been run against the live API in
this POC because no API key was available - see BLOCKERS.md.

Notes
  * Barge-in is decided by the service: `serverContent.interrupted` -> we flush client playback.
  * Gemini re-bills the whole context on every turn, so context-window compression is enabled
    by default to bound cost on 30-minute sessions; session resumption handles connection limits.
  * The speech boundaries of the user are not reported by the API, so `audio_end_ms` is
    estimated with a local Silero VAD purely for latency measurement (it does not drive turns).
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import uuid
from typing import Optional

import websockets

from memory.context import END_MARKER

from .. import base
from ..base import VoiceProvider

SR_OUT = 24_000
URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"


class GeminiLiveProvider(VoiceProvider):
    architecture = "commercial"

    def __init__(self, provider_id: str, config: dict):
        super().__init__(provider_id, config)
        self.model = config.get("model", "gemini-3.8-live")
        self.voice = config.get("voice", "Zephyr")
        self.url = config.get("url") or URL
        self.api_key = os.environ.get(config.get("api_key_env", "GEMINI_API_KEY")) or config.get("api_key") or "proxy-injected"
        self.silence_ms = int(config.get("silence_duration_ms", 500))
        self.compress = config.get("context_compression", True)
        self.ws = None
        self._reader: Optional[asyncio.Task] = None
        self._rid: Optional[str] = None
        self._text = ""
        self._user_text = ""
        self._handle: Optional[str] = None
        self._closed = False
        self._first_turn = True
        self._measure_vad = None

    def describe(self) -> dict:
        return {"provider_id": self.provider_id, "architecture": self.architecture, "model": self.model, "voice": self.voice,
                "transport": "websocket (server-side bridge)", "context_compression": bool(self.compress)}

    def _setup(self) -> dict:
        instructions = self.ctx.system_prompt.replace(
            f"append the exact marker {END_MARKER} at the very end. Never say the marker out loud in any other situation.",
            "call the end_conversation tool.")
        setup: dict = {
            "model": self.model if self.model.startswith("models/") else f"models/{self.model}",
            "generationConfig": {"responseModalities": ["AUDIO"],
                                 "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": self.voice}}}},
            "systemInstruction": {"parts": [{"text": instructions}]},
            "tools": [{"functionDeclarations": [{"name": "end_conversation",
                                                 "description": "Call after your closing sentence when the user clearly wants to stop."}]}],
            "realtimeInputConfig": {"automaticActivityDetection": {"silenceDurationMs": self.silence_ms},
                                    "activityHandling": "START_OF_ACTIVITY_INTERRUPTS"},
            "inputAudioTranscription": {}, "outputAudioTranscription": {},
            "sessionResumption": {"handle": self._handle} if self._handle else {},
        }
        if self.compress:
            setup["contextWindowCompression"] = {"triggerTokens": int(self.config.get("trigger_tokens", 25600)),
                                                 "slidingWindow": {"targetTokens": int(self.config.get("target_tokens", 12800))}}
        return {"setup": setup}

    async def _connect(self) -> None:
        self.ws = await websockets.connect(self.url, additional_headers={"x-goog-api-key": self.api_key}, max_size=None, open_timeout=20)
        await self.ws.send(json.dumps(self._setup()))
        first = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=20))
        if "setupComplete" not in first:
            raise RuntimeError(f"Gemini Live setup failed: {str(first)[:300]}")

    async def _start(self) -> None:
        try:
            from ..modular.vad import Endpointer, SileroVAD, VadConfig
            self._measure_vad = Endpointer(SileroVAD(self.config.get("vad_model", "models/silero_vad.onnx")),
                                           VadConfig(eager_silence_ms=0, endpoint_silence_ms=self.silence_ms))
        except Exception:
            self._measure_vad = None  # latency is then measured from the service's own events only
        await self._connect()
        self._reader = asyncio.create_task(self._read())
        if self.ctx.proactive and self.ctx.opener_instruction:
            self._proactive_next = True
            await self.ws.send(json.dumps({"clientContent": {"turns": [{"role": "user", "parts": [{"text": self.ctx.opener_instruction}]}],
                                                             "turnComplete": True}}))

    async def push_audio(self, pcm16: bytes) -> None:
        if self.ws is None or self._closed:
            return
        if self._measure_vad is not None:
            for ev in self._measure_vad.feed(pcm16, agent_audible=self.client_is_playing()):
                if ev.kind == "start":
                    await self.emit(base.USER_SPEECH_STARTED, audio_ms=ev.audio_ms)
                elif ev.kind == "end":
                    await self.emit(base.USER_SPEECH_STOPPED, audio_end_ms=ev.audio_ms)
        try:
            await self.ws.send(json.dumps({"realtimeInput": {"audio": {"data": base64.b64encode(pcm16).decode(),
                                                                       "mimeType": "audio/pcm;rate=16000"}}}))
        except websockets.ConnectionClosed:
            pass  # the reader task handles reconnection

    async def send_text(self, text: str) -> None:
        await self.ws.send(json.dumps({"clientContent": {"turns": [{"role": "user", "parts": [{"text": text}]}], "turnComplete": True}}))

    async def _read(self) -> None:
        while not self._closed:
            try:
                async for raw in self.ws:
                    await self._on_message(json.loads(raw))
            except websockets.ConnectionClosed:
                pass
            except asyncio.CancelledError:
                raise
            except Exception as e:
                await self.emit(base.ERROR, message=f"Gemini Live bridge: {e!r}"[:300], fatal=True)
                return
            if self._closed:
                return
            if not self._handle:
                await self.emit(base.ERROR, message="Gemini Live connection closed and no resumption handle is available", fatal=True)
                return
            try:  # connection lifetime reached: resume the same session on a new socket
                await self._connect()
                await self.emit(base.METRIC, name="gemini_reconnect", value_ms=0)
            except Exception as e:
                await self.emit(base.ERROR, message=f"Gemini Live resume failed: {e!r}"[:300], fatal=True)
                return

    async def _on_message(self, m: dict) -> None:
        if "sessionResumptionUpdate" in m:
            u = m["sessionResumptionUpdate"]
            if u.get("resumable") and u.get("newHandle"):
                self._handle = u["newHandle"]
        if "usageMetadata" in m:
            u = m["usageMetadata"]
            await self.emit(base.USAGE, kind="realtime", model=self.model, prompt_tokens=u.get("promptTokenCount"),
                            response_tokens=u.get("responseTokenCount"), total_tokens=u.get("totalTokenCount"),
                            prompt_details=u.get("promptTokensDetails"), response_details=u.get("responseTokensDetails"))
        if "toolCall" in m:
            calls = m["toolCall"].get("functionCalls", [])
            if any(c.get("name") == "end_conversation" for c in calls):
                await self.emit(base.END_REQUESTED, reason="user_ended")
            await self.ws.send(json.dumps({"toolResponse": {"functionResponses": [
                {"id": c.get("id"), "name": c.get("name"), "response": {"ok": True}} for c in calls]}}))
        sc = m.get("serverContent")
        if not sc:
            return
        if sc.get("interrupted"):
            if self._rid:
                rid = self._rid
                self.reset_playback_clock()
                await self.emit(base.AGENT_INTERRUPTED, response_id=rid, detect_audio_ms=None, heard_text=None)
                self._rid, self._text = None, ""
            return
        if sc.get("inputTranscription", {}).get("text"):
            self._user_text += sc["inputTranscription"]["text"]
        parts = (sc.get("modelTurn") or {}).get("parts") or []
        for p in parts:
            data = (p.get("inlineData") or {}).get("data")
            if not data:
                continue
            if self._rid is None:
                self._rid = uuid.uuid4().hex[:8]
                if self._user_text.strip():
                    await self.emit(base.USER_TRANSCRIPT, text=self._user_text.strip(), final=True, language=self.ctx.language)
                    self._user_text = ""
                proactive = getattr(self, "_proactive_next", False)
                self._proactive_next = False
                await self.emit(base.AGENT_TURN_STARTED, response_id=self._rid, proactive=proactive)
            await self.emit(base.AGENT_AUDIO, audio=base64.b64decode(data), sample_rate=SR_OUT, response_id=self._rid)
        if sc.get("outputTranscription", {}).get("text") and self._rid:
            delta = sc["outputTranscription"]["text"]
            self._text += delta
            await self.emit(base.AGENT_TEXT, response_id=self._rid, delta=delta)
        if sc.get("turnComplete") and self._rid:
            rid, text = self._rid, self._text
            self._rid, self._text = None, ""
            await self.emit(base.AGENT_TURN_DONE, response_id=rid, text=text.strip(), interrupted=False, usage={})

    async def close(self) -> None:
        self._closed = True
        if self._reader:
            self._reader.cancel()
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
