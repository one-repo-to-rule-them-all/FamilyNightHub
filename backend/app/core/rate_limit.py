"""Attempt-budget limiter on Redis (fixed window).

Join spends the budget on failures only, keyed on the join slug; magic-link requests spend
it on every request, keyed on the email. Keys are always an identity the request carries,
never the client address: a household shares one NAT address, and forwarded headers
are spoofable behind a proxy (OrderUp ADR-0018 reasoning). A limited key is rejected
before any credential is checked, so a correct guess cannot slip through once the budget
is spent.

If Redis is unreachable the limiter fails OPEN and logs: a dead Redis must not lock a
family out on movie night, and the night code still has to be right.
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog
from redis.exceptions import RedisError

from app.core.redis import get_redis

log = structlog.get_logger()


@dataclass(frozen=True)
class Budget:
    name: str
    limit: int
    window_seconds: int

    def key(self, identity: str) -> str:
        return f"ratelimit:{self.name}:{identity}"


async def retry_after(budget: Budget, identity: str) -> int | None:
    """Seconds until the key may try again, or None if it still has budget."""
    try:
        redis = get_redis()
        key = budget.key(identity)
        used = await redis.get(key)
        if used is None or int(used) < budget.limit:
            return None
        ttl = await redis.ttl(key)
        return max(int(ttl), 1)
    except (RedisError, OSError) as exc:
        log.warning("rate_limit_unavailable", budget=budget.name, error=str(exc))
        return None


async def spend(budget: Budget, identity: str) -> None:
    """Count one attempt against the budget (join: failures only; magic link: every request)."""
    try:
        redis = get_redis()
        key = budget.key(identity)
        pipe = redis.pipeline(transaction=True)
        pipe.incr(key)
        # NX: the window starts at the first failure and is not extended by later ones.
        pipe.expire(key, budget.window_seconds, nx=True)
        await pipe.execute()
    except (RedisError, OSError) as exc:
        log.warning("rate_limit_unavailable", budget=budget.name, error=str(exc))
