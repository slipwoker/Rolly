"""Runtime settings (environment variables only; see .env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("ROLLY_DATA_DIR", ROOT / "data")))
    providers_file: Path = field(default_factory=lambda: Path(os.environ.get("ROLLY_PROVIDERS_FILE", ROOT / "config" / "providers.yaml")))
    frontend_dir: Path = field(default_factory=lambda: ROOT / "frontend")
    default_provider: str = field(default_factory=lambda: os.environ.get("ROLLY_DEFAULT_PROVIDER", ""))
    # --- privacy -------------------------------------------------------------
    # Raw audio is never written to disk unless this is explicitly enabled.
    retain_audio: bool = field(default_factory=lambda: _bool("ROLLY_RETAIN_AUDIO", False))
    # Transcripts + telemetry older than this are purged at start-up and once a day.  0 = keep nothing after the summary.
    transcript_retention_days: float = field(default_factory=lambda: float(os.environ.get("ROLLY_TRANSCRIPT_RETENTION_DAYS", "30")))
    store_transcripts: bool = field(default_factory=lambda: _bool("ROLLY_STORE_TRANSCRIPTS", True))
    # --- access --------------------------------------------------------------
    access_token: str = field(default_factory=lambda: os.environ.get("ROLLY_ACCESS_TOKEN", ""))  # shared secret for users (optional)
    admin_token: str = field(default_factory=lambda: os.environ.get("ROLLY_ADMIN_TOKEN", ""))  # reveals provider identities
    blind_salt: str = field(default_factory=lambda: os.environ.get("ROLLY_BLIND_SALT", "rolly-poc"))
    # --- utility LLM (summaries, judges) --------------------------------------
    utility_llm_base_url: str = field(default_factory=lambda: os.environ.get("ROLLY_UTILITY_LLM_BASE_URL", os.environ.get("ROLLY_LLM_BASE_URL", "http://127.0.0.1:8081/v1")))
    utility_llm_model: str = field(default_factory=lambda: os.environ.get("ROLLY_UTILITY_LLM_MODEL", os.environ.get("ROLLY_LLM_MODEL", "local")))
    utility_llm_key_env: str = field(default_factory=lambda: os.environ.get("ROLLY_UTILITY_LLM_KEY_ENV", "ROLLY_LLM_API_KEY"))
    max_session_minutes: float = field(default_factory=lambda: float(os.environ.get("ROLLY_MAX_SESSION_MINUTES", "75")))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "rolly.sqlite3"

    @property
    def telemetry_dir(self) -> Path:
        return self.data_dir / "telemetry"

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"
