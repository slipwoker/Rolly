"""The relay provider against a real GPU-worker process (mock pipeline: no models needed)."""
import asyncio
import os
import threading
import time

import pytest

from .conftest import free_port


@pytest.fixture(scope="module")
def worker():
    import uvicorn

    os.environ.update({"ROLLY_GPU_API_KEY": "relay-test-key", "ROLLY_WORKER_PROVIDER": "mock"})
    from backend.gpu_worker import app, state

    port = free_port()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(200):
        if srv.started and "load_s" in state:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/v1"
    srv.should_exit = True
    th.join(timeout=5)


def _ctx():
    from providers.base import SessionContext
    return SessionContext(session_id="t1", user_id="noa", language="en", system_prompt="You are a test.",
                          opener_instruction="[journey_start]", proactive=True)


@pytest.mark.asyncio
async def test_relay_forwards_audio_and_events_both_ways(worker):
    from providers import base
    from providers.remote import RemoteProvider

    p = RemoteProvider("selfhosted-gpu", {"url": worker, "api_key": "relay-test-key"})
    info = p.describe()
    assert info["pipeline_host"] == "127.0.0.1" and info["relay"] == "websocket"
    events = []

    async def emit(ev):
        events.append(ev)

    await p.start(_ctx(), emit)
    silence = b"\x00\x00" * 320
    for _ in range(100):  # 2 s of microphone audio in 20 ms frames
        await p.push_audio(silence)
        await asyncio.sleep(0.02)
    await p.close()
    audio = [e for e in events if e.type == base.AGENT_AUDIO]
    assert audio and all(e.audio and len(e.audio) % 2 == 0 for e in audio), "agent audio must arrive as PCM16"
    assert any(e.type == base.AGENT_TURN_STARTED for e in events), "non-audio events must be relayed too"
    assert p.playback_remaining_s() >= 0


@pytest.mark.asyncio
async def test_relay_is_refused_without_the_token(worker):
    from providers.remote import RemoteProvider

    p = RemoteProvider("selfhosted-gpu", {"url": worker, "api_key": "wrong"})

    async def emit(ev):
        pass

    with pytest.raises(Exception):
        await p.start(_ctx(), emit)
    await p.close()


@pytest.mark.asyncio
async def test_worker_accepts_a_note_and_keeps_the_session_going(worker):
    """`{"type":"note"}` is taken by the worker without starting or breaking a turn (a provider without a note channel ignores it)."""
    import json

    import websockets

    from providers.remote import session_urls
    ws_url, _ = session_urls(worker)
    async with websockets.connect(ws_url, additional_headers={"Authorization": "Bearer relay-test-key"}, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "ctx": {"session_id": "n1", "user_id": "noa", "language": "en", "system_prompt": "test",
                                                           "opener_instruction": None, "proactive": False}}))
        assert json.loads(await asyncio.wait_for(ws.recv(), timeout=10))["type"] == "ready"
        await ws.send(json.dumps({"type": "note", "text": "About three minutes are left.", "turns": 3}))
        await ws.send(json.dumps({"type": "note"}))  # malformed: no text, no turns
        await ws.send(b"\x00\x00" * 320)  # the session still takes audio afterwards
        await ws.send(json.dumps({"type": "close"}))
        with pytest.raises(websockets.ConnectionClosed):
            while True:
                await asyncio.wait_for(ws.recv(), timeout=10)
