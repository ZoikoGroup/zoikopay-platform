# ZoikoPay: notes for coding agents

Payment orchestration pilot. Go 1.26, one Go module (`github.com/zoiko/zoikopay`),
PostgreSQL 18, Temporal. Founder specs are `docs/*.docx` (read-only); map spec
IDs to files with `docs/spec/INDEX.md` and cite specs by ID (e.g. "06-01").

## Decisions that bind all code

- `docs/adr/0001-contract-freeze.md`: gates per Master Register; state names from
  06-01 verbatim; money is `amount_minor` as a decimal string on the wire and
  `int64`/`BIGINT` inside; never floats; URLs snake_case.
- `docs/adr/0002-module-boundaries-and-local-platform.md`: module import rules,
  one schema and one DB role per context, PostgreSQL outbox (no broker).
- `docs/adr/0005-financial-data-foundation.md`: IDs (internal UUIDv7 vs public `pi_…`), money limits
  and no-rounding rule, idempotency/outbox/inbox, tenant RLS via `db.InTenantTx`, migration runner.
- `docs/adr/0006-payments-module.md`: BC-03 reducer is the only state authority; DB guards back it; events use
  only 04-06 registry names; BC-04 owns provider calls; payment HTTP API is not mounted until D1→D2 auth exists.
- Unresolved conflicts go in `docs/OPEN_QUESTIONS.md`, not into code silently.

## Layout

- `cmd/` six deployables: gateway, execution, finance, governance, outbox-relay, mockpsp; plus the `migrate` tool (not a deployable).
- `internal/<module>/` nine bounded contexts (payment, merchant, eligibility,
  connector, ledger, recon, billing, notify, governance). The root package is the
  public contract; subpackages are private.
- `internal/platform/` shared infrastructure; must not import business modules.
- `internal/archtest/` enforces the boundaries in `make test`.
- `db/migrations/<module>/` forward-only SQL migrations (goose file format) applied by `cmd/migrate`
  as `zp_migrator`: checksums, append-only history, advisory lock (ADR 0005). Start a module with
  `go run ./cmd/migrate scaffold -module <m> -writer <role>`; destructive statements need
  `-- zp:contract` / `-- zp:data-change` annotations.
- `deploy/compose/` local stack; `deploy/compose/postgres/init/01-roles.sql` roles.

## Commands

- `make test`: unit tests with `-race`, no Docker.
- `make test-integration`: Testcontainers against real PostgreSQL 18 (needs Docker).
- `make lint`: golangci-lint and Spectral. `make vuln`: govulncheck.
- `make migrate` / `make migrate-status` / `make migrate-verify`: migration runner (`make test` runs verify).
- `make up` / `make down` / `make nuke`: local stack.
- `make run-<service>`: one program against the local stack; `make smoke`: all six, checks `/healthz`.
- Programs declare dependencies in `cmd/<name>/main.go` (`health.Dependency`); bootstrap
  connects with retry and reports them on `/healthz`.
- `make gen` then `make check-gen`: sqlc and oapi-codegen; generated code is committed.
- Tools are pinned in `tools/go.mod`; run them with `go tool -modfile=tools/go.mod <tool>`.

## Admin console (`frontend/`, `backend/`)

- Two Node.js servers: `frontend/` (React + Vite, 5173) and `backend/` (Express BFF, 4000). ADR 0003.
- Scope: a sign-in page (own form; backend checks the password with Keycloak), the Overview dashboard, the 12
  §07 side-rail areas, plus Access, Exceptional access and Super Admin (OPEN_QUESTIONS Q18). Decisions on those
  screens act on in-memory TEST fixtures only; nothing moves money or reaches a PSP (ADR 0003).
- Super Admin has no Overview: they land on the Super Admin page (health, counts, redacted tenant metadata; 03-05 §10.1, Q24).
- The BFF holds no payment/ledger logic. Fixtures are TEST-only and labelled `source: "fixture"`.
- Authorization lives in `backend/src/authorization/` and is enforced server-side on every route and record.
- UI follows the user-approved navy, green and light ZoikoPay reference designs (2026-11-17). `frontend/src/test/brand.test.ts` checks the shared palette and contrast. Preserve existing permissions and TEST fixture labels.
- Per project: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; backend `npm run test:e2e` against the running stack.
- `frontend/go.mod` and `backend/go.mod` hide `node_modules` from Go tooling; keep these exclusion modules. Console documentation and the combined startup script remain in `zoiko-pay-console/`.

## Rules

- Runtime DB roles are never superuser, never BYPASSRLS, never own tables, never run DDL.
- `domain/` packages do no I/O.
- Do not edit or move the `.docx` specs.
