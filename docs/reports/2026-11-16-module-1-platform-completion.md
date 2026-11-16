# Module 1 completion report: shared platform

- Date: 2026-11-16
- Branch: `module-1-platform` (baseline `5a91868` on `main`)
- Scope: shared platform only, per owner approval of 2026-11-16. Payments and Ledger not started.
- Decisions: [ADR 0005](../adr/0005-financial-data-foundation.md); open items Q26 to Q28 in [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md)

## 1. Result against the brief's definition of done

| # | Definition of done | Status | Evidence |
|---|---|---|---|
| 1 | Correct integer monetary representation | **Met** for the platform | `money`: int64 minor units, string on the wire, JSON numbers rejected, 15-digit per-transaction limit (Go and SQL), overflow-checked totals, exact arithmetic, rounding blocked. DB: `BIGINT` + `CHECK` helpers proven in `TestDatabaseSecurity` |
| 2 | Consistent IDs and enforced uniqueness | **Met** | Internal UUIDv7 vs public `pi_…` vs event ID vs idempotency key; DB `CHECK` (version and variant nibbles) and `UNIQUE` proven; a UUIDv4 primary key and a wrong prefix are rejected by the database |
| 3 | Safe duplicate request handling | **Met** | 25 concurrent same-key requests produce exactly 1 effect; replay, mismatch (zero effects), crash-after-reserve recovery, killed connection, rollback |
| 4 | Reliable event publishing and consumption | **Met** | Exact bytes, per-aggregate order, backoff, parking after N failures, audited requeue, relay crash followed by redelivery deduplicated by the inbox |
| 5 | Independently versioned migrations | **Met** (runner); no module migrations exist yet | Checksums, append-only history, advisory lock, per-module versioning, out-of-order refusal, expand–contract guard, 9 integration tests |
| 6 | Verified database permissions | **Met** | Cross-module access, DELETE, TRUNCATE, envelope rewrite, DDL, disabling RLS and reading migration history all refused with SQLSTATE 42501; guards stop even the table owner (23001) |
| 7 | Passing regression and integration tests | **Met** | §4 |
| 8 | No unintended change to business behaviour | **Met** | No business module, console or deployable behaviour changed; `cmd/` services unchanged |

## 2. Files changed

New:
- `cmd/migrate/main.go`: migration tool (`up`, `status`, `verify`, `scaffold`)
- `internal/platform/migrate/`: `source.go`, `guard.go`, `runner.go`, `scaffold.go`, plus tests
- `internal/platform/db/tenant.go`: tenant context, RLS, system-policy and grant SQL builders
- `internal/platform/db/dbtest/platform.go`: applies scaffolded modules through the real runner in tests
- `internal/platform/db/security_integration_test.go`
- `internal/platform/money/exact.go`: `MulDivExact`, SQL `CHECK` helpers
- `docs/adr/0005-financial-data-foundation.md`, this report

Changed:
- `internal/platform/ids/ids.go`: internal/public split, `ParseInternal`, SQL `CHECK` helpers
- `internal/platform/money/money.go`, `doc.go`: transaction limit separated from totals; overflow detection
- `internal/platform/idempotency/registry.go`: tenant check in `Reserve`, identity guard trigger, RLS, `GrantSQL`
- `internal/platform/outbox/outbox.go`, `relay.go`: `tenant_id`, RLS + relay system policy, guard, parking, `ListParked`, `Requeue` + requeue log, `GrantSQL`
- `internal/platform/inbox/inbox.go`: tenant from the transaction context, RLS, immutability guard, `GrantSQL`
- `Makefile`: `migrate`, `migrate-status`, `migrate-verify`; `make test` runs `migrate-verify`
- `.gitignore`, `CLAUDE.md`, `README.md`, `docs/OPEN_QUESTIONS.md` (Q26 to Q28)

Pre-brief M1 code (committed in the baseline) was kept and is now fully verified.

## 3. Migration scripts

- **No migration was added to `db/migrations/`**, and none was executed against any persistent database (local or otherwise). No production system was touched.
- Module schemas are produced by `go run ./cmd/migrate scaffold -module <m> -writer <role>`. Integration tests apply exactly this output through the runner. Preview: `go run ./cmd/migrate scaffold -module example -writer zp_execution`.
- New runner objects created on first run: `zp_migrations.history`, its guard function and triggers (DDL in `migrate.HistorySQL`).

## 4. Test evidence

Commands (all run on 2026-11-16, Go 1.26.4, PostgreSQL 18.1 via Testcontainers):

| Command | Result |
|---|---|
| `make test` (race detector + `migrate-verify`) | pass: 10 packages with tests, 0 failures |
| `make test-integration` | pass: all 10 packages, including `db`, `idempotency`, `migrate`, `outbox` on real PostgreSQL |
| `make lint-go` (golangci-lint, integration files included) | 0 issues |
| Fuzz `FuzzParseMinorRoundTrip`, 20 s | pass, about 3.4 M executions |
| `make vuln` | 2 findings, both pre-existing in the baseline (§5) |

