"""Repo rules that no off-the-shelf linter enforces. Run by the CI `static` job.

1. No sleeps or fixed waits in tests (07-cicd.md: deterministic E2E, no `waitForTimeout`).
2. No session-level GUC writes in app code (ADR-0003): plain `SET app.*`, or
   `set_config('app.*', ..., false)`, would outlive the transaction on a pooled connection
   and hand the next request another household's scope.
3. Alembic revision ids are at most 32 chars (alembic_version.version_num is varchar(32);
   OrderUp issue #84).

Usage: python scripts/check_repo_rules.py [repo_root]   (exit 1 on any violation)
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

SLEEP_PATTERNS = [
    re.compile(r"\btime\.sleep\("),
    re.compile(r"\basyncio\.sleep\("),
    re.compile(r"\bwaitForTimeout\("),
    re.compile(r"\bsetTimeout\(\s*resolve\b"),
]
SESSION_GUC_PATTERNS = [
    re.compile(r"\bSET\s+(SESSION\s+)?app\.", re.IGNORECASE),
    re.compile(r"set_config\(\s*'app\.[^']*'\s*,[^,]+,\s*false\s*\)", re.IGNORECASE),
]
REVISION_ID = re.compile(r"^revision(?::\s*str)?\s*=\s*['\"]([^'\"]+)['\"]", re.MULTILINE)
MAX_REVISION_LEN = 32


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    rule: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.rule}"


def _scan(path: Path, patterns: list[re.Pattern[str]], rule: str) -> list[Violation]:
    found = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if any(p.search(line) for p in patterns):
            found.append(Violation(path, lineno, rule))
    return found


def _files(root: Path, globs: list[str]) -> list[Path]:
    return sorted(
        p for g in globs for p in root.glob(g) if p.is_file() and "node_modules" not in p.parts
    )


def check(root: Path) -> list[Violation]:
    violations: list[Violation] = []

    test_files = _files(
        root,
        [
            "backend/tests/**/*.py",
            "frontend/e2e/**/*.ts",
            "frontend/src/**/*.test.ts",
            "frontend/src/**/*.test.tsx",
        ],
    )
    for path in test_files:
        violations += _scan(path, SLEEP_PATTERNS, "sleep/fixed wait in a test: wait on a condition")

    for path in _files(root, ["backend/app/**/*.py"]):
        violations += _scan(
            path, SESSION_GUC_PATTERNS, "session-level app.* GUC: use set_config(..., true)"
        )

    for path in _files(root, ["backend/migrations/versions/*.py"]):
        match = REVISION_ID.search(path.read_text(encoding="utf-8"))
        if match and len(match.group(1)) > MAX_REVISION_LEN:
            violations.append(
                Violation(path, 1, f"revision id longer than {MAX_REVISION_LEN} chars")
            )
    return violations


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
    violations = check(root)
    for v in violations:
        print(v)
    print(f"{len(violations)} repo-rule violation(s)")
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
