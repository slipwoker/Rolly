"""GPU worker: the models, and optionally the whole voice pipeline, behind an authenticated API.

Runs on the GPU host next to vLLM (which serves the language model).

    WS   /v1/session                 a complete conversation pipeline (VAD -> STT -> LLM -> TTS) for one
                                     session; the app relays microphone audio and gets provider events back
                                     (protocol: providers/remote.py).  One network hop per turn.
    GET  /v1/session/describe        which models and settings that pipeline uses
    POST /v1/audio/transcriptions    multipart WAV -> {"text", "language"}      (Whisper, routed by language)
    POST /v1/audio/speech            {"input", "language"?} -> raw PCM16 mono   (the pipeline's voices)
    GET  /healthz

Everything except /healthz needs `Authorization: Bearer $ROLLY_GPU_API_KEY`.
The pipeline is the provider `$ROLLY_WORKER_PROVIDER` (default `modular-selfhosted`) from
`$ROLLY_WORKER_PROVIDERS_FILE` (default `config/providers.yaml`) - the configuration that was benchmarked.

    uvicorn backend.gpu_worker:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import hmac
import io
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

from providers import base
from providers.base import SessionContext
from providers.modular.stt import get_stt
from providers.modular.tts import TTSRouter
from providers.registry import ProviderRegistry
from providers.remote import _jsonable, pack_audio

ROOT = Path(__file__).resolve().parents[1]
TOKEN = os.environ.get("ROLLY_GPU_API_KEY", "")
PROVIDERS_FILE = os.environ.get("ROLLY_WORKER_PROVIDERS_FILE", str(ROOT / "config" / "providers.yaml"))
PROVIDER_ID = os.environ.get("ROLLY_WORKER_PROVIDER", "modular-selfhosted")
MAX_SESSIONS = int(os.environ.get("ROLLY_WORKER_MAX_SESSIONS", "60"))
TTS_SAMPLE_RATE = 22050  # output rate of the HTTP speech endpoint

state: dict = {}


def _load() -> None:
    """Load the pipeline's models once; the HTTP endpoints share the same loaded instances."""
    t0 = time.monotonic()
    registry = ProviderRegistry(PROVIDERS_FILE)
    cfg = registry.entries[PROVIDER_ID]
    state["registry"] = registry
    if "stt" in cfg and "tts" in cfg:  # (the mock pipeline used by the tests has no models)
        state["stt"] = get_stt(cfg["stt"])
        tts = TTSRouter(cfg["tts"])
        tts.warm()
        state["tts"] = tts
    state["describe"] = registry.create(PROVIDER_ID).describe()  # also loads the VAD and the LLM client
    state["load_s"] = round(time.monotonic() - t0, 1)


def _load_safe() -> None:
    try:
        _load()
    except Exception as e:  # shown by /healthz; the process stays up so the cause can be read remotely
        state["load_error"] = repr(e)[:400]


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["served"] = {"stt": 0, "tts": 0, "sessions": 0}
    state["active"] = 0
    # load in the background so that /healthz answers (ready: false) while the models are loading
    loading = asyncio.get_running_loop().run_in_executor(None, _load_safe)
    yield
    loading.cancel()


app = FastAPI(title="Rolly GPU worker", lifespan=lifespan)


def _token_ok(header: str | None) -> bool:
    return not TOKEN or hmac.compare_digest((header or "").encode(), f"Bearer {TOKEN}".encode())


def _auth(request: Request) -> None:
    if not _token_ok(request.headers.get("authorization")):
        raise HTTPException(401, "invalid or missing bearer token")


@app.get("/healthz")
async def healthz():
    return {"ok": True, "ready": "load_s" in state, "stt": getattr(state.get("stt"), "name", None), "tts": getattr(state.get("tts"), "name", None),
            "pipeline": PROVIDER_ID, "load_error": state.get("load_error"), "active_sessions": state.get("active"), "load_s": state.get("load_s"), "served": state.get("served")}


@app.get("/v1/session/describe")
async def describe(request: Request):
    _auth(request)
    return state.get("describe") or {}


