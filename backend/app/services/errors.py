"""Service-layer errors. Routers map them to HTTP; services never import FastAPI."""

from __future__ import annotations


class ServiceError(Exception):
    """Base class."""


class NotFound(ServiceError):
    """Missing *or* in another household: indistinguishable on purpose (ADR-0003: 404)."""


class Forbidden(ServiceError):
    """403. `reason`, when set, says why in words a phone can show (e.g. "set a PIN")."""

    def __init__(self, reason: str | None = None) -> None:
        super().__init__(reason or "")
        self.reason = reason


class InvalidJoin(ServiceError):
    """Unknown slug, malformed code, wrong code or closed night: one answer for all, so
    the endpoint is not an oracle for which household slugs exist."""


class Conflict(ServiceError):
    """The target exists but its state forbids the change (e.g. shortlist locked). 409."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Unavailable(ServiceError):
    """An optional integration is unconfigured or down (e.g. TMDB). 503."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Invalid(ServiceError):
    """Well-formed input that breaks a domain rule (e.g. a ballot ranking 4 options), or
    an upload that fails its check (a photo of the wrong type or size). 422."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class WrongPin(ServiceError):
    """A PIN check failed and was counted (ADR-0014). The count is already written in the
    request's transaction, so the router must *return* an error response, not raise: an
    exception reaching the transaction dependency would roll the count back."""

    def __init__(self, name: str, attempts_left: int) -> None:
        super().__init__(name)
        self.name = name
        self.attempts_left = attempts_left


class PinLocked(ServiceError):
    """5 wrong PINs: every PIN check refuses until an admin approves a reset. 423. Like
    WrongPin, it may carry a just-written lock that must commit."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.name = name
