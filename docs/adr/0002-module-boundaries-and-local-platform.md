# ADR 0002: Module boundaries, database roles and local platform choices

- Status: **PROPOSED**, needs CTO approval
- Date: 2026-11-09
- Related: specs 03-02, 03-03; [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md) Q5, Q6, Q9

## 1. Module import boundaries

Each bounded context is a directory under `internal/<module>/`. Its **root
package is its public contract** (Go interfaces for synchronous policy checks,
plus event types). Other modules may import that root package and nothing
below it. Internals (`domain/`, `app/`, `store/`, `http/`, `events/`) are
private to the module.

Enforced by `internal/archtest` in `make test`:

- A business module must not import another module's subpackages.
- `internal/platform/...` must not import any business module.
- `domain/` must not import I/O packages (`database/sql`, `net/http`, `os`,
  pgx, Temporal) or any non-`domain/` package of its own module.
- `cmd/` may wire anything together.

We chose a Go test over a golangci-lint `depguard` rule because the rule is
"any module to any other module's internals", which `depguard` cannot express
without listing every pair.

## 2. One schema and one role per context (proposal; Q5)

03-03 §5.1 says A, B, C and D "own separate logical databases/roles per cell".
The pilot proposes one PostgreSQL database with:

- one schema per bounded context, owned by `zp_migrator`;
- one runtime role per deployable (`zp_gateway`, `zp_execution`, `zp_finance`,
  `zp_governance`, plus `zp_relay` for the outbox relay), which receives grants only
  on the schemas it owns;
- no runtime role is a superuser, none has BYPASSRLS, CREATEDB or CREATEROLE,
  none owns tables, and none can run DDL;
- goose version tables in `zp_migrations`, which runtime roles cannot read.

This gives the same write isolation the spec asks for (03-03 T-19: "Context
directly mutates another schema → database permission denied") with less
operational cost. Splitting into separate databases later only changes
connection strings, because no query joins across schemas.

## 3. PostgreSQL outbox relay instead of a broker (Q6)

03-03 calls for a "durable broker + schema registry". The pilot uses the
transactional outbox and inbox in PostgreSQL with a polling relay
(`cmd/outbox-relay`) and no Kafka or Redis. Delivery is at least once;
consumers deduplicate by `event_id` in their inbox. Event schemas are versioned
JSON Schemas in `api/events/`. The relay is an interface, so a broker can
replace it without touching producers.

## 4. Local platform stand-ins

| Need | Local choice | Notes |
|---|---|---|
| Workflow store | Temporal dev server (`temporalio/temporal:1.5.1`) | SQLite-backed, local only |
| Zoiko iD | Keycloak 26.4, realm `zoikopay` | OIDC stand-in |
| Evidence store | `bitnamilegacy/minio:2025.7.23` | Upstream `minio/minio` images were withdrawn from Docker Hub; frozen build, local only (Q9) |
| Observability | `grafana/otel-lgtm:0.11.0` | Grafana, Tempo, Loki, Prometheus and an OTel Collector in one image |

## 5. Tooling

Build tools are pinned in `tools/go.mod` and run with
`go tool -modfile=tools/go.mod <tool>`, so they don't pollute the app's
dependency graph and need no global install. Spectral runs from its Docker image.
