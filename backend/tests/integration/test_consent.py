"""Terms, Privacy and the consent gate (ADR-0017 §2).

Seeded households carry an admin's guardian acceptance of the current versions. A closed
gate is simulated the way production gets one: the documents' versions move on.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.database import household_session
from app.domain.legal import PRIVACY_VERSION, TERMS_VERSION
from app.services import consent_service, people_service
from app.services.errors import ConsentRequired
from tests.integration.phones import add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
NEW = "2099-01-01"
CODE = "K7M2QX"


@pytest.fixture
def new_terms(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Terms changed: nobody has accepted the new version yet."""
    monkeypatch.setattr(consent_service, "TERMS_VERSION", NEW)


def _accept(guardian: bool = True, terms: str = NEW) -> dict[str, object]:
    return {"terms_version": terms, "privacy_version": PRIVACY_VERSION, "guardian": guardian}


async def test_versions_are_public_and_me_reports_consent(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        legal = (await p.client.get("/api/v1/legal")).json()
        assert legal == {"terms_version": TERMS_VERSION, "privacy_version": PRIVACY_VERSION}
        p.sign_in_as(a.ids["account"], a.household_id)
        me = (await p.client.get("/api/v1/auth/me")).json()
    assert me["consent"] == {
        "terms_version": TERMS_VERSION,
        "privacy_version": PRIVACY_VERSION,
        "account_accepted": True,
        "household_accepted": True,
    }


async def test_closed_gate_refuses_people_phones_and_devices(
    two_households: Pair, new_terms: None
) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        p.sign_in_as(a.ids["account"], a.household_id)
        me = (await p.client.get("/api/v1/auth/me")).json()
        assert me["consent"]["account_accepted"] is False
        assert me["consent"]["household_accepted"] is False

        person = await p.post(
            "/api/v1/admin/people", {"name": "Baby", "avatar_emoji": "🐣", "color": "#f59e0b"}
        )
        assert person.status_code == 409, person.text
        assert person.json()["error"]["code"] == "consent_required"

        enrolled = await p.post("/api/v1/devices/enroll", {"device_label": "Grandma"})
        assert enrolled.status_code == 409
        assert enrolled.json()["error"]["code"] == "consent_required"

    async with phone() as kid:
        joined = await kid.join(a.slug, CODE)
        assert joined.status_code == 409
        assert joined.json()["error"]["code"] == "consent_required"

    # A phone already in the household can't make a profile either.
    async with household_session(a.household_id) as db:
        with pytest.raises(ConsentRequired):
            await people_service.create_self(
                db,
                a.household_id,
                a.ids["device"],
                name="Sneaky",
                avatar_emoji="🦊",
                color="#f59e0b",
                pin="482913",
            )


async def test_an_admin_accepting_as_guardian_opens_the_gate(
    two_households: Pair, new_terms: None
) -> None:
    a, b = two_households
    async with phone() as p:
        p.sign_in_as(a.ids["account"], a.household_id)
        no_guardian = await p.post("/api/v1/auth/consent", _accept(guardian=False))
        assert no_guardian.status_code == 422
        stale = await p.post("/api/v1/auth/consent", _accept(terms=TERMS_VERSION))
        assert stale.status_code == 422

        accepted = await p.post("/api/v1/auth/consent", _accept())
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["household_accepted"] is True
        assert accepted.json()["account_accepted"] is True

        person = await p.post(
            "/api/v1/admin/people", {"name": "Baby", "avatar_emoji": "🐣", "color": "#f59e0b"}
        )
        assert person.status_code == 201, person.text

    # Household B is untouched by A's acceptance.
    async with phone() as p:
        p.sign_in_as(b.ids["account"], b.household_id)
        me = (await p.client.get("/api/v1/auth/me")).json()
    assert me["consent"]["household_accepted"] is False

    async with household_session(a.household_id) as db:
        audited = await db.scalar(
            text("SELECT data FROM audit_events WHERE action = 'consent.accepted'")
        )
    assert audited == {"terms_version": NEW, "privacy_version": PRIVACY_VERSION, "guardian": True}


async def test_a_hosts_acceptance_never_opens_the_gate(
    two_households: Pair, new_terms: None
) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@example.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        # A host's "guardian" is ignored: only admins add children.
        accepted = await p.post("/api/v1/auth/consent", _accept(guardian=True))
        assert accepted.status_code == 200, accepted.text
        assert accepted.json() == {
            "terms_version": NEW,
            "privacy_version": PRIVACY_VERSION,
            "account_accepted": True,
            "household_accepted": False,
        }


async def test_consent_rows_are_append_only_for_the_app(two_households: Pair) -> None:
    a, _ = two_households
    for statement in (
        "UPDATE household_consents SET guardian = false",
        "DELETE FROM household_consents",
    ):
        with pytest.raises(DBAPIError, match="permission denied"):
            async with household_session(a.household_id) as db:
                await db.execute(text(statement))
