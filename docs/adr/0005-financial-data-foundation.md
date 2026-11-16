# ADR 0005: Financial data foundation (shared platform, Module 1)

- Status: **PROPOSED**. Decisions 1 to 5 below were approved by the project owner on 2026-11-16 for Module 1. Items marked *provisional* await their formal owners.
- Date: 2026-11-16
- Brief: "Engineering Implementation Brief: Financial Data Integrity, Transaction Safety and Database Reliability"
- Baseline: [docs/reports/2026-11-16-stage1-baseline.md](../reports/2026-11-16-stage1-baseline.md)
- Specs: 02-05 (money), 04-01 §8 (errors), 04-06 (events), 04-08 (idempotency), 03-03 §5 (data ownership), 03-05 (authorization)
- Related: ADR 0001 (contract freeze), ADR 0002 (module boundaries), OPEN_QUESTIONS Q2, Q3, Q26 to Q28

## 1. Context

No module has tables or data yet (baseline §1). Every business module will
need the same money, identifier, idempotency, event, migration and security
rules. They live once in `internal/platform/` so each module uses them
rather than re-implementing them.

## 2. Identifiers (decision 3)

Four kinds, never interchanged:

| Kind | Form | Where | Enforced |
|---|---|---|---|
| Internal ID | UUIDv7 (`uuid`) | primary keys | `ids.InternalIDCheckSQL`: `uuid_extract_version(id) = 7` |
| Public ID | prefix + 32 hex of an independent UUIDv7 (`pi_…`, `op_…`, `re_…`, `mer_…`) | API, events, logs | `UNIQUE` + `ids.PublicIDCheckSQL` regex (prefix, version and variant nibbles) |
| Event ID | canonical UUIDv7 | CloudEvents `id`, outbox PK | outbox `CHECK (uuid_extract_version(event_id) = 7)` |
| Idempotency key | client-chosen UUID | `Idempotency-Key` header | stored only as a SHA-256 digest |

New prefixes (for example `inv_`) are added when their resource is built
(OPEN_QUESTIONS Q10, Q15), never ad hoc.

## 3. Money (decisions 4 and 5)

- `BIGINT` minor units plus an explicit ISO currency; never floats.
- **Per-transaction limit (provisional):** 15 digits, `money.MaxTransactionMinor`,
  enforced in Go (`ParseTransaction`) and in SQL (`TransactionAmountCheckSQL`).
  It does **not** apply to balances, ledger totals or aggregates; those are
  only protected against int64 overflow (`ErrOverflow`). (Q26)
- Currency precision: versioned registry (`SpecVersion iso-2026-11-r1`) with
  ISO exponents; unknown currencies fail closed; SQL `CurrencyCheckSQL`.
- **Rounding:** no policy is approved (02-05 §2.3). Arithmetic is exact
  (`MulDivExact` uses big integers). Any result with a fractional minor unit
  returns `ErrRoundingPolicyRequired`, and **financial posting must be
  blocked**. Nothing rounds silently. (Q28)

## 4. Migrations

### 4.1 Runner

`cmd/migrate` (`internal/platform/migrate`) replaces running the goose CLI.
It keeps goose's **file format** (`-- +goose Up`, `NO TRANSACTION`), so files
stay readable by goose tooling. It adds what the goose CLI lacks:

| Need (brief stage 5) | How |
|---|---|
| Checksums | SHA-256 of each applied file in `zp_migrations.history`; a changed or missing applied file stops the run **before anything is applied, in any module** |
| Execution history | `zp_migrations.history`: module, version, file, checksum, applied_at, applied_by, duration, runner version; append-only (trigger refuses UPDATE, DELETE, TRUNCATE, even by the owner); runtime roles cannot read it |
| Concurrency lock | one PostgreSQL advisory lock per run; others wait (default 60 s) then fail with `ErrLockTimeout` |
| Atomicity | each migration and its history row commit in one transaction; per-migration `lock_timeout` 10 s and `statement_timeout` 10 min |
| Order | versions apply in order per module; a pending file older than an applied one is refused (`ErrOutOfOrder`) |
| Ownership | one directory and one schema per module; history keyed by (module, version) |

