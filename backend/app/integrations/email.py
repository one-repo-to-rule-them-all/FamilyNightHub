"""Outbound email (magic links). One SMTP path covers MailHog locally and the provider in prod.

Senders are injected through the `email_sender` dependency so tests can capture mail
without a server. Sending happens in a background task after the response, so an
existing and a non-existing address take the same time to answer.
"""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

import structlog

from app.core.config import settings

log = structlog.get_logger()


@dataclass(frozen=True)
class Email:
    to: str
    subject: str
    text: str


class EmailSender(Protocol):
    async def send(self, message: Email) -> None: ...


class LogSender:
    """Development fallback. Logs the recipient and subject, never the body: the body
    holds a live sign-in link."""

    async def send(self, message: Email) -> None:
        log.info("email_not_sent_log_mode", to=message.to, subject=message.subject)


class SmtpSender:
    async def send(self, message: Email) -> None:
        await asyncio.to_thread(self._send_sync, message)

    def _send_sync(self, message: Email) -> None:
        msg = EmailMessage()
        msg["From"] = settings.EMAIL_FROM
        msg["To"] = message.to
        msg["Subject"] = message.subject
        msg.set_content(message.text)
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as smtp:
            if settings.SMTP_STARTTLS:
                smtp.starttls()
            if settings.SMTP_USERNAME and settings.EMAIL_API_KEY:
                smtp.login(settings.SMTP_USERNAME, settings.EMAIL_API_KEY)
            smtp.send_message(msg)


def email_sender() -> EmailSender:
    return SmtpSender() if settings.EMAIL_MODE == "smtp" else LogSender()


async def send_safely(sender: EmailSender, message: Email) -> None:
    """Background-task wrapper: a failed send is logged (and reaches Sentry), never raised
    into a response that has already gone out."""
    try:
        await sender.send(message)
    except Exception:
        log.error("email_send_failed", to=message.to, subject=message.subject, exc_info=True)
