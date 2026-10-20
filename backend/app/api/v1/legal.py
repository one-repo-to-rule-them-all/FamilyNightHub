"""Current Terms and Privacy Policy versions (ADR-0017 §3). Public: the pages themselves are
static, and the consent screen sends back the versions it showed."""

from __future__ import annotations

from fastapi import APIRouter

from app.domain.legal import PRIVACY_VERSION, TERMS_VERSION
from app.schemas.identity import LegalOut

router = APIRouter(prefix="/legal", tags=["legal"])


@router.get("", response_model=LegalOut)
async def versions() -> LegalOut:
    return LegalOut(terms_version=TERMS_VERSION, privacy_version=PRIVACY_VERSION)
