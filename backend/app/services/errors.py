"""Service-layer errors. Routers map them to HTTP; services never import FastAPI."""

from __future__ import annotations


class ServiceError(Exception):
    """Base class."""


class NotFound(ServiceError):
    """Missing *or* in another household: indistinguishable on purpose (ADR-0003: 404)."""


class Forbidden(ServiceError):
    pass


class InvalidJoin(ServiceError):
    """Unknown slug, malformed code, wrong code or closed night: one answer for all, so
    the endpoint is not an oracle for which household slugs exist."""
