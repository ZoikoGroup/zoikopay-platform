-- ZoikoPay PostgreSQL bootstrap. Runs once, as the cluster superuser, when
-- the data directory is first created (docker-entrypoint-initdb.d). The
-- integration tests run this same file, so the tested role model is the
-- deployed one.
--
-- Role model (rule 8, spec 03-03 §5.2, ADR 0002):
--   zp_migrator          owns schemas and tables; runs goose migrations; no superuser.
--   zp_gateway ...       one runtime role per deployable. LOGIN only: not superuser,
--                        no BYPASSRLS, no CREATEDB/CREATEROLE, owns nothing, no DDL.
-- Per-schema grants and RLS policies are added by each module's migrations.
--
-- Passwords come from the environment so none are written here. The compose
-- defaults are for local development only.

\set ON_ERROR_STOP on
\getenv migrator_password ZP_MIGRATOR_PASSWORD
\getenv app_password ZP_APP_PASSWORD

CREATE ROLE zp_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION
    PASSWORD :'migrator_password';

-- Group role every runtime role belongs to; holds only CONNECT.
CREATE ROLE zp_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

CREATE ROLE zp_gateway    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD :'app_password';
CREATE ROLE zp_execution  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD :'app_password';
CREATE ROLE zp_finance    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD :'app_password';
CREATE ROLE zp_governance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD :'app_password';
CREATE ROLE zp_relay      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD :'app_password';

-- Lock down the database: nobody gets anything by default.
REVOKE ALL ON DATABASE zoikopay FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE zoikopay TO zp_migrator;
GRANT CONNECT ON DATABASE zoikopay TO zp_runtime;
GRANT CONNECT ON DATABASE zoikopay TO zp_gateway, zp_execution, zp_finance, zp_governance, zp_relay;

-- Nothing lives in public. Each module gets its own schema via migrations.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- goose version tables, one per module (zp_migrations.goose_<module>).
-- Owned by the migrator; runtime roles have no access.
CREATE SCHEMA zp_migrations AUTHORIZATION zp_migrator;

-- Money and audit timestamps are UTC (spec 02-05).
ALTER DATABASE zoikopay SET timezone TO 'UTC';
