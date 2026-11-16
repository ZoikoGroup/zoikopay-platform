# Stage 1 baseline: financial data integrity, transaction safety, database reliability

- Date: 2026-11-16
- Brief: "Engineering Implementation Brief: Financial Data Integrity, Transaction Safety and Database Reliability", Stage 1
- Method: read-only inspection of `internal/`, `cmd/`, `db/`, `api/`, `deploy/`, `Makefile`, `zoiko-pay-console/backend`. No schema, data or migration was changed for this report.

## 0. Disclosure: work done before this brief arrived

Earlier on 2026-11-16, before the brief, M1 platform code was written in
`internal/platform/` (listed in §4). It is uncommitted, has no migrations and
touches no database outside throwaway test containers. It has **not** passed
the full verification the brief requires: `make test` and `make lint` were
interrupted. Keep, change or discard it as part of the module 1 review.

## 1. Inventory

| Area | State | Financial data at risk |
|---|---|---|
| 9 Go business modules (`internal/payment`, `merchant`, `eligibility`, `connector`, `ledger`, `recon`, `billing`, `notify`, `governance`) | Placeholder `doc.go` files only; no domain, store, HTTP or events code | None |
| Database schemas and tables | **None.** `db/migrations/<module>/` and `db/queries/<module>/` hold only `.gitkeep` | None: there is no existing financial data to convert |
| OpenAPI (`api/openapi/*.v1.yaml`) | 5 files, 0 paths | None |
| Event schemas (`api/events/<module>/`) | Empty placeholders | None |
| Six programs (`cmd/`) | Start, connect, serve `/healthz` only | None |
| Console BFF (`zoiko-pay-console/backend`) | In-memory TEST fixtures, no database | None (fixtures only) |

**Consequence:** no data migration, conversion or backfill is needed. All the
brief's stages apply as *greenfield* standards, not remediation.

## 2. Findings

Severity: **High** blocks a stage's definition of done; **Medium** must be fixed before the first business module ships; **Low** should be fixed but does not block.

