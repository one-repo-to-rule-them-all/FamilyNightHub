# Family Night Hub

Private, phone-first movie-night app for one family: shortlist, ranked voting, TV reveal, private
photo album. Three Fly.io apps (Next.js web, FastAPI API, ARQ worker) on Postgres, Redis and
Tigris. Architecture: [`docs/architecture/`](docs/architecture/README.md).

## Layout

- `backend/` - FastAPI API + ARQ worker (one image), Alembic migrations, pytest suites
- `frontend/` - Next.js 16 app (proxies `/api/*` to the API)
- `docker-compose.yml` - local stack (Postgres, Redis, SeaweedFS for S3, MailHog, API)
- `infra/` - local-only service config

## Local development

Needs Docker, [uv](https://docs.astral.sh/uv/) and Node 22.

```bash
cp .env.example .env
docker compose -p fnh up -d --build --wait
docker compose -p fnh exec api alembic upgrade head
docker compose -p fnh exec api python -m app.cli bootstrap --household "Our Family" --slug our-family --email you@example.com --name You
curl localhost:8000/api/health
```

Backend checks (from `backend/`):

```bash
uv sync
uv run ruff check . && uv run mypy app
uv run pytest tests/unit
uv run pytest tests/integration   # needs the compose stack up
```

Frontend (from `frontend/`): `npm install`, then `npm run dev` and open http://localhost:3000.

After changing an API schema, regenerate the contract (CI fails on drift):

```bash
(cd backend && uv run python scripts/dump_openapi.py openapi.json)
(cd frontend/tools/openapi && npm ci) && (cd frontend && npm run gen:api)
```

CI (`.github/workflows/ci.yml`) runs static, unit, integration (incl. isolation and RLS
coverage), contract and bundle-secrets jobs; see `docs/architecture/07-cicd.md`.

Local ports: Postgres 55432, Redis 56379, S3 58333, MailHog UI 58025 (sign-in links land here),
API 8000.
