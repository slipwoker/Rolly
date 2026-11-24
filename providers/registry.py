"""Provider registry: named provider configurations loaded from config/providers.yaml.

Each entry maps a provider id to an implementation class (`type`) plus its settings.
`${VAR}` / `${VAR:-default}` are expanded from the environment so that no credential is
ever written to the config file.
"""
from __future__ import annotations

import hashlib
import os
import re
import string
from pathlib import Path
from typing import Any

import yaml

from .base import VoiceProvider

_ENV = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


def _expand(value: Any) -> Any:
    if isinstance(value, str):
        def sub(m: re.Match) -> str:
            return os.environ.get(m.group(1), m.group(2) if m.group(2) is not None else "")
        out = _ENV.sub(sub, value)
        if out != value and re.fullmatch(r"-?\d+", out):
            return int(out)
        if out != value and re.fullmatch(r"-?\d+\.\d+", out):
            return float(out)
        return out
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand(v) for v in value]
    return value


def _load_class(type_: str):
    if type_ == "mock":
        from .mock import MockProvider
        return MockProvider
    if type_ == "modular":
        from .modular.pipeline import ModularProvider
        return ModularProvider
    if type_ == "openai_realtime":
        from .commercial.openai_realtime import OpenAIRealtimeProvider
        return OpenAIRealtimeProvider
    if type_ == "gemini_live":
        from .commercial.gemini_live import GeminiLiveProvider
        return GeminiLiveProvider
    raise ValueError(f"unknown provider type {type_}")


class ProviderRegistry:
    def __init__(self, path: str | os.PathLike, blind_salt: str = "rolly"):
        self.path = Path(path)
        self.blind_salt = blind_salt
        raw = yaml.safe_load(self.path.read_text(encoding="utf-8")) or {}
        self.defaults = _expand(raw.get("defaults") or {})
        self.entries: dict[str, dict] = {}
        for pid, cfg in (raw.get("providers") or {}).items():
            cfg = _expand(cfg)
            if cfg.get("disabled"):
                continue
            self.entries[pid] = cfg
        self._labels = self._make_labels()

    # -- availability ------------------------------------------------------------
    def missing_requirements(self, pid: str) -> list[str]:
        cfg = self.entries[pid]
        missing = [v for v in cfg.get("requires_env", []) if not os.environ.get(v)]
        for p in cfg.get("requires_files", []):
            if not Path(p).exists():
                missing.append(p)
        return missing

    def available(self, pid: str) -> bool:
        return pid in self.entries and not self.missing_requirements(pid)

    # -- blind labels ------------------------------------------------------------
    def _make_labels(self) -> dict[str, str]:
        """Stable anonymous labels ("Agent K") that do not reveal the provider or its order in the file."""
        ids = sorted(self.entries, key=lambda pid: hashlib.sha256(f"{self.blind_salt}:{pid}".encode()).hexdigest())
        letters = string.ascii_uppercase
        return {pid: f"Agent {letters[i % 26]}{'' if i < 26 else i // 26}" for i, pid in enumerate(ids)}

    def label(self, pid: str) -> str:
        return self._labels[pid]

    def resolve(self, id_or_label: str) -> str:
        if id_or_label in self.entries:
            return id_or_label
        for pid, lab in self._labels.items():
            if lab.lower() == id_or_label.lower():
                return pid
        raise KeyError(id_or_label)

    def listing(self, reveal: bool = False, include_test: bool = False) -> list[dict]:
        out = []
        for pid, cfg in self.entries.items():
            if cfg.get("test_only") and not include_test and not reveal:
                continue
            item = {"label": self.label(pid), "available": self.available(pid), "languages": cfg.get("languages", ["he", "en"])}
            if reveal:
                item.update({"id": pid, "type": cfg["type"], "architecture": cfg.get("architecture"),
                             "description": cfg.get("description", ""), "missing": self.missing_requirements(pid),
                             "test_only": bool(cfg.get("test_only"))})
            out.append(item)
        return sorted(out, key=lambda x: x["label"])

    # -- construction ------------------------------------------------------------
    def create(self, pid: str) -> VoiceProvider:
        cfg = dict(self.entries[pid])
        missing = self.missing_requirements(pid)
        if missing:
            raise RuntimeError(f"provider '{pid}' is not available; missing: {', '.join(missing)}")
        cls = _load_class(cfg["type"])
        return cls(pid, cfg)
