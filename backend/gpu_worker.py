"""GPU worker: the heavy speech models behind a small authenticated HTTP API.

Runs on the GPU host (next to vLLM, which serves the language model).  The web
application - wherever it runs - reaches it through the modular provider's
`openai_compat` engines, so the app tier holds no model weights:

    POST /v1/audio/transcriptions   multipart WAV -> {"text", "language"}      (Whisper, routed by language)
    POST /v1/audio/speech           {"input", "language"?} -> raw PCM16 mono   (Piper English / ReNikud+Piper Hebrew)
    GET  /healthz

Every request except /healthz needs `Authorization: Bearer $ROLLY_GPU_API_KEY`.

    uvicorn backend.gpu_worker:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import io
import os
import time
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
import soxr
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from providers.modular.stt import get_stt
from providers.modular.tts import TTSRouter

TOKEN = os.environ.get("ROLLY_GPU_API_KEY", "")
DEVICE = os.environ.get("ROLLY_STT_DEVICE", "auto")
COMPUTE = os.environ.get("ROLLY_STT_COMPUTE", "default")
WORKERS = int(os.environ.get("ROLLY_STT_WORKERS", "4"))
TTS_INSTANCES = int(os.environ.get("ROLLY_TTS_INSTANCES", "4"))
TTS_SAMPLE_RATE = 22050  # both Piper voices


def _whisper(model_env: str, default: str) -> dict:
    return {"engine": "faster_whisper", "model": os.environ.get(model_env, default), "device": DEVICE, "compute_type": COMPUTE,
            "num_workers": WORKERS}


state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    t0 = time.monotonic()
    state["stt"] = get_stt({"default": "he", "detect_with": "en",
                            "he": _whisper("ROLLY_STT_MODEL_HE", "ivrit-ai/whisper-large-v3-turbo-ct2"),
                            "en": _whisper("ROLLY_STT_MODEL_EN", "deepdml/faster-whisper-large-v3-turbo-ct2")})
    tts = TTSRouter({"default": "en",
                     "en": {"engine": "sherpa", "kind": "vits", "model_dir": os.environ.get("ROLLY_TTS_EN_DIR", "models/vits-piper-en_US-lessac-medium"),
                            "model_file": os.environ.get("ROLLY_TTS_EN_FILE", "en_US-lessac-medium.onnx"), "speaker_id": 0,
                            "num_threads": 2, "num_instances": TTS_INSTANCES},
                     "he": {"engine": "renikud_piper", "model_dir": os.environ.get("ROLLY_TTS_HE_DIR", "models/hebrew-tts"),
                            "num_threads": 2, "num_instances": TTS_INSTANCES}})
    tts.warm()
    state["tts"] = tts
    state["load_s"] = round(time.monotonic() - t0, 1)
    state["served"] = {"stt": 0, "tts": 0}
    yield


app = FastAPI(title="Rolly GPU worker", lifespan=lifespan)


def _auth(request: Request) -> None:
    if TOKEN and request.headers.get("authorization", "") != f"Bearer {TOKEN}":
        raise HTTPException(401, "invalid or missing bearer token")


@app.get("/healthz")
async def healthz():
    return {"ok": True, "ready": "tts" in state, "stt": getattr(state.get("stt"), "name", None), "tts": getattr(state.get("tts"), "name", None),
            "load_s": state.get("load_s"), "served": state.get("served")}


@app.post("/v1/audio/transcriptions")
async def transcriptions(request: Request):
    _auth(request)
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
