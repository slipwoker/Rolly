"""FastAPI application: REST API, the voice WebSocket and the static test client."""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import os
import random
import time
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from memory.context import build_context, seed_store
from memory.store import MemoryStore
from providers.registry import ProviderRegistry
from telemetry.recorder import summarize
from telemetry.resources import ResourceSampler, snapshot

from .config import Settings
from .session import VoiceSession

RATING_CRITERIA = [
    "naturalness", "hebrew_quality", "english_quality", "responsiveness", "conversational_intelligence",
    "emotional_appropriateness", "interruption_handling", "overall_experience", "willingness_daily_commute",
]


def _utility_llm(settings: Settings):
    from providers.modular.llm import OpenAICompatLLM
    if not settings.utility_llm_base_url:
        return None
    return OpenAICompatLLM({"base_url": settings.utility_llm_base_url, "model": settings.utility_llm_model,
                            "api_key_env": settings.utility_llm_key_env, "name": f"utility:{settings.utility_llm_model}"})


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    store = MemoryStore(settings.db_path)
    seed_store(store)
    state = SimpleNamespace(
        settings=settings, store=store, registry=ProviderRegistry(settings.providers_file, settings.blind_salt),
        utility_llm=_utility_llm(settings), active_sessions={}, pending={}, sampler=ResourceSampler(), started=time.time(),
    )
    app.state.rolly = state
    state.sampler.start()
    purge_task = asyncio.create_task(_purge_loop(state))
    # optional warm-up so the first journey does not pay the model-loading time
    state.warming = 0

    def _warm(pid: str) -> None:
        try:
            state.registry.create(pid)
        finally:
            state.warming -= 1

    for pid in [p.strip() for p in os.environ.get("ROLLY_WARM_PROVIDERS", "").split(",") if p.strip()]:
        if state.registry.available(pid):
            state.warming += 1
            asyncio.get_running_loop().run_in_executor(None, _warm, pid)
    yield
    purge_task.cancel()
    state.sampler.stop()
    store.close()


async def _purge_loop(state) -> None:
    while True:
        try:
            state.store.purge_older_than(state.settings.transcript_retention_days)
        except Exception:
            pass
        await asyncio.sleep(86400)


app = FastAPI(title="Rolly voice-agent POC", lifespan=lifespan)


def S(request: Request):
    return request.app.state.rolly


def _check_access(state, token: str | None) -> None:
    need = state.settings.access_token
    if need and token != need and token != state.settings.admin_token:
        raise HTTPException(401, "access token required")


def _is_admin(state, token: str | None) -> bool:
    adm = state.settings.admin_token
    return bool(adm) and token == adm


# -- health / info ---------------------------------------------------------------
@app.get("/healthz")
async def healthz(request: Request):
    st = S(request)
    # `ready` turns true once the warm-up model loading has finished; load tests should wait for it
    return {"ok": True, "ready": getattr(st, "warming", 0) == 0, "active_sessions": len(st.active_sessions),
            "uptime_s": round(time.time() - st.started, 1)}


@app.get("/api/providers")
async def providers(request: Request, token: str | None = None):
    st = S(request)
    _check_access(st, token)
    return {"providers": st.registry.listing(reveal=_is_admin(st, token)), "revealed": _is_admin(st, token),
            "rating_criteria": RATING_CRITERIA}


@app.get("/api/resources")
async def resources(request: Request, token: str | None = None):
    st = S(request)
    if not _is_admin(st, token):
        raise HTTPException(403, "admin token required")
    return {"now": snapshot(), "last_60s": st.sampler.window(time.time() - 60), "active_sessions": len(st.active_sessions)}


# -- users / memory --------------------------------------------------------------
@app.get("/api/users")
async def users(request: Request, token: str | None = None):
    st = S(request)
    _check_access(st, token)
    return {"users": [{"user_id": u["user_id"], "name": u.get("name"), "preferred_language": u.get("preferred_language")}
                      for u in st.store.list_users()]}


