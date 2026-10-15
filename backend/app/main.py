"""FastAPI application factory.

Middleware order (03-backend.md): request ID (outermost) -> CORS -> routers. The rate
limiter (join, magic link) slots in innermost when those routes land. Error responses use
one envelope: {"error": {"code", "message", "request_id"}}.
Factory, RequestIDMiddleware and the CORS-on-500 workaround copied from OrderUp
app/main.py @ 2f86cd8.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.v1 import health
from app.api.v1.router import api_router
from app.core.config import settings
from app.core.logging import configure_logging
from app.core.redis import close_redis

log = structlog.get_logger()


def init_sentry() -> None:
    """No-op without SENTRY_DSN, so local dev and CI are unaffected."""
    if not settings.SENTRY_DSN:
        return
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration

    def _traces_sampler(sampling_context: dict[str, Any]) -> float:
        path = sampling_context.get("asgi_scope", {}).get("path", "")
        return 0.0 if path == "/api/health" else settings.SENTRY_TRACES_SAMPLE_RATE

    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENVIRONMENT,
        traces_sampler=_traces_sampler,
        # Children's names and photos live here: never ship request bodies or cookies.
        send_default_pii=False,
        integrations=[
            StarletteIntegration(transaction_style="endpoint"),
            FastApiIntegration(transaction_style="endpoint"),
        ],
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    log.info("startup", environment=settings.ENVIRONMENT)
    yield
    await close_redis()
    log.info("shutdown")


class RequestIDMiddleware:
    """Assign/propagate X-Request-ID and bind it into structlog and Sentry.

    Pure ASGI, not BaseHTTPMiddleware: the latter leaks a task when a client drops an SSE
    stream early (starlette#1012), and phones drop streams constantly (ADR-0004).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        request_id = headers.get(b"x-request-id", b"").decode() or str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [
                    *(message.get("headers") or []),
                    (b"x-request-id", request_id.encode()),
                ]
            await send(message)

        structlog.contextvars.bind_contextvars(request_id=request_id)
        if settings.SENTRY_DSN:
            import sentry_sdk

            sentry_sdk.set_tag("request_id", request_id)
        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            structlog.contextvars.clear_contextvars()


def _error_body(code: str, message: str, request_id: str | None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "request_id": request_id}}


def create_app() -> FastAPI:
    init_sentry()
    app = FastAPI(
        title="Family Night Hub API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
    )

    # add_middleware order is the reverse of execution order.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Retry-After", "X-Request-ID"],
    )
    app.add_middleware(RequestIDMiddleware)

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        rid = getattr(request.state, "request_id", None)
        body = _error_body("validation_error", "Request validation failed", rid)
        body["error"]["detail"] = jsonable_encoder(exc.errors())
        return JSONResponse(status_code=422, content=body)

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        rid = getattr(request.state, "request_id", None)
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body("http_error", str(exc.detail), rid),
            headers=exc.headers,
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        rid = getattr(request.state, "request_id", None)
        log.error("unhandled_exception", exc_info=exc)
        response = JSONResponse(
            status_code=500, content=_error_body("internal_error", "Internal server error", rid)
        )
        # Bare-Exception handlers run in ServerErrorMiddleware, outside CORSMiddleware, so
        # the browser would see an opaque network error. Add the CORS headers here (FieldPro
        # cors.py pattern, as adopted in OrderUp).
        origin = request.headers.get("origin")
        if origin in settings.cors_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Vary"] = "Origin"
        return response

    app.include_router(health.router)
    app.include_router(api_router)
    return app


app = create_app()
