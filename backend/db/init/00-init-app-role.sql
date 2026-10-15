-- Bootstrap the non-owner application role `fnh_app` (ADR-0003).
--
-- Superusers, table owners and BYPASSRLS roles ignore Row-Level Security (owners only
-- until FORCE is set). The isolation model holds only because the API and worker connect
-- as an ordinary role. Migrations run as the owner `fnh`; runtime uses `fnh_app`.
-- Runs on first container init (docker-entrypoint-initdb.d) and in CI before migrations.
-- On Fly the same statements run once by hand at provisioning (see 02-environments.md).
-- Idempotent. Copied from OrderUp backend/db/init/00-init-app-role.sql @ 2f86cd8.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fnh_app') THEN
        CREATE ROLE fnh_app LOGIN PASSWORD 'fnh_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO fnh_app;

-- Tables created later by the owner auto-grant DML to the app role, so each migration
-- only needs to carry its RLS policy (enforced by tests/integration/test_rls_coverage.py).
ALTER DEFAULT PRIVILEGES FOR ROLE fnh IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fnh_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fnh IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO fnh_app;
