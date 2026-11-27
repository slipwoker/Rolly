"""GPU worker authentication (backend/gpu_worker.py, decision P1-D40): without ROLLY_GPU_API_KEY nothing but /healthz is served."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.fixture
def worker(monkeypatch):
    import os
    # settings are read when the module is first imported; the relay tests (same process) need the mock pipeline
    os.environ.setdefault("ROLLY_WORKER_PROVIDER", "mock")
    import backend.gpu_worker as w
    return w, monkeypatch


def test_no_key_refuses_every_request_but_healthz(worker):
    w, mp = worker
    mp.setattr(w, "TOKEN", "")
    c = TestClient(w.app)
    h = c.get("/healthz")
    assert h.status_code == 200 and h.json()["auth"] == "no key"
    for headers in ({}, {"Authorization": "Bearer "}, {"Authorization": "Bearer anything"}):
        assert c.get("/v1/session/describe", headers=headers).status_code == 401
        assert c.get("/v1/voices", headers=headers).status_code == 401
        assert c.post("/v1/phonemize", headers=headers, json={"word": "מאור"}).status_code == 401
        assert c.put("/v1/voices/x.npy", headers=headers, content=b"\x93NUMPY" + b"0" * 200).status_code == 401
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect("/v1/session", headers={"Authorization": "Bearer "}) as ws:
            ws.receive_text()
    assert e.value.code == 4401


def test_with_a_key_only_the_exact_token_passes(worker):
    w, mp = worker
    mp.setattr(w, "TOKEN", "the-key")
    c = TestClient(w.app)
    assert c.get("/healthz").json()["auth"] == "bearer"
    assert c.get("/v1/voices", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert c.get("/v1/voices").status_code == 401
    assert c.get("/v1/voices", headers={"Authorization": "Bearer the-key"}).status_code == 200
    assert w._token_ok("Bearer the-key") and not w._token_ok("Bearer the-key2") and not w._token_ok(None)


def test_the_pod_scripts_require_the_key_and_keep_vllm_private_and_quiet():
    """pod_setup.sh / start_worker.sh: refuse to start the worker without the key; vLLM bound to localhost unless asked,
    never without its key when reachable from outside, and without request logging (prompts carry personal memory)."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "infrastructure"
    setup = (root / "pod_setup.sh").read_text()
    start = (root / "start_worker.sh").read_text()
    assert "--disable-log-requests" in setup
    assert '--host "$VLLM_HOST"' in setup and 'VLLM_HOST="${ROLLY_VLLM_HOST:-127.0.0.1}"' in setup
    assert "ROLLY_GPU_API_KEY is required" in setup and "ROLLY_GPU_API_KEY is required" in start
    assert "--host 0.0.0.0 --port 8081" not in setup


async def test_pipeline_does_not_log_the_users_name(capsys):
    """The name pinned for the voice used to be printed to the worker log ({'מאור': 'maʔˈoʁ'}); now only a count is."""
    from types import SimpleNamespace
    from providers.modular.pipeline import ModularProvider as cls

    pinned = {}
    me = SimpleNamespace(
        ctx=SimpleNamespace(session_id="abcdef1234", language="he",
                            profile={"name": "מאור", "name_pron": {"name": "מאור", "ipa": "maʔˈoʁ"}}),
        config={}, tts=SimpleNamespace(set_pronunciations=pinned.update))
    await cls._load_pronunciations(me)
    out = capsys.readouterr().out
    assert pinned == {"מאור": "maʔˈoʁ"}
    assert "1 name(s) pinned" in out and "מאור" not in out and "maʔˈoʁ" not in out


def test_log_retention_rotates_logs_and_deletes_copies_older_than_seven_days(tmp_path):
    import os
    import subprocess
    import time
    from pathlib import Path
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "worker.log").write_text("today's lines\n")
    (logs / "empty.log").write_text("")
    old, recent = logs / "vllm.log.20261101-000000", logs / "vllm.log.20261124-000000"
    for f, days in ((old, 8), (recent, 2)):
        f.write_text("x\n")
        t = time.time() - days * 86400
        os.utime(f, (t, t))
    script = Path(__file__).resolve().parents[1] / "infrastructure" / "log_retention.sh"
    subprocess.run(["bash", str(script), "--once"], check=True, env={**os.environ, "ROLLY_WORKSPACE": str(tmp_path)}, timeout=20)
    names = sorted(p.name for p in logs.iterdir())
    assert not old.exists() and recent.exists()
    assert (logs / "worker.log").read_text() == ""  # emptied in place (writers append)
    copies = [n for n in names if n.startswith("worker.log.")]
    assert len(copies) == 1 and (logs / copies[0]).read_text() == "today's lines\n"
    assert not any(n.startswith("empty.log.") for n in names)