@app.websocket("/v1/session")
async def session(ws: WebSocket):
    """One conversation: the complete pipeline runs here, the caller only relays audio and events."""
    if not _token_ok(ws.headers.get("authorization")):
        await ws.close(code=4401)
        return
    await ws.accept()
    if "load_s" not in state or state["active"] >= MAX_SESSIONS:
        await ws.send_text(json.dumps({"type": "error", "message": "pipeline host is loading or full"}))
        await ws.close(code=4503)
        return
    provider = None
    state["active"] += 1
    try:
        start = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=15))
        c = start.get("ctx") or {}
        ctx = SessionContext(session_id=str(c.get("session_id", "")), user_id=str(c.get("user_id", "")), language=c.get("language") or "auto",
                             system_prompt=c.get("system_prompt") or "", opener_instruction=c.get("opener_instruction"),
                             proactive=bool(c.get("proactive", True)), journey=c.get("journey") or {}, profile=c.get("profile") or {},
                             options=c.get("options") or {})
        provider = await asyncio.get_running_loop().run_in_executor(None, state["registry"].create, PROVIDER_ID)
        send_lock = asyncio.Lock()

        async def emit(ev: base.ProviderEvent) -> None:
            async with send_lock:
                if ev.audio is not None:
                    await ws.send_bytes(pack_audio(ev.type, ev.data, ev.sample_rate, ev.audio))
                else:
                    await ws.send_text(json.dumps({"type": "event", "event": ev.type, "data": ev.data}, default=_jsonable))

        await ws.send_text(json.dumps({"type": "ready", "describe": provider.describe()}, default=_jsonable))
        await provider.start(ctx, emit)
        state["served"]["sessions"] += 1
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                break
            if m.get("bytes") is not None:
                await provider.push_audio(m["bytes"])
            elif m.get("text"):
                msg = json.loads(m["text"])
                if msg.get("type") == "text":
                    await provider.send_text(str(msg.get("text", ""))[:2000])
                elif msg.get("type") == "interrupt":
                    await provider.interrupt()
                elif msg.get("type") == "close":
                    break
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
        pass
    finally:
        state["active"] -= 1
        if provider is not None:
            try:
                await asyncio.wait_for(provider.close(), timeout=10)
            except Exception:
                pass
        try:
            await ws.close()
        except Exception:
            pass


@app.post("/v1/audio/transcriptions")
async def transcriptions(request: Request):
    _auth(request)
    if state.get("stt") is None:
        raise HTTPException(503, "models are not loaded")
    form = await request.form()
    upload = form.get("file")
    if upload is None:
        raise HTTPException(400, "multipart field 'file' is required")
    data = await upload.read()
    try:
        audio, sr = sf.read(io.BytesIO(data), dtype="float32")
    except Exception as e:
        raise HTTPException(400, f"cannot decode audio: {e!r}"[:200])
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        audio = soxr.resample(audio, sr, 16000)
    language = form.get("language")
    res = await state["stt"].transcribe(np.ascontiguousarray(audio, dtype=np.float32), language if language in ("he", "en") else None)
    state["served"]["stt"] += 1
    return {"text": res.text, "language": res.language, "duration": round(res.audio_s, 3),
            "x_timings_ms": {"stt": round(res.ms, 1), "queue": round(res.queue_ms, 1), "detect": round(res.detect_ms, 1)}}


@app.post("/v1/audio/speech")
async def speech(request: Request):
    _auth(request)
    if state.get("tts") is None:
        raise HTTPException(503, "models are not loaded")
    body = await request.json()
    text = (body.get("input") or "").strip()
    if not text:
        raise HTTPException(400, "'input' is required")
    hint = body.get("language")

    async def gen():
        async for pcm, sr, _lang, _engine in state["tts"].synth(text, hint):
            if sr != TTS_SAMPLE_RATE:  # keep one output rate for the client
                x = np.frombuffer(pcm, dtype="<i2")
                pcm = soxr.resample(x.astype(np.float32), sr, TTS_SAMPLE_RATE).astype("<i2").tobytes()
            yield pcm
    state["served"]["tts"] += 1
    return StreamingResponse(gen(), media_type="audio/pcm", headers={"X-Sample-Rate": str(TTS_SAMPLE_RATE)})


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    return JSONResponse({"error": repr(exc)[:300]}, status_code=500)
