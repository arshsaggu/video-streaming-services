"""Configuration. Secrets are read from files (Docker secrets), never from plain env vars or code."""
import os
from dataclasses import dataclass
from pathlib import Path


def _read_secret(name: str, default: str | None = None) -> str | None:
    """Read <NAME>_FILE if set, else fall back to <NAME> (handy for local tests only)."""
    file_path = os.getenv(f"{name}_FILE")
    if file_path:
        return Path(file_path).read_text(encoding="utf-8").strip()
    return os.getenv(name, default)


@dataclass(frozen=True)
class Settings:
    db_host: str
    db_port: int
    db_user: str
    db_password: str
    db_name: str
    jwt_secret: str
    jwt_ttl_seconds: int
    hash_method: str
    admin_password: str | None
    allow_registration: bool
    login_max_failures: int
    login_window_seconds: int


def load_settings() -> Settings:
    jwt_secret = _read_secret("JWT_SECRET")
    if not jwt_secret or len(jwt_secret) < 32:
        raise RuntimeError("JWT_SECRET(_FILE) must be set and at least 32 characters")
    return Settings(
        db_host=os.getenv("DB_HOST", "mysql"),
        db_port=int(os.getenv("DB_PORT", "3306")),
        db_user=os.getenv("DB_USER", "auth_svc"),
        db_password=_read_secret("DB_PASSWORD", "") or "",
        db_name=os.getenv("DB_NAME", "auth"),
        jwt_secret=jwt_secret,
        jwt_ttl_seconds=int(os.getenv("JWT_TTL_SECONDS", "3600")),
        # scrypt (memory-hard). Cost is deliberately high; see report for its CPU impact.
        hash_method=os.getenv("PASSWORD_HASH_METHOD", "scrypt:32768:8:1"),
        admin_password=_read_secret("ADMIN_PASSWORD"),
        allow_registration=os.getenv("ALLOW_REGISTRATION", "true").lower() == "true",
        login_max_failures=int(os.getenv("LOGIN_MAX_FAILURES", "5")),
        login_window_seconds=int(os.getenv("LOGIN_WINDOW_SECONDS", "300")),
    )