@app.get("/api/users/{user_id}")
async def get_user(user_id: str, request: Request, token: str | None = None):
    st = S(request)
    _check_access(st, token)
    profile = st.store.get_user(user_id)
    if profile is None:
        raise HTTPException(404, "unknown user")
    return {"user_id": user_id, "profile": profile, "memory": st.store.get_memories(user_id, limit=50)}


@app.put("/api/users/{user_id}")
async def put_user(user_id: str, request: Request, token: str | None = None):
    st = S(request)
    _check_access(st, token)
    st.store.upsert_user(user_id, await request.json())
    return {"ok": True}


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str, request: Request, token: str | None = None):
    """Right to erasure: removes profile, memory, transcripts and telemetry of the user."""
    st = S(request)
    _check_access(st, token)
    return st.store.delete_user_data(user_id)


@app.get("/api/users/{user_id}/context")
async def user_context(user_id: str, request: Request, language: str | None = None, duration_min: float = 25, token: str | None = None):
    """The exact context every provider receives for this user (for inspection)."""
    st = S(request)
    _check_access(st, token)
    return build_context(st.store, user_id, language, {"duration_min": duration_min})


# -- journey start (simulated trigger) -------------------------------------------
@app.post("/api/journey/start")
async def journey_start(request: Request, token: str | None = None):
    """Simulates the event a phone would raise when a journey begins (car Bluetooth, motion, calendar).
    Returns a session ticket; the client then opens the WebSocket and the agent speaks first."""
    st = S(request)
    _check_access(st, token)
    body = await request.json()
    sid = uuid.uuid4().hex[:12]
    st.pending[sid] = {**body, "session_id": sid, "created": time.time()}
    for k in [k for k, v in st.pending.items() if time.time() - v["created"] > 300]:
        st.pending.pop(k, None)
    return {"session_id": sid, "ws_path": f"/ws?ticket={sid}"}


# -- sessions --------------------------------------------------------------------
@app.get("/api/sessions")
async def sessions(request: Request, token: str | None = None, tag: str | None = None, limit: int = 100):
    st = S(request)
    _check_access(st, token)
    admin = _is_admin(st, token)
    rows = st.store.list_sessions(limit=limit, tag=tag)
    if not admin:
        for r in rows:
            r.pop("provider_id", None)
            r.pop("provider_info", None)
    return {"sessions": rows}


@app.get("/api/sessions/{session_id}")
async def session_detail(session_id: str, request: Request, token: str | None = None):
    st = S(request)
    _check_access(st, token)
    s = st.store.get_session(session_id)
    if s is None:
        raise HTTPException(404, "unknown session")
    if not _is_admin(st, token):
        s.pop("provider_id", None)
        s.pop("provider_info", None)
    return {"session": s, "turns": st.store.get_turns(session_id)}


@app.get("/api/telemetry/summary")
async def telemetry_summary(request: Request, token: str | None = None, tag: str | None = None):
    """Aggregated latency metrics per provider (by blind label unless the admin token is given)."""
    st = S(request)
    _check_access(st, token)
    admin = _is_admin(st, token)
    groups: dict[str, dict] = {}
    for s in st.store.list_sessions(limit=5000, tag=tag):
        if not s.get("stats"):
            continue
        key = s["provider_id"] if admin else (s.get("blind_label") or "?")
        g = groups.setdefault(key, {"sessions": 0, "failed": 0, "lat": [], "det": [], "duration_s": 0.0})
        g["sessions"] += 1
        g["failed"] += 1 if s["stats"].get("end_reason") in ("error", "provider_error") else 0
        g["duration_s"] += s["stats"].get("duration_s", 0)
        for ev in st.store.get_events(s["session_id"], "agent.first_audio"):
            if ev["data"].get("response_latency_ms") is not None:
                g["lat"].append(ev["data"]["response_latency_ms"])
        for ev in st.store.get_events(s["session_id"], "agent.interrupted"):
            if ev["data"].get("interrupt_detect_ms") is not None:
                g["det"].append(ev["data"]["interrupt_detect_ms"])
    return {"providers": {k: {"sessions": g["sessions"], "failed": g["failed"], "connected_minutes": round(g["duration_s"] / 60, 2),
                              "response_latency_ms": summarize(g["lat"]), "interrupt_detect_ms": summarize(g["det"])}
                          for k, g in groups.items()}}


