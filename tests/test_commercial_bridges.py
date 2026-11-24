"""Bridge logic of the commercial providers against LOCAL PROTOCOL EMULATORS.

These emulators replay the documented message shapes (docs/research/01-commercial-realtime.md).
They prove the bridge maps events correctly and handles barge-in; they do NOT prove
compatibility with the live services, which needs API keys (see BLOCKERS.md).
"""
import asyncio
import base64
import json

import pytest
import websockets

from providers import base
from providers.base import SessionContext
from providers.commercial.gemini_live import GeminiLiveProvider
from providers.commercial.openai_realtime import OpenAIRealtimeProvider

pytestmark = pytest.mark.asyncio
PCM_24K_1S = base64.b64encode(b"\x00\x01" * 24000).decode()


def ctx() -> SessionContext:
    return SessionContext(session_id="s", user_id="u", language="en", system_prompt="You are Rolly.",
                          opener_instruction="[journey_start] open the conversation", proactive=True)


async def collect(provider, n_types: set, timeout=5):
    events = []
    done = asyncio.Event()

    async def emit(ev):
        events.append(ev)
        if n_types <= {e.type for e in events}:
            done.set()
    return events, emit, done


async def test_openai_realtime_bridge_maps_events_and_truncates_on_barge_in():
    received = []

    async def handler(ws):
        assert ws.request.headers["Authorization"].startswith("Bearer ")
        await ws.send(json.dumps({"type": "session.created"}))
        async for raw in ws:
            m = json.loads(raw)
            received.append(m)
            if m["type"] == "response.create":
                await ws.send(json.dumps({"type": "response.created", "response": {"id": "r1"}}))
                for _ in range(3):
                    await ws.send(json.dumps({"type": "response.output_audio.delta", "response_id": "r1", "item_id": "it1", "delta": PCM_24K_1S}))
                await ws.send(json.dumps({"type": "response.output_audio_transcript.delta", "response_id": "r1", "delta": "Good morning."}))
            if m["type"] == "input_audio_buffer.append" and not any(x["type"] == "sent_vad" for x in received):
                received.append({"type": "sent_vad"})
                await asyncio.sleep(0.3)
                await ws.send(json.dumps({"type": "input_audio_buffer.speech_started", "audio_start_ms": 100}))

    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        p = OpenAIRealtimeProvider("openai-realtime", {"url": f"ws://127.0.0.1:{port}", "api_key": "test", "transcription_model": "x"})
        events, emit, done = await collect(p, {base.AGENT_TURN_STARTED, base.AGENT_AUDIO, base.AGENT_INTERRUPTED})
        await p.start(ctx(), emit)
        await asyncio.sleep(0.2)
        for _ in range(25):  # the streaming resampler needs a few frames before it outputs audio
            await p.push_audio(b"\x00\x00" * 320)
        await asyncio.wait_for(done.wait(), 5)
        await asyncio.sleep(0.1)
        await p.close()

    types = [m["type"] for m in received]
    assert types[0] == "session.update" and received[0]["session"]["audio"]["input"]["turn_detection"]["type"] == "semantic_vad"
    assert received[0]["session"]["instructions"].startswith("You are Rolly.")
    assert "response.create" in types, "proactive opener must be requested without user input"
    started = next(e for e in events if e.type == base.AGENT_TURN_STARTED)
    assert started.data["proactive"] is True
    audio = [e for e in events if e.type == base.AGENT_AUDIO]
    assert len(audio) == 3 and audio[0].sample_rate == 24000
    trunc = next(m for m in received if m["type"] == "conversation.item.truncate")
    assert trunc["item_id"] == "it1" and 0 < trunc["audio_end_ms"] < 3000, "only the audio actually played may stay in context"
    up = next(m for m in received if m["type"] == "input_audio_buffer.append")
    assert len(base64.b64decode(up["audio"])) > 0


async def test_gemini_live_bridge_setup_audio_and_interruption():
    received = []

    async def handler(ws):
        assert ws.request.headers["x-goog-api-key"] == "test"
        setup = json.loads(await ws.recv())
        received.append(setup)
        await ws.send(json.dumps({"setupComplete": {}}))
        async for raw in ws:
            m = json.loads(raw)
            received.append(m)
            if "clientContent" in m:
                await ws.send(json.dumps({"sessionResumptionUpdate": {"newHandle": "h1", "resumable": True}}))
                await ws.send(json.dumps({"serverContent": {"modelTurn": {"parts": [{"inlineData": {"data": PCM_24K_1S}}]}}}))
                await ws.send(json.dumps({"serverContent": {"outputTranscription": {"text": "Boker tov."}}}))
            if "realtimeInput" in m and not any("flag" in x for x in received):
                received.append({"flag": 1})
                await ws.send(json.dumps({"serverContent": {"interrupted": True}}))

    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        p = GeminiLiveProvider("gemini-live", {"url": f"ws://127.0.0.1:{port}", "api_key": "test", "vad_model": "missing.onnx"})
        events, emit, done = await collect(p, {base.AGENT_TURN_STARTED, base.AGENT_AUDIO, base.AGENT_TEXT, base.AGENT_INTERRUPTED})
        await p.start(ctx(), emit)
        await asyncio.sleep(0.2)
        await p.push_audio(b"\x00\x00" * 320)
        await asyncio.wait_for(done.wait(), 5)
        await p.close()

    setup = received[0]["setup"]
    assert setup["model"] == "models/gemini-3.8-live" and setup["generationConfig"]["responseModalities"] == ["AUDIO"]
    assert "contextWindowCompression" in setup, "context compression bounds per-turn re-billing on long sessions"
    assert any("clientContent" in m for m in received), "proactive opener is triggered by the app, not by the model"
    assert next(e for e in events if e.type == base.AGENT_TURN_STARTED).data["proactive"] is True
    assert p._handle == "h1"
    mic = next(m for m in received if "realtimeInput" in m)
    assert mic["realtimeInput"]["audio"]["mimeType"] == "audio/pcm;rate=16000"
