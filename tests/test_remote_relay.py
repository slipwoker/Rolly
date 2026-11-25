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