Tests per package (unit / with integration): money 9/9, ids 6/6, idempotency 4/8, outbox 3/8, migrate 5/14, db 0/2, apierror 3/3, clock 2/2.

### Failure scenarios tested

| Scenario | Test | Expected and observed |
|---|---|---|
| Same key, 25 concurrent requests | `TestConcurrentSameKeyProducesOneEffect` | 1 New, 24 Replay, 1 effect row |
| Changed payload, same key | `TestRegistry/changed payload…` | Mismatch, zero effects |
| Process crash after reservation commit | `TestCrashAfterReserveRecovers…` | Retries get InProgress with the same operation; after recovery, Replay; 1 effect |
| DB connection killed mid-transaction (`pg_terminate_backend`) | `TestConnectionKilledMidTransaction` | Nothing persisted; retry is New |
| Business rollback after reservation | `TestRegistry/a rolled-back reservation…` | No trace; retry is New |
| Tenant mismatch | `TestRegistry/reserve refuses…`, `TestAppendIsAtomicAndTenantScoped` | Refused |
| Consumer down | `TestRelayPublishes…` | Aggregate held, others continue, retried after backoff |
| Consumer down repeatedly | `TestFailedEventsAreParked…` | Parked after 3 attempts, later versions held, requeue audited, order preserved |
| Relay crash after delivery, before commit | `TestRelayCrashRedelivers…` | Redelivered once; inbox keeps 1 projection row |
| Duplicate and cross-tenant event replay | `TestInboxProcessesEachEventOnce` | Skipped |
| Edited or deleted applied migration | `TestChangedAppliedFileStopsEverything` | Refused before applying anything in any module |
| Migration fails mid-file | `TestFailedMigrationRollsBackCompletely` | No table, no history row; fixed file applies |
| Late-merged older migration | `TestOutOfOrderPendingFileIsRefused` | Refused |
| 5 concurrent migration runs | `TestConcurrentRunnersApplyEachMigrationOnce` | Each migration applied once |
| Lock held by another run | `TestLockTimeoutWhen…` | `ErrLockTimeout`, nothing applied |
| Expand with existing data and version-1 writers | `TestExpandIsCompatible…` | Old inserts work; data unchanged; unannotated contract refused |
| Tampering with history as owner | `TestHistoryIsAppendOnly…` | Refused (23001); runtime role cannot read (42501) |
| Privilege escalation attempts | `TestDatabaseSecurity` | All refused with 42501; owner stopped by guards (23001) |
| Tenant context leaking through the pool | `TestDatabaseSecurity/row-level security…` | Not leaked |

## 5. Unresolved issues

| # | Issue | Owner / next step |
|---|---|---|
| U1 | Q26 transaction limit (15 digits) is provisional | CTO, Financial Engineering |
| U2 | Q27 idempotency retention; full response bodies not stored | Payments, Finance, Legal, SRE |
| U3 | Q28 no rounding policy: any fractional result blocks posting | Finance |
| U4 | `govulncheck`: GO-2026-6859 (`net/http`, fixed in Go 1.26.11) and GO-2026-6865 (`klauspost/compress`, test-only via Testcontainers). Both pre-existing in the baseline. | Separate change: bump the Go toolchain and the dependency, then rerun all suites |
| U5 | The relay holds the row lock while publishing (no lease epoch). Fine for in-process consumers. | Revisit if a remote broker is introduced |
| U6 | Nothing yet calls `Relay.Requeue` or authorizes who may (needs the governance/console path) | Governance (M4) |
| U7 | The `migrate` CLI was not run against the local stack: its PostgreSQL container will not start (see §6). The runner itself is covered by integration tests. | After §6 is fixed: `make migrate-status` |

## 6. Environment incidents during this module

- The Mac's disk filled to 135 MB free, which made Docker's storage read-only. With your approval I ran `go clean -cache` and `docker image prune -a` (7.65 GB of unused images) and restarted Docker Desktop. About 6.7 GB is now free.
- The local stack's PostgreSQL (`zoikopay-postgres-1`) now restart-loops: `FATAL: bogus data in lock file "postmaster.pid": ""`. The empty lock file was left in its data volume by the disk-full event. **Not touched.** The usual fix is to delete that empty file from the volume and start the container. Your local development data is otherwise intact; this needs your go-ahead.

## 7. Remaining risks

- Row-level security depends on every module using `db.InTenantTx`. A module that queries outside a tenant transaction sees nothing rather than everything, so it fails safe. This must be part of each module's review.
- Scaffolded SQL is checksummed once applied. Platform DDL changes after a module ships need a new migration, not a regenerated file.
- Low disk space on the development machine can corrupt Docker again; keep at least 2 GB free (README).
