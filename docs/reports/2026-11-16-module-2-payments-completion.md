# Module 2 completion report: Payments (BC-03)

- Date: 2026-11-16
- Branch: `module-2-payments`, from the approved Module 1 baseline `fdce54f`; implementation commit `251e46e`
- Decisions: [ADR 0006](../adr/0006-payments-module.md); open items Q29 to Q34 (new), Q1 and Q26 to Q28 (unchanged, enforced conservatively)
- Not started: Ledger, refunds, connector (BC-04). Module 1 platform code unchanged.
- No production migration or financial operation was executed. The payment migrations were **not** applied to the local stack either: while the schema is under review it may still change, and applied migrations are immutable.

## 1. Requirement coverage

| Owner requirement | Status | Where | Evidence (tests) |
|---|---|---|---|
| Payment lifecycle and state transitions | **Met** for intents (06-01 §5.1, §5.2 without partial or multiple capture) | `domain/reducer.go`, `domain/observe.go` | 12 domain tests covering the matrix, forbidden transitions and evidence rules; lifecycle integration tests |
| Integer minor-unit amounts | **Met** | `BIGINT` + `CHECK`; strings on the wire | `TestFailClosedAndPrivacy` (16-digit amount refused), HTTP numeric and decimal amount refused |
| Currency validation | **Met** | registry check in Go and SQL | JPY, `gbp`, XXX refused (PI-AT-003) |
| Idempotency across retries and concurrency | **Met** | Module 1 registry on every POST | `TestDuplicateRequests`, `TestConcurrentRequests` (25 same key gives 1 op; 10 different keys give 1 accepted) |
| No duplicate financial effects | **Met** | one active operation (unique index), stable instruction key, observation dedupe, `economic_effect_id` unique | `TestTimeoutUnknownThenInquiryRecovers` (1 attempt, 1 key), `TestProviderEvidenceRules` (50 deliveries give 1 effect), `TestOutboxReconcilesWithState` |
| Transactional outbox and inbox | **Met** | `apply.go` (same transaction), `observe.go` (inbox) | `TestRelayRedeliversSameInstructionIdentity`, `TestEmittedEventsMatchTheirSchemas` |
| Failure recovery and event reconciliation | **Met** within BC-03 scope | unknown → inquiry event; `EscalateUnresolved`; `ExpireDue`; recovery cases | `TestRecoveryEscalation`, `TestExpirySweep`, `TestOutboxReconcilesWithState` |
| Tenant isolation and DB permissions | **Met** | forced RLS on every table; column-level grants; guards | `TestTenantAndMerchantIsolation`, `TestDatabaseGuards`, HTTP masked 404 |
| Versioned, independently tested migrations | **Met** | `db/migrations/payment/00001`, `00002` via the approved runner | `TestPaymentMigrationsAreRepeatable` (checksums recorded, re-run applies 0) |
| Complete auditability | **Met** | transition audit (one row per version), observations with disposition, command log including refusals, recovery cases | audit-gap check in `TestOutboxReconcilesWithState`; refusal audit in `TestFailClosedAndPrivacy` and `TestDuplicateRequests` |

## 2. Required test scenarios

| Scenario | Test | Result |
|---|---|---|
| Successful payment (automatic) | `TestSuccessfulAutomaticPayment` | `SUCCEEDED`; 1 command to BC-04; 1 capture fact; audit v1 to v4 |
| Successful payment (manual capture) | `TestManualAuthorizeAndCapture` | Authorized, then full capture, then `SUCCEEDED`; partial and over-capture refused |
| Declined payments | `TestDeclinedPayments` | Retryable → `REQUIRES_PAYMENT_METHOD` → new token → final → `FAILED`; no revival |
| Timeouts | `TestTimeoutUnknownThenInquiryRecovers` | Stays `PROCESSING` + `UNKNOWN`; same-key retry gives the same op; a new key is blocked; inquiry resolves; 1 attempt ever |
| Duplicate requests | `TestDuplicateRequests` | Replay gives the same resource; changed payload gives 422 with zero effect |
| Concurrent requests | `TestConcurrentRequests` | 25 same key → 1 op; 10 different keys → 1 accepted; confirm-versus-cancel race consistent (5 rounds) |
| Process crashes | `TestCrashDuringConfirmLeavesNoEffect` | **40 backends killed mid-transaction**; still exactly 1 op, 1 attempt, 1 command |
| Crash after commit, before BC-04 | `TestRelayRedeliversSameInstructionIdentity` | Redelivered with the **same** provider instruction key |
| Retries and recovery | `TestRecoveryEscalation`, `TestExpirySweep` | Stale unknown → case, never forced; in-flight intent never expired blindly |
| Late, duplicate and conflicting evidence | `TestProviderEvidenceRules` | Wrong account quarantined; 50 deliveries → 1 effect; late duplicate recorded; contradiction → `CONFLICTED` + frozen + case, status stays `SUCCEEDED` |
| Fail closed | `TestFailClosedAndPrivacy` | Policy deny → 403; policy down → 503; suspended after creation → confirm refused; bad token; PAN in reference refused |
| Direct SQL tampering | `TestDatabaseGuards` | `zp_execution` and even the owner are stopped (`42501` / `23001`) |
| API contract | `TestHTTPContract`, `test/contract` | 401 without auth; 400 without key; strict bodies; `Location` headers; masked 404; scoped pagination; no internal fields exposed |

