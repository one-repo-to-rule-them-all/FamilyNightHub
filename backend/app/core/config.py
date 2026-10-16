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

    # --- Accounts (ADR-0002: hosts and admins sign in by magic link) ---
    MAGIC_LINK_TTL_MINUTES: int = 15
    # Signed, stateless session cookie (03-backend.md "Account sessions").
    ACCOUNT_SESSION_MAX_AGE_DAYS: int = 30
    # Where the emailed link points: the frontend's /auth/callback page.
    FRONTEND_BASE_URL: str = "http://localhost:3000"

    # --- Email ---
    # "log" prints the message (dev without MailHog, tests); "smtp" sends it. MailHog locally,
    # the provider's SMTP endpoint (e.g. Resend) on Fly with EMAIL_API_KEY as the password.
    EMAIL_MODE: Literal["log", "smtp"] = "log"
    EMAIL_FROM: str = "Family Night <movie-night@localhost>"
    SMTP_HOST: str = "localhost"
    SMTP_PORT: int = 51025
    SMTP_USERNAME: str | None = None
    EMAIL_API_KEY: str | None = None
    SMTP_STARTTLS: bool = False

    # --- Rate limiting ---
    # Magic-link requests per email address (every request counts, known or not, so the
    # limiter reveals nothing about which emails have accounts).
    MAGIC_LINK_REQUEST_LIMIT: int = 5
    MAGIC_LINK_REQUEST_WINDOW_SECONDS: int = 900
    # Join failures per join slug (never per client IP: a family shares one NAT address,
    # and forwarded headers are spoofable). 30 per 15 min puts a 6-char night code out of
    # brute-force reach; a host-approved join still works if someone burns the budget.
    JOIN_FAILURE_LIMIT: int = 30
    JOIN_FAILURE_WINDOW_SECONDS: int = 900

    # --- TMDB (03-backend.md "Candidates") ---
    # Server-only. Unset token = TMDB off: search answers 503 and the shortlist takes typed
    # titles. Locally and in CI the base URL points at the tmdb-fake service.
    TMDB_BASE_URL: str = "https://api.themoviedb.org/3"
    TMDB_READ_TOKEN: str | None = None
    TMDB_TIMEOUT_SECONDS: float = 5.0

    # --- Photos bucket (ADR-0005, 05-data.md "Object storage") ---
    # Tigris on Fly, the SeaweedFS compose service locally. Unset endpoint or keys = photos
    # off: the photo routes answer 503. Read/write on this bucket only; the backup bucket's
    # credentials (BACKUP_STORAGE_*) belong to the worker and are never read by the API.
    STORAGE_ENDPOINT: str | None = None
    # Where phones reach the bucket, if not STORAGE_ENDPOINT (e.g. the API runs inside
    # compose but presigned URLs must name localhost). SigV4 signs the host, so presigned
    # URLs are minted against this one.
    STORAGE_PUBLIC_ENDPOINT: str | None = None
    STORAGE_BUCKET: str = "fnh-photos"
    STORAGE_ACCESS_KEY_ID: str | None = None
    STORAGE_SECRET_ACCESS_KEY: str | None = None
    STORAGE_REGION: str = "auto"

    # --- HTTP ---
    CORS_ALLOWED_ORIGINS: str = "http://localhost:3000"

    # --- Worker (06-background-worker.md) ---
    # Liveness only: the tiny /health listener Fly and compose probe with curl.
    WORKER_HEALTH_PORT: int = 8081
    WORKER_JOB_TIMEOUT_SECONDS: int = 300
    # Long enough for after_job_end to read a failed job's result back from Redis.
    WORKER_KEEP_RESULT_SECONDS: int = 3600
    # Nights left in `tonight` longer than this are closed; pending uploads older than this
    # are swept.
    STALE_SESSION_HOURS: int = 24
    ORPHAN_UPLOAD_HOURS: int = 24

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
