/**
 * The Terms and Privacy Policy versions (ADR-0017 §3). They must equal TERMS_VERSION and
 * PRIVACY_VERSION in backend/app/domain/legal.py (backend tests/unit/test_legal.py checks). A
 * material change to either page bumps its version here and there, and every account is asked
 * to accept again.
 */
export const TERMS_VERSION = "2026-10-19";
export const PRIVACY_VERSION = "2026-10-19";

/** Where a family writes about its data, deletion or the operator's access. */
export const OPERATOR_CONTACT = "rbjengineeringservices.llc@gmail.com";
