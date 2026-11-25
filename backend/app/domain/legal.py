"""Current Terms and Privacy Policy versions (ADR-0017 §3).

The pages are `frontend/src/app/(public)/legal/{terms,privacy}/page.tsx`. Their versions live
in `frontend/src/lib/legal.ts` and must equal the constants here (tests/unit/test_legal.py). A
material change to either page bumps its version, and every account accepts again.
"""

from __future__ import annotations

TERMS_VERSION = "2026-10-19"
PRIVACY_VERSION = "2026-10-19"
