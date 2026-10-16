"""Application settings: the single source of truth for the env-var contract.

Every variable in docs/architecture/02-environments.md ("Secrets map") is read here.
Integration credentials are optional so the app boots in dev with only the data plane
set; the slices that use them enforce presence at their own boundary.
Shape copied from OrderUp app/core/config.py @ 2f86cd8.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # "test" unlocks test-only seams (e.g. the tie-break seed header). Never set it on Fly.
    ENVIRONMENT: Literal["development", "test", "staging", "production"] = "development"

    # --- Data plane ---
    # DATABASE_URL is the NON-OWNER app role `fnh_app` (no BYPASSRLS): RLS only binds an
    # ordinary role. MIGRATION_DATABASE_URL is the owner role, used by Alembic only.
    DATABASE_URL: str = "postgresql+asyncpg://fnh_app:fnh_app@localhost:55432/fnh_dev"
    MIGRATION_DATABASE_URL: str = "postgresql+psycopg2://fnh:fnh@localhost:55432/fnh_dev"
    # Upstash supports DB 0 only: ARQ (`arq:` prefix) and SSE (`session:*`) share it.
    REDIS_URL: str = "redis://localhost:56379/0"

    # --- Auth secrets (dev placeholders; real values are fly secrets) ---
    SESSION_SECRET: str = "dev-insecure-session-secret"
    DEVICE_TOKEN_PEPPER: str = "dev-insecure-device-pepper"

    # --- Devices (ADR-0002) ---
    DEVICE_COOKIE_MAX_AGE_DAYS: int = 365
    # Sliding expiry: re-issue the cookie and stamp last_seen_at at most this often.
    DEVICE_TOUCH_INTERVAL_SECONDS: int = 3600

    # --- Rate limiting ---
    # Join failures per join slug (never per client IP: a family shares one NAT address,
    # and forwarded headers are spoofable). 30 per 15 min puts a 6-char night code out of
    # brute-force reach; a host-approved join still works if someone burns the budget.
    JOIN_FAILURE_LIMIT: int = 30
    JOIN_FAILURE_WINDOW_SECONDS: int = 900

    # --- HTTP ---
    CORS_ALLOWED_ORIGINS: str = "http://localhost:3000"

    # --- Observability ---
    SENTRY_DSN: str | None = None
    SENTRY_TRACES_SAMPLE_RATE: float = 0.1

    @model_validator(mode="after")
    def _no_dev_secrets_when_deployed(self) -> Settings:
        """Refuse to boot staging/production on the placeholder secrets."""
        if self.ENVIRONMENT in ("staging", "production"):
            insecure = [
                name
                for name in ("SESSION_SECRET", "DEVICE_TOKEN_PEPPER")
                if getattr(self, name).startswith("dev-insecure")
            ]
            if insecure:
                raise ValueError(f"placeholder secrets in {self.ENVIRONMENT}: {insecure}")
        return self

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ALLOWED_ORIGINS.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
