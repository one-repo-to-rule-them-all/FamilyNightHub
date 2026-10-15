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

Local ports: Postgres 55432, Redis 56379, S3 58333, MailHog UI 58025, API 8000.