# -- blind human evaluation ------------------------------------------------------
@app.get("/api/eval/plan")
async def eval_plan(request: Request, evaluator: str = Query(..., min_length=1, max_length=64), token: str | None = None):
    """Per-evaluator randomised provider order.  Only anonymous labels are returned."""
    st = S(request)
    _check_access(st, token)
    labels = [p["label"] for p in st.registry.listing() if p["available"]]
    rnd = random.Random(int(hashlib.sha256(f"{st.settings.blind_salt}:{evaluator}".encode()).hexdigest(), 16))
    rnd.shuffle(labels)
    done = {r["blind_label"] for r in st.store.list_ratings() if r["evaluator"] == evaluator}
    return {"evaluator": evaluator, "order": labels, "completed": sorted(done), "criteria": RATING_CRITERIA}


@app.post("/api/ratings")
async def add_rating(request: Request, token: str | None = None):
    st = S(request)
    _check_access(st, token)
    b = await request.json()
    scores = {k: int(v) for k, v in (b.get("scores") or {}).items() if k in RATING_CRITERIA and v not in (None, "")}
    if not scores or any(not 1 <= v <= 5 for v in scores.values()):
        raise HTTPException(400, "scores must be integers 1-5 for known criteria")
    try:
        pid = st.registry.resolve(b.get("label", ""))
    except KeyError:
        raise HTTPException(400, "unknown provider label")
    rid = st.store.add_rating(b.get("session_id"), str(b.get("evaluator", "anonymous"))[:64], st.registry.label(pid), pid,
                              scores, str(b.get("comments", ""))[:2000])
    return {"ok": True, "rating_id": rid}


@app.get("/api/ratings/export")
async def ratings_export(request: Request, token: str | None = None, fmt: str = "json"):
    """Admin only: the un-blinded ratings table."""
    st = S(request)
    if not _is_admin(st, token):
        raise HTTPException(403, "admin token required")
    rows = st.store.list_ratings()
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id", "created_at", "evaluator", "blind_label", "provider_id", "session_id", *RATING_CRITERIA, "comments"])
        for r in rows:
            w.writerow([r["id"], r["created_at"], r["evaluator"], r["blind_label"], r["provider_id"], r["session_id"],
                        *[r["scores"].get(c, "") for c in RATING_CRITERIA], r["comments"]])
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    return {"ratings": rows, "n": len(rows)}


# -- voice socket ----------------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, ticket: str | None = None, token: str | None = None):
    st = ws.app.state.rolly
    await ws.accept()
    need = st.settings.access_token
    if need and token not in (need, st.settings.admin_token):
        await ws.send_text(json.dumps({"type": "error", "message": "access token required", "fatal": True}))
        await ws.close(code=4401)
        return
    try:
        if ticket and ticket in st.pending:
            start = st.pending.pop(ticket)
        else:
            first = await asyncio.wait_for(ws.receive_text(), timeout=15)
            start = json.loads(first)
            if start.get("type") != "session.start":
                await ws.send_text(json.dumps({"type": "error", "message": "expected session.start", "fatal": True}))
                await ws.close()
                return
    except (asyncio.TimeoutError, WebSocketDisconnect, json.JSONDecodeError):
        try:
            await ws.close()
        except Exception:
            pass
        return
    # provider ids may only be chosen directly by an admin; evaluators use blind labels
    if start.get("provider") in st.registry.entries and st.settings.admin_token and token != st.settings.admin_token:
        cfg = st.registry.entries[start["provider"]]
        if not cfg.get("test_only"):
            start["provider"] = st.registry.label(start["provider"])
    await VoiceSession(ws, st, start).run()


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    return JSONResponse({"error": repr(exc)[:300]}, status_code=500)


# static test client (must be mounted last)
_settings = Settings()
if _settings.frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(_settings.frontend_dir), html=True), name="frontend")
