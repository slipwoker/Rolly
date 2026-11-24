"""Lightweight shared memory + session store (SQLite).

One store is shared by every provider so that the same user context is injected no
matter which architecture is under test.  SQLite is enough for a POC; the schema maps
directly onto Postgres for production.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, profile TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', session_id TEXT,
  created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id, kind, status);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  blind_label TEXT, language TEXT, journey TEXT, started_at REAL NOT NULL, ended_at REAL,
  summary TEXT, stats TEXT, provider_info TEXT, tag TEXT);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, idx INTEGER NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, t_wall REAL NOT NULL, meta TEXT);
CREATE INDEX IF NOT EXISTS idx_turn_session ON turns(session_id, idx);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, t_wall REAL NOT NULL,
  t_mono REAL NOT NULL, type TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS idx_event_session ON events(session_id, type);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, evaluator TEXT, blind_label TEXT,
  provider_id TEXT, scores TEXT NOT NULL, comments TEXT, created_at REAL NOT NULL);
"""

MEMORY_KINDS = ("summary", "open_topic", "action_item", "fact", "goal", "preference")


class MemoryStore:
    def __init__(self, path: str | os.PathLike):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.executescript(SCHEMA)

    # -- low level ---------------------------------------------------------------
    def _exec(self, sql: str, args: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, tuple(args))

    def _many(self, sql: str, rows: list[tuple]) -> None:
        with self._lock:
            self._db.execute("BEGIN")
            try:
                self._db.executemany(sql, rows)
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def _all(self, sql: str, args: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, tuple(args)).fetchall()]

    # -- users -------------------------------------------------------------------
    def upsert_user(self, user_id: str, profile: dict) -> None:
        self._exec(
            "INSERT INTO users(user_id, profile, updated_at) VALUES(?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET profile=excluded.profile, updated_at=excluded.updated_at",
            (user_id, json.dumps(profile, ensure_ascii=False), time.time()),
        )

    def get_user(self, user_id: str) -> Optional[dict]:
        rows = self._all("SELECT profile FROM users WHERE user_id=?", (user_id,))
        return json.loads(rows[0]["profile"]) if rows else None

    def list_users(self) -> list[dict]:
        return [{"user_id": r["user_id"], **json.loads(r["profile"])} for r in self._all("SELECT * FROM users ORDER BY user_id")]

    # -- memories ----------------------------------------------------------------
    def add_memory(self, user_id: str, kind: str, content: str, session_id: str | None = None, created_at: float | None = None) -> int:
        assert kind in MEMORY_KINDS, kind
        cur = self._exec(
            "INSERT INTO memories(user_id, kind, content, session_id, created_at) VALUES(?,?,?,?,?)",
            (user_id, kind, content, session_id, created_at or time.time()),
        )
        return int(cur.lastrowid)

    def get_memories(self, user_id: str, kind: str | None = None, status: str = "active", limit: int = 20) -> list[dict]:
        if kind:
            return self._all(
                "SELECT * FROM memories WHERE user_id=? AND kind=? AND status=? ORDER BY created_at DESC LIMIT ?",
                (user_id, kind, status, limit),
            )
        return self._all(
            "SELECT * FROM memories WHERE user_id=? AND status=? ORDER BY created_at DESC LIMIT ?", (user_id, status, limit)
        )

    def set_memory_status(self, memory_id: int, status: str) -> None:
        self._exec("UPDATE memories SET status=? WHERE id=?", (status, memory_id))

    def resolve_memories(self, user_id: str, kind: str, contents: list[str]) -> int:
        """Mark open topics / action items as resolved when a summary says they were closed."""
        n = 0
        for row in self.get_memories(user_id, kind, limit=100):
            if any(_similar(row["content"], c) for c in contents):
                self.set_memory_status(row["id"], "resolved")
                n += 1
        return n

    # -- sessions / turns --------------------------------------------------------
    def create_session(self, session_id: str, user_id: str, provider_id: str, blind_label: str | None, language: str,
                       journey: dict, provider_info: dict, tag: str | None = None) -> None:
        self._exec(
            "INSERT INTO sessions(session_id, user_id, provider_id, blind_label, language, journey, started_at, provider_info, tag) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (session_id, user_id, provider_id, blind_label, language, json.dumps(journey), time.time(),
             json.dumps(provider_info), tag),
        )

    def end_session(self, session_id: str, summary: dict | None, stats: dict | None) -> None:
        self._exec(
            "UPDATE sessions SET ended_at=?, summary=?, stats=? WHERE session_id=?",
            (time.time(), json.dumps(summary, ensure_ascii=False) if summary else None,
             json.dumps(stats) if stats else None, session_id),
        )

    def add_turn(self, session_id: str, idx: int, role: str, text: str, meta: dict | None = None) -> None:
        self._exec(
            "INSERT INTO turns(session_id, idx, role, text, t_wall, meta) VALUES(?,?,?,?,?,?)",
            (session_id, idx, role, text, time.time(), json.dumps(meta or {}, ensure_ascii=False)),
        )

    def get_turns(self, session_id: str) -> list[dict]:
        return self._all("SELECT idx, role, text, t_wall, meta FROM turns WHERE session_id=? ORDER BY idx", (session_id,))

    def get_session(self, session_id: str) -> Optional[dict]:
        rows = self._all("SELECT * FROM sessions WHERE session_id=?", (session_id,))
        if not rows:
            return None
        s = rows[0]
        for k in ("journey", "summary", "stats", "provider_info"):
            s[k] = json.loads(s[k]) if s.get(k) else None
        return s

    def list_sessions(self, limit: int = 100, tag: str | None = None) -> list[dict]:
        if tag:
            rows = self._all("SELECT * FROM sessions WHERE tag=? ORDER BY started_at DESC LIMIT ?", (tag, limit))
        else:
            rows = self._all("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?", (limit,))
        for s in rows:
            for k in ("journey", "summary", "stats", "provider_info"):
                s[k] = json.loads(s[k]) if s.get(k) else None
        return rows

    # -- telemetry events --------------------------------------------------------
    def add_events(self, rows: list[tuple]) -> None:
        self._many("INSERT INTO events(session_id, t_wall, t_mono, type, data) VALUES(?,?,?,?,?)", rows)

    def get_events(self, session_id: str, type_: str | None = None) -> list[dict]:
        if type_:
            rows = self._all("SELECT * FROM events WHERE session_id=? AND type=? ORDER BY id", (session_id, type_))
        else:
            rows = self._all("SELECT * FROM events WHERE session_id=? ORDER BY id", (session_id,))
        for r in rows:
            r["data"] = json.loads(r["data"]) if r["data"] else {}
        return rows

    # -- ratings -----------------------------------------------------------------
    def add_rating(self, session_id: str | None, evaluator: str, blind_label: str, provider_id: str, scores: dict, comments: str) -> int:
        cur = self._exec(
            "INSERT INTO ratings(session_id, evaluator, blind_label, provider_id, scores, comments, created_at) VALUES(?,?,?,?,?,?,?)",
            (session_id, evaluator, blind_label, provider_id, json.dumps(scores), comments, time.time()),
        )
        return int(cur.lastrowid)

    def list_ratings(self) -> list[dict]:
        rows = self._all("SELECT * FROM ratings ORDER BY id")
        for r in rows:
            r["scores"] = json.loads(r["scores"])
        return rows

    # -- privacy / retention -----------------------------------------------------
    def purge_older_than(self, days: float) -> dict:
        """Delete transcripts and telemetry older than `days`.  Summaries (derived memory) are kept
        until the user deletes them explicitly."""
        cutoff = time.time() - days * 86400
        old = [r["session_id"] for r in self._all("SELECT session_id FROM sessions WHERE started_at < ?", (cutoff,))]
        for sid in old:
            self._exec("DELETE FROM turns WHERE session_id=?", (sid,))
            self._exec("DELETE FROM events WHERE session_id=?", (sid,))
        return {"sessions_purged": len(old)}

    def delete_user_data(self, user_id: str) -> dict:
        """Right-to-erasure: remove everything linked to a user (profile, memory, transcripts, telemetry)."""
        sids = [r["session_id"] for r in self._all("SELECT session_id FROM sessions WHERE user_id=?", (user_id,))]
        for sid in sids:
            self._exec("DELETE FROM turns WHERE session_id=?", (sid,))
            self._exec("DELETE FROM events WHERE session_id=?", (sid,))
            self._exec("DELETE FROM ratings WHERE session_id=?", (sid,))
        self._exec("DELETE FROM sessions WHERE user_id=?", (user_id,))
        self._exec("DELETE FROM memories WHERE user_id=?", (user_id,))
        self._exec("DELETE FROM users WHERE user_id=?", (user_id,))
        return {"sessions_deleted": len(sids)}

    def close(self) -> None:
        with self._lock:
            self._db.close()


def _similar(a: str, b: str) -> bool:
    ta, tb = set(a.lower().split()), set(b.lower().split())
    if not ta or not tb:
        return False
    return len(ta & tb) / min(len(ta), len(tb)) >= 0.6
