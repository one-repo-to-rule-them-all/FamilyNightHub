"""ADR-0017 §3: the consent screen sends back the versions the frontend shows, and the API
refuses any other, so the two copies of each version must agree."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.domain.legal import PRIVACY_VERSION, TERMS_VERSION

FRONTEND_LEGAL = Path(__file__).resolve().parents[3] / "frontend" / "src" / "lib" / "legal.ts"


@pytest.mark.skipif(not FRONTEND_LEGAL.exists(), reason="frontend not in this checkout")
def test_frontend_versions_match_the_api() -> None:
    source = FRONTEND_LEGAL.read_text(encoding="utf-8")
    found = dict(re.findall(r'export const (\w+_VERSION) = "([^"]+)";', source))
    assert found == {"TERMS_VERSION": TERMS_VERSION, "PRIVACY_VERSION": PRIVACY_VERSION}
