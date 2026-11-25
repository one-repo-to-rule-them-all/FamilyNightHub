"""The permission map: the single source of truth for what each account role may do
(03-backend.md "Auth & authorization"). Devices have no roles; they act only as the
people bound to them.
"""

from __future__ import annotations

from typing import Literal, get_args

Role = Literal["admin", "host"]
Permission = Literal[
    "sessions:run",  # create nights, shortlist, open/close voting
    "ballots:proxy",  # vote on behalf of anyone (kids without phones)
    "devices:enroll",  # let a phone in without the night code; pair the TV
    "devices:approve",  # approve a claim on a person bound to another phone
    "admin:people",  # add, rename, merge, convert guests (hosts may add guests)
    "admin:devices",  # devices list, label, revoke
    "admin:history",  # edit past nights, correct a winner
    "admin:movies",
    "admin:photos",  # hard delete
    "admin:settings",  # household settings, rotate the join slug
    "admin:accounts",  # invite hosts
]

ALL_PERMISSIONS: frozenset[Permission] = frozenset(get_args(Permission))

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    "host": frozenset({"sessions:run", "ballots:proxy", "devices:enroll", "devices:approve"}),
    "admin": ALL_PERMISSIONS,
}


def has_permission(role: str, permission: Permission) -> bool:
    """Unknown roles get nothing (fail closed)."""
    return permission in ROLE_PERMISSIONS.get(role, frozenset())  # type: ignore[call-overload]


# ADR-0016 §5: a platform operator acting inside a household is an admin minus these. Account
# management, so no standing admin is left behind; and the writes that name the acting account
# in a household-scoped foreign key (a night's host, a proxy ballot), which an account from
# another household can't satisfy.
PLATFORM_DENIED: frozenset[Permission] = frozenset(
    {"admin:accounts", "sessions:run", "ballots:proxy"}
)
