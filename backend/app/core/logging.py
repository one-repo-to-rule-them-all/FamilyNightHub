"""structlog configuration. Copied from OrderUp app/core/logging.py @ 2f86cd8.

JSON in staging/production, pretty console elsewhere. request_id is bound per request
by RequestIDMiddleware via contextvars.
"""

from __future__ import annotations

import logging

import structlog

from app.core.config import settings


def configure_logging() -> None:
    renderer = (
        structlog.processors.JSONRenderer()
        if settings.ENVIRONMENT in ("staging", "production")
        else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
