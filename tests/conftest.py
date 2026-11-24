import asyncio
import os
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    """Run the real FastAPI app on a random port with an isolated data directory."""
    import uvicorn

    data = tmp_path_factory.mktemp("rolly-data")
    os.environ.update({"ROLLY_DATA_DIR": str(data), "ROLLY_ADMIN_TOKEN": "test-admin",
                       "ROLLY_UTILITY_LLM_BASE_URL": "http://127.0.0.1:9/v1"})  # unreachable: forces the fallback summary
    from backend.app.main import app

    port = free_port()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield {"http": f"http://127.0.0.1:{port}", "ws": f"ws://127.0.0.1:{port}/ws", "data": data}
    srv.should_exit = True
    th.join(timeout=5)


@pytest.fixture
def models_available():
    if not (ROOT / "models/silero_vad.onnx").exists():
        pytest.skip("models not downloaded (run infrastructure/download_models.sh)")
