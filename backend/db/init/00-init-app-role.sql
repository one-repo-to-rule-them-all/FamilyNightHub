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

-- ADR-0009: NOLOGIN owner of the pre-auth SECURITY DEFINER functions. Its table access is
-- column-level grants plus SELECT-only policies, both created by the migration. Granted to
-- the owner so migrations can ALTER FUNCTION ... OWNER TO fnh_resolver without superuser.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fnh_resolver') THEN
        CREATE ROLE fnh_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;
GRANT fnh_resolver TO fnh;

GRANT USAGE ON SCHEMA public TO fnh_app;
GRANT USAGE ON SCHEMA public TO fnh_resolver;
-- ALTER FUNCTION ... OWNER TO fnh_resolver also requires the NEW owner to hold CREATE on the
-- function's schema (superusers skip that check). Locally and in CI the owner `fnh` is the
-- superuser, so only a deployed database, where `fnh` is an ordinary CREATEROLE role, hits
-- it: migration 0001 fails with "permission denied for schema public". fnh_resolver is
-- NOLOGIN and only runs the fixed bodies of its definer functions, so this widens nothing a
-- client can reach.
GRANT CREATE ON SCHEMA public TO fnh_resolver;

-- Tables created later by the owner auto-grant DML to the app role, so each migration
-- only needs to carry its RLS policy (enforced by tests/integration/test_rls_coverage.py).
ALTER DEFAULT PRIVILEGES FOR ROLE fnh IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fnh_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fnh IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO fnh_app;