## 3. Files

New:
- `internal/payment/domain/{types,reducer,observe}.go` + `reducer_test.go`
- `internal/payment/app/{service,commands,apply,observe,sweep,views}.go` + 4 integration test files
- `internal/payment/events/events.go`
- `internal/payment/http/handler.go` + integration test
- `internal/payment/store/*`: generated by sqlc from `db/queries/payment/payment.sql`
- `internal/apigen/executionapi/executionapi.gen.go`: generated from `api/openapi/execution.v1.yaml`
- `db/migrations/payment/00001_platform_tables.sql` (scaffolded), `00002_payment_core.sql`
- `api/events/payment/*.schema.json` (5 event schemas)
- `test/contract/idempotency_contract_test.go`
- `docs/adr/0006-payments-module.md`, this report

Changed: `sqlc.yaml` (payment module), `go.mod`/`go.sum` (+ `oapi-codegen/runtime`), `docs/OPEN_QUESTIONS.md` (Q29 to Q34), `CLAUDE.md`, `README.md`.

## 4. Verification run (2026-11-16)

| Check | Result |
|---|---|
| `make test` (race; includes `migrate-verify`: 1 module, 2 files) | pass, 12 packages |
| `make test-integration` (PostgreSQL 18.1) | pass, 14 packages; Payments: app 17, domain 12, http 2 tests |
| `make lint` (golangci-lint + Spectral) | 0 issues; Spectral clean |
| `make check-gen` | pass (generated code current) |
| `make vuln` on this branch (Go 1.26.4) | 22 findings, all standard library + the test-only `klauspost/compress`, fixed by the separate maintenance branch |
| `make vuln` on this branch **combined with** `maintenance/go-toolchain-1.26.11` (temporary, uncommitted merge) | **0 vulnerabilities**; merge clean; build and tests pass |

## 5. Unresolved issues (decisions needed)

| # | Issue | Proposed handling |
|---|---|---|
| Q29 | Wire enum casing (04-02 says upper case; ADR 0001 says lower case) | Lower case until API Council decides |
| Q1 | Amount as JSON string vs integer (04-02 §5.2 says integer) | String, per ADR 0001 |
| Q30 | No 04-06 events for FAILED, CANCELED, EXPIRED or cancel-requested | Audit only; no names invented |
| Q31 | Retry budget after retryable declines undefined | BC-04 and BC-02 classification decides |
| Q32 | Escalation horizon and default expiry undefined | Must be configured; no defaults |
| Q33 | Cancel from REQUIRES_PAYMENT_METHOD not in the 06-01 matrix | Refused (409) |
| Q34 | D1→D2 service authentication | Handler not mounted until built |
| Q26 to Q28 | Limit, retention, rounding | Unchanged, conservative |

## 6. Not built and why (prerequisites for a pilot)

1. **BC-04 Provider Connectivity:** dispatch, webhook verification, inquiry and the mock-PSP adapter. Payments is ready for it: commands out, normalized observations in.
2. **Refund aggregate (06-01 §8.3):** depends on Ledger approval.
3. **D1→D2 authentication**, and mounting the handler plus the sweepers and inbox consumer in `cmd/execution`.
4. **Merge** `maintenance/go-toolchain-1.26.11` before any deployment (security fixes).

## 7. Remaining risks

- The reducer is only as good as BC-04's normalization. A connector that maps provider strings wrongly would feed wrong evidence. Mitigations: exact amount and currency matching, quarantine of unknown outcomes, conflict freeze.
- Each step is a separate CAS update inside one transaction. This is correct and atomic, but means N small updates per multi-step command. Measure under load before the pilot (02-04 budgets).
- `work_schedule` is deliberately cross-tenant (identifiers only). Any future column added there must stay non-sensitive; review it as such.
- Relay ordering holds a parked event's later versions. A parked `attempt.requested` stalls that payment until requeued, which is intended but needs runbooks (SRE).
