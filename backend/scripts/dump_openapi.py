"""Dump the FastAPI OpenAPI schema to a JSON file. Copied from FieldPro
backend/scripts/dump_openapi.py @ 0670961.

Used by:
  - `npm run gen:api` in frontend/ — keeps generated TypeScript types in sync
    with the backend Pydantic schemas.
  - CI (contract job) — regenerates and asserts the committed openapi.json matches the
    current code; a drift fails the build.

Usage:
    python scripts/dump_openapi.py                     # writes to ./openapi.json
    python scripts/dump_openapi.py path/to/out.json    # custom path

Notes:
  - Importing `app.main` triggers Sentry init, logging setup, and a few
    other side effects, but no DB or Redis connections (those happen
    inside the FastAPI `lifespan`, which doesn't run during a plain
    import). Safe to invoke without docker compose up.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(out_path: Path) -> None:
    # Ensure `app.*` is importable when running from backend/
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

    from app.main import app  # noqa: E402

    schema = app.openapi()
    out_path.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"Wrote {out_path} ({len(schema.get('paths', {}))} paths, "
        f"{len(schema.get('components', {}).get('schemas', {}))} schemas)"
    )


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("openapi.json")
    main(out)
