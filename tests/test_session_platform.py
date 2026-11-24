"""Platform tests with the deterministic mock provider: transport, proactive start, latency
accounting, barge-in, blind labels, ratings, privacy defaults."""
import asyncio
import json
import urllib.request

import numpy as np
import pytest

from benchmarks.client import SimClient

pytestmark = pytest.mark.asyncio


def tone(seconds: float) -> np.ndarray:
    t = np.arange(int(16000 * seconds)) / 16000
    return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def get(url: str):
    return json.loads(urllib.request.urlopen(url, timeout=10).read())


def post(url: str, body: dict):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


async def test_proactive_opener_latency_bargein_and_summary(server):
    c = SimClient(server["ws"], {"provider": "mock", "user_id": "daniel", "tag": "test", "ephemeral": True})
    await c.connect()
    opener = await c.wait_turn(c.t_connected - 1, 5, proactive=True)
    assert opener is not None and opener.proactive, "agent must speak first without any user input"
    await c.wait_turn_complete(opener)

    said = await c.say(tone(1.5))
    turn = await c.wait_turn(said["t_end"], 5)
    client_latency = (turn.t_first_audio - said["t_end"]) * 1000
    # mock: 400 ms endpointing + 120 ms "thinking"
    assert 450 <= client_latency <= 750
    assert abs(turn.server_latency["response_latency_ms"] - client_latency) < 80, "server and client clocks must agree"

    await asyncio.sleep(0.8)  # agent is mid-sentence (3 s of audio)
    barge = asyncio.create_task(c.say(tone(1.0)))
    await c.wait_for(lambda: turn.t_interrupted, 3)
    said2 = await barge
    assert turn.t_interrupted is not None
    assert (turn.t_interrupted - said2["t_start"]) * 1000 < 300, "interruption must be signalled within 300 ms"
    await c.close()
    assert c.stats["interruptions"] == 1 and c.stats["turns_user"] >= 1
    assert c.stats["response_latency_ms"]["n"] >= 1 and c.stats["end_reason"] == "client_end"
    assert c.summary["method"] == "fallback_no_llm"  # no LLM reachable in tests: clearly marked fallback
    assert not c.errors


async def test_blind_labels_hide_provider_identity_and_ratings_roundtrip(server):
    public = get(server["http"] + "/api/providers")
    assert public["revealed"] is False
    assert all(set(p) == {"label", "available", "languages"} for p in public["providers"])
    admin = get(server["http"] + "/api/providers?token=test-admin")
    assert admin["revealed"] and any(p["id"] == "mock" for p in admin["providers"])
    mock_label = next(p["label"] for p in admin["providers"] if p["id"] == "mock")

    plan_a = get(server["http"] + "/api/eval/plan?evaluator=alice")
    assert plan_a == get(server["http"] + "/api/eval/plan?evaluator=alice"), "order is stable per evaluator"
    assert set(plan_a["criteria"]) >= {"naturalness", "hebrew_quality", "willingness_daily_commute"}

    r = post(server["http"] + "/api/ratings", {"evaluator": "alice", "label": mock_label, "scores": {"naturalness": 4, "responsiveness": 5}})
    assert r["ok"]
    with pytest.raises(Exception):
        post(server["http"] + "/api/ratings", {"evaluator": "alice", "label": mock_label, "scores": {"naturalness": 9}})
    with pytest.raises(Exception):
        get(server["http"] + "/api/ratings/export")  # un-blinded export needs the admin token
    exp = get(server["http"] + "/api/ratings/export?token=test-admin")
    assert exp["n"] == 1 and exp["ratings"][0]["provider_id"] == "mock"


async def test_journey_start_ticket_and_no_audio_retention_by_default(server):
    t = post(server["http"] + "/api/journey/start", {"provider": "mock", "user_id": "noa", "journey": {"duration_min": 10}, "ephemeral": True})
    c = SimClient(server["ws"] + f"?ticket={t['session_id']}", {})
    await c.connect()
    opener = await c.wait_turn(c.t_connected - 1, 5, proactive=True)
    assert opener is not None
    assert c.session["session_id"] == t["session_id"] and c.session["language"] == "he" and c.session["retain_audio"] is False
    await c.close()
    assert not (server["data"] / "audio").exists(), "raw audio must not be written unless explicitly enabled"
    ctx = get(server["http"] + "/api/users/noa/context")
    assert "payments module" in ctx["system_prompt"]
