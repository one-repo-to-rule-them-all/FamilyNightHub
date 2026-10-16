"""The repo-rule checker must pass on this repo and catch each rule on a synthetic tree."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_checker() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "check_repo_rules", REPO_ROOT / "backend" / "scripts" / "check_repo_rules.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve their module via sys.modules
    spec.loader.exec_module(module)
    return module


checker = _load_checker()


def _write(root: Path, rel: str, content: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_this_repo_is_clean() -> None:
    assert checker.check(REPO_ROOT) == []


def test_catches_each_rule(tmp_path: Path) -> None:
    pause = "asyncio." + "sleep(1)"  # split so this file doesn't trip the rule itself
    _write(tmp_path, "backend/tests/unit/test_x.py", f"await {pause}\n")
    _write(tmp_path, "frontend/e2e/night.spec.ts", "await page.waitFor" + "Timeout(500);\n")
    _write(tmp_path, "backend/app/core/bad.py", 'q = "SET app.household_id = 1"\n')
    _write(
        tmp_path,
        "backend/app/core/bad2.py",
        "q = \"SELECT set_config('app.household_id', :h, false)\"\n",
    )
    _write(tmp_path, "backend/migrations/versions/0002_x.py", f"revision: str = '{'x' * 33}'\n")

    rules = sorted(v.rule.split(":")[0] for v in checker.check(tmp_path))
    assert rules == [
        "revision id longer than 32 chars",
        "session-level app.* GUC",
        "session-level app.* GUC",
        "sleep/fixed wait in a test",
        "sleep/fixed wait in a test",
    ]


def test_transaction_local_set_config_is_allowed(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "backend/app/core/ok.py",
        "q = \"SELECT set_config('app.household_id', :hid, true)\"\n",
    )
    assert checker.check(tmp_path) == []