Migrations are **forward-only**: `Down` sections never run. A mistake is
fixed with a new migration.

### 4.2 Platform tables per module

A module's first migration is generated, not hand-copied:
`go run ./cmd/migrate scaffold -module payment -writer zp_execution`. The
output comes from the same Go definitions the platform code uses
(`idempotency.TableSQL`, `outbox.TableSQL`, `inbox.TableSQL` and their
`GrantSQL`), so the SQL and the code cannot drift. Once committed and
applied, the file is checksummed like any other.

### 4.3 Expand–migrate–contract

1. **Expand:** add new tables, nullable columns and new indexes. Old and new application versions both work.
2. **Migrate:** deploy code that writes both shapes, and backfill if needed. A statement that rewrites or removes rows needs `-- zp:data-change <reason>`.
3. **Contract:** once no running version uses the old shape, remove it. `DROP`, `RENAME`, type changes and `SET NOT NULL` need `-- zp:contract <reason>`.

The runner refuses unannotated contract or data-change statements (it parses
statements, ignoring comments, strings and function bodies). Each annotation
is visible in review. Financial data is never converted silently.

## 5. Idempotency, outbox, inbox

- **Idempotency (04-08):** scoped unique key (12-column namespace), SHA-256
  fingerprint over RFC 8785 canonical JSON, `New / Replay / InProgress /
  Mismatch` outcomes, reservation in the business transaction. Response
  persistence: status code plus resource reference; full bodies wait for an
  approved retention policy. **Identities are never deleted:** a trigger
  refuses DELETE and TRUNCATE (even by the owner) and any change to a key's
  identity or a completed result; runtime roles have no DELETE grant. (Q27)
- **Recovery:** a key left `IN_PROGRESS` by a crash answers `409
  operation_in_progress` with the same operation ID until the operation is
  resolved (02-07 inquiry-first), then replays. A key is never "expired"
  into a fresh effect.
- **Outbox (04-06):** exact envelope bytes (`bytea`) written in the business
  transaction; per-aggregate order; `FOR UPDATE SKIP LOCKED`; bounded
  backoff. After `MaxAttempts` (default 10) an event is **parked**: it stops
  retrying, holds back later events of its aggregate, appears in
  `ListParked`, and returns only through `Requeue(actor, reason)`, which
  writes the append-only `outbox_requeue_log` in the same transaction.
  Stored events cannot be changed or deleted; the relay role can update
  delivery-state columns only.
- **Inbox:** `(consumer_id, event_id)` unique; processing shares the
  consumer's transaction; inbox rows are immutable.

## 6. Database security

- Roles (unchanged, tested): `zp_migrator` owns schemas and runs migrations;
  one runtime role per deployable; `zp_relay` for the relay. No runtime role
  is superuser, has BYPASSRLS, owns tables or runs DDL.
- Grants per module are least privilege: writer `SELECT, INSERT` plus
  column-level `UPDATE` on result or state columns; no `DELETE` anywhere in
  the platform tables.
- **Tenant isolation:** `db.InTenantTx` sets `zp.tenant_id` (plus
  environment, cell and legal entity) with `set_config(..., true)`, so the
  setting is local to the transaction and never leaks through the pool.
  Tenant tables use `ENABLE` + `FORCE ROW LEVEL SECURITY` with
  `tenant_id = current_setting('zp.tenant_id', true)`. With no tenant set,
  nothing is visible and nothing can be written (fails closed). Only the
  relay has a system policy, on the outbox only.
- Row-level security is defence in depth; application authorization
  (03-05) remains the primary control.
- Auditing: migrations (history), event requeues (requeue log). Business
  audit belongs to governance (M4) and is not invented here.

## 7. Consequences

- Every later module starts with `migrate scaffold`, tenant transactions and
  the shared money and ID checks.
- `make migrate` now runs `cmd/migrate`; `make test` also runs the offline
  migration checks (`migrate-verify`).
- Retention, rounding policies and the amount limit stay open (Q26 to Q28)
  and are enforced conservatively until decided.