| # | Finding | Severity | Evidence | Proposed change | Stage |
|---|---|---|---|---|---|
| F1 | **The repository is not under version control.** "Version-controlled SQL migrations" and any review trail are impossible. | High | `git` reports "not a git repository" | `git init`, first commit of the current tree, then work on branches | 5 |
| F2 | Migration runner has no checksum of applied files. goose records version and time, not content, so an edited, already-applied migration goes unnoticed. | High | `Makefile` `migrate` target; goose v3.29 version table | Small Go runner around goose's library: record a SHA-256 per applied file and refuse to run if an applied file changed | 5 |
| F3 | Migration runner has no explicit concurrency lock. Two simultaneous `make migrate` runs could interleave. | Medium | `Makefile` calls the goose CLI per module | Take a PostgreSQL advisory lock for the whole run in that runner | 5 |
| F4 | No expand–migrate–contract rule or migration compatibility tests | Medium | No policy doc; no migration tests | Write an ADR with the rule; add tests that apply migrations to a database holding data written by the previous version | 5 |
| F5 | No per-schema grants exist yet; only `CONNECT` is granted. Correct today, but each module must add its own. | Medium | `deploy/compose/postgres/init/01-roles.sql` | A standard grant block in each module's first migration, plus a permission test per module | 6 |
| F6 | No tenant isolation: no row-level security (RLS) and no per-request tenant session variable | High | `internal/platform/db/db.go` comment: "tenancy session variables … come later" | `db` helper that sets `SET LOCAL zp.tenant_id` per transaction; RLS policies in each module's migrations; tests proving cross-tenant reads return nothing | 6 |
| F7 | No audit trail for sensitive database operations in Go (the console's audit chain is in memory) | Medium | `internal/governance` empty | Out of scope until governance (M4). Record it, don't invent it | 6 |
| F8 | Rounding rules are not defined. 02-05 requires a versioned, approved RoundingPolicy, and the brief forbids inventing business rules. | Medium | 02-05 §2.3 | Implement only "no rounding: fail on fractional results" now; add policies when Finance approves them | 2 |
| F9 | Idempotency key retention is not decided: 04-08 §6.2 proposes "≥ 30 days", pending Payments, Finance, Legal and SRE sign-off | Medium | 04-08 §6.2 | Never delete keys until a policy is approved; record as an open question | 3 |
| F10 | Failed events have no dead-letter or triage state; failures are visible only as `attempts` and `last_error` | Medium | `internal/platform/outbox/relay.go` | Add `PARKED` after N attempts, with a list and requeue operation and an "oldest unpublished event" metric | 4 |
| F11 | Immutable financial history is not enforced in the database (no ledger yet) | Medium (for ledger) | `internal/ledger` empty | In the ledger module: append-only tables, no `UPDATE`/`DELETE` grant, trigger guard | 2 |
| F12 | The brief says "UUID identifiers"; ADR 0001 §6 says prefixed IDs (`pi_` + UUIDv7). They are compatible but need one storage decision. | Low | ADR 0001 §6 | Proposal: store the full prefixed ID as `text` with a `CHECK` on format, so it reads the same in logs, the API and the database | 2 |
| F13 | Maximum money amount is not decided (Q2 says "with an API maximum") | Low | OPEN_QUESTIONS Q2 | Proposal: 15 digits (999,999,999,999,999 minor units); add as Q26 | 2 |
| F14 | Console BFF: money is a decimal string plus `BigInt`. One `Number()` conversion is used only for drawing a chart line, never for arithmetic. Fixture amounts are rounded to integers once, at generation. **No defect.** | — | `services/overview.ts:93`, `database/fixtures.ts:177` | None | 2 |
| F15 | Console sandbox idempotency is in memory; it is a demo, not the real store | Low | `backend/src/services/sandbox.ts` | Replace with the Go API in M7 | 3 |
| F16 | No floats anywhere in Go, SQL or OpenAPI. The only matches for "float" are comments that forbid floats. | — | grep of `internal cmd api db` | None | 2 |
| F17 | Database roles are correct and tested: no superuser, no BYPASSRLS, no DDL for runtime roles; migrator separate from runtime credentials | — | `internal/platform/db/bootstrap_integration_test.go` | Keep; extend per module (F5) | 6 |

## 3. Dependencies and order

```
F1 git ──► F2/F3/F4 migration runner ──► each module's first migration
                                          ├─ F5 grants + F6 RLS (Stage 6)
                                          ├─ idempotency/outbox/inbox tables (Stages 3–4)
                                          └─ money/ID constraints (Stage 2)
```

Proposed module order (one at a time, stop for review after each):

1. **platform** (shared foundations): finish and verify money, IDs, idempotency, outbox and inbox; migration runner (F2–F4); tenant session and RLS helper (F6); failed-event parking (F10).
2. **payment**: first business schema, using every standard above.
3. **ledger**: immutable history (F11).
4. Then connector, merchant, eligibility, recon, billing, notify and governance, as the roadmap reaches them.

## 4. Files affected

Already written (pre-brief, uncommitted):
`internal/platform/{clock,ids,money,apierror,idempotency,outbox,inbox}/*.go`,
`internal/platform/db/tx.go`, unit tests and two integration test files.
Results so far: unit tests pass; idempotency, outbox and inbox integration tests pass on PostgreSQL 18, including a 25-way concurrent same-key test. Not yet run: full `make test`, `make lint`, `make test-integration`, `make vuln`.

To change in module 1: `Makefile` (migrate targets), a new `cmd/migrate` or
`internal/platform/migrate`, `internal/platform/db` (tenant session),
`internal/platform/outbox/relay.go` (parking), `docs/OPEN_QUESTIONS.md`
(Q26 to Q28), a new ADR 0005 (migrations and tenant isolation).

## 5. Migration risks

- No production database exists and there is no data, so no risk of data loss today.
- **Risk once data exists:** edits to applied migrations (F2) and concurrent runs (F3). Fix these before the first real migration.
- RLS (F6) changes query behaviour. It must be introduced with the first table, not retrofitted.

## 6. Decisions needed before module 1

| # | Decision | Proposal |
|---|---|---|
| D1 | Initialise git (F1)? | Yes, before any further change |
| D2 | Keep the pre-brief M1 code as the starting point for module 1? | Yes; finish its verification within module 1 |
| D3 | ID storage form (F12) | Prefixed text with a format `CHECK` |
| D4 | Maximum amount (F13) | 15 digits |
| D5 | Idempotency retention (F9) and rounding policies (F8) | Not invented: keys kept indefinitely, fractional results refused, until owners approve |
