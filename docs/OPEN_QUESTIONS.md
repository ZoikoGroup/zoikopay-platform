# Open questions

Each question records a conflict or gap in the specs. Code follows the
"Proposed" answer until an owner decides; the decision then goes into an ADR.

| # | Question | Sources in conflict | Proposed | Needed by | Owner |
|---|---|---|---|---|---|
| Q1 | Is `amount_minor` a JSON string (`"1999"`) or a JSON integer (`1999`)? | 02-05 and 02-06 say string; 02-01, 01-05, 01-09 and 04-10 examples show integer | String (ADR 0001 §3) | M2 OpenAPI | CTO, Payments |
| Q2 | Is money stored as `BIGINT`/`int64` or `NUMERIC(38,0)`? | 02-05 says NUMERIC(38,0); build prompt says int64 | `int64` with an API maximum (ADR 0001 §3) | M1 money | CTO, Financial Engineering |
| Q3 | Does 02-05's `currency_spec_version` field go on every Money value on the wire? | 02-05 shows it on Money; other specs omit it | Not on the wire for the pilot; stored with the intent | M1 money | Payments |
| Q4 | Status-name drift: 04-01 `requires_action` vs 06-01 `requires_customer_action`; 01-03 intent states `CREATED`/`CAPTURED`/`AUTHORIZED` | 04-01, 01-03 vs 06-01 | 06-01 wins (ADR 0001 §2) | M2 | Payments |
| Q5 | Separate logical databases per deployable, or one database with a schema and a role per context? | 03-03 §5.1 | Schema plus role per context (ADR 0002 §2) | M1 | CTO, Security |
| Q6 | Is a PostgreSQL outbox relay acceptable instead of a durable broker for the pilot? | 03-03 §5.1 vs build prompt | Yes (ADR 0002 §3) | M1 | CTO |
| Q7 | BC-02 is listed as "A/D" in 03-02. 03-03 proposes ADR-03: D is the only policy authority and A and B only enforce. Has the Architecture Board signed it? | 03-02 vs 03-03 | Follow 03-03 | M4 | Architecture Board |
| Q8 | Which market, PSP, payment method and merchant cohort is the pilot? | 03-02 §14 P0 gaps | Unknown; mock PSP only until G0/G2 | M5 | Legal, Partnerships |
| Q9 | What S3-compatible store is approved for evidence objects, now that MinIO community images are withdrawn? | Build prompt names MinIO | Frozen `bitnamilegacy/minio` locally only | M6 | Platform |
| Q10 | 04-03 uses merchant prefix `mrch_` (e.g. `/v1/merchants/mrch_example_001`); every other spec uses `mer_`. No spec defines a refund prefix. | 04-03 vs the v3.0 Gap Analysis, 02-05, 02-09, 04-06, 03-06, 06-01 and wireframe 07 | `mer_` (majority, incl. 06-01); 04-03 to be corrected. `re_` for refunds (ADR 0001 §6) | M2 | Payments, Integrations |
| Q11 | sqlc cannot run with zero modules or a module with no queries. Is it acceptable that `make gen` skips sqlc until a module has its first query? | Founder brief asks for sqlc wired with empty placeholders | Yes; `make gen` prints "skipped" | M1 | Engineering |
| Q12 | Persona codes differ: the Business Requirements screens use `PAY-OPS`, `PAY-FIN`, `PAY-COMP`, `PAY-RISK`, `PAY-SEC`, `MER-OWNER`, `MER-OPS`, `MER-FIN`, `MER-DEV`, plus `PAY-PROD`, `QA`, `PAY-QA`, `CTO`, `AUD-RO`, which have no 02-02 equivalent. 02-02 uses `POR`, `PFIN`, `PCOMP`, `PRISK`, `PSEC`, `MOWN`, `MOPS`, `MFIN`, `MDEV`, … | 01-05 §07 vs 02-02 | Console enforces 02-02 codes; BR codes are shown on screen specs only. Map PAY-OPS→POR, PAY-FIN→PFIN, PAY-COMP→PCOMP, PAY-RISK→PRISK, PAY-SEC→PSEC, MER-*→M*. Define PAY-PROD, QA, CTO, AUD-RO in 02-02 | Console screens 001, 006, 009, 014 | Product, Security |
| Q13 | No 02-02 persona is given routing access, so the Routing item (ZP-BRW-006) is hidden for everyone | 02-02 vs 01-05 (006 personas PAY-PROD, PAY-OPS, PAY-COMP) | Grant `routing.read` once Q12 maps PAY-PROD | Console 006 | Product |
| Q14 | Settlement batch states (`RECONCILED`, `AWAITING_EVIDENCE`, `EXCEPTION`) shown on the Overview are console fixture vocabulary; the 09-series reconciliation specs that own them are not supplied | Missing 09-03 … 09-12 | Replace when the specs arrive | Console 009 | Financial Engineering |
| Q15 | Console-only identifier prefixes: `xa_` (exceptional-access grant), `ben_` (beneficiary, from the 04-05 example), `po_` (payout, from the 04-05 example), `ten_`, `cell_` | ADR 0001 §6 lists pi_, op_, re_, mer_ only | Add `po_`, `ben_` to ADR 0001 §6; `xa_` stays console-internal | M2 | Payments, Security |
| Q16 | Brand colours: Business Requirements §07 specifies "Zoiko Pay official navy/green"; the console brief mandates black and white only | 01-05 §07 vs console brief | Black and white, as the brief requires | Console | Brand, Product |
| Q17 | ZP-BRW-001 is a requirements-traceability "control center", not an operations dashboard; the console brief calls the dashboard "Control Center" | 01-05 §07 vs console brief | Overview is the dashboard; 001 is a separate, not-yet-built screen under QA & Release | Console | Product |
| Q19 | Can Super Admin request exceptional access? 03-05 §10.1 lets Super Admin coordinate; 02-02 names only PSUP as requester (approver PSEC) and PSRE/PSEC for break-glass | 03-05 §10.1 vs 02-02 §3, WF-007, WF-011 | No: Super Admin sees counts of grants only (ADR 0004) | M4 | Security |
| Q20 | Maximum duration of exceptional access is not given ("Max scope + TTL") | 02-02 §3 | Support JIT 4 hours, break-glass 2 hours, no extension (new request instead) | M4 | Security |
| Q21 | How long an unapproved request stays open, and how soon a review is due | 03-05 §10.2 | Request lapses after 30 minutes; review due within 2 business days | M4 | Security |
| Q22 | Which ticketing system supplies ticket and incident ids, and how merchant consent (WF-007) is recorded | 02-02 WF-007, WF-011 | Free-text ticket id with a fixed format until a system is chosen; consent reference stored as text | M4 | Support, Legal |
| Q23 | 02-02 lists a DPO and PAUD for export and access review, but neither is a persona in the register | 02-02 §3 | PSEC covers both in the pilot | M4 | Security, Privacy |
| Q26 | What is the maximum amount of a single transaction? | Q2 ("int64 with an API maximum"); 02-05 (explicit maximum magnitude) | **Provisional (owner decision 2026-11-16): 15 digits in minor units per transaction**, `BIGINT`, overflow-protected. Does not apply to balances, ledger totals or aggregates. ADR 0005 §3 | Before Payments goes live | CTO, Financial Engineering |
| Q27 | How long are idempotency records retained, and when may full responses be stored? | 04-08 §6.2 proposes "≥ 30 days", pending approval | Identities (scope, key digest, fingerprint, operation) are **never deleted**; enforced by trigger and grants. Only status and resource reference are stored; full response bodies wait for an approved retention policy. ADR 0005 §5 | Before Payments goes live | Payments, Finance, Legal, SRE |
| Q28 | Which rounding policies (02-05 §2.3: HALF_EVEN, HALF_UP …, per basis) are approved? | 02-05 requires a versioned, approved RoundingPolicy | None approved: arithmetic is exact and any result needing rounding returns `ErrRoundingPolicyRequired`; posting is blocked. ADR 0005 §3 | Before fees, FX or allocations | Finance |
| Q29 | Wire casing of status and enum values: 04-02 §5.1 requires UPPER CASE in the OAS contract; ADR 0001 §2 and 06-01 §11.2 use lower case on the wire | 04-02 §5.1 vs ADR 0001 §2, 06-01 §11.2 | Lower case (ADR 0001); internal events and the database use upper case. Needs an API Council decision (06-01 DEC-09) | Before any external API release | API Council |
| Q30 | The 04-06 registry has no event for an intent becoming FAILED, CANCELED or EXPIRED, for a cancel request in flight, or separate command types for capture and void | 04-06 §5 registry vs 06-01 §5 | Capture and void travel as `payment.attempt.requested.v1` with `operation_kind`; terminal outcomes are only in the transition audit until the registry adds events. No event names invented (ADR 0006 §5) | Before BC-09 notifications | Payments, Event Platform |
| Q31 | 06-01 allows a retry after a retryable decline "within policy budget" but no budget is defined | 06-01 §5.1 | BC-03 counts nothing; BC-04/BC-02 classify retryable vs final (and `retry_eligible` for no-effect proofs) | Before pilot | Payments, Risk |
| Q32 | How long may an operation stay PENDING/UNKNOWN before a recovery case opens, and is there a default intent expiry? | 06-01 §12 ("inherit approved 02-04 and partner contracts; do not invent") | No defaults: the escalation horizon must be configured; intents expire only if the merchant sets `expires_at` (ADR 0006 §6) | Before pilot | SRE, Payments, PSP |
| Q33 | Can an intent in REQUIRES_PAYMENT_METHOD (e.g. after a retryable decline) be canceled? The 06-01 §5 matrix has no such transition | 06-01 §5.1 vs 04-02 §6.4 | Refused (409) until the matrix adds it; the intent can still expire via `expires_at` | Before pilot | Payments |
| Q34 | How does D1 authenticate to D2's private payment command API (mTLS, signed service token), and how are tenant/merchant/cell claims carried? | 03-03 §4 "A caller identity plus tenant/merchant/legal-cell claim required" | Not built; the payment HTTP handler requires an Authenticator and is not mounted in `cmd/execution` (ADR 0006 §7) | M4 | Security, Platform |
| Q25 | 02-02 §03 grants `PAYMENT.READ` only to MOWN, MOPS, MFIN, MVIEW, POR. Should Finance (PFIN), Reconciliation (PRECON) and Risk (PRISK) also open individual payment records, e.g. to investigate a reconciliation break or a risk alert? | 02-02 §03 register vs the roles' stated intent ("approve reconciliations", "review risk alerts") | Follow the register: these roles see counts (and amounts for PFIN/PRECON), the payout queue and settlement where their own register rows allow, but no payment records. Risk details on a payment need `RISK.CASE.READ` (PRISK, PCOMP, POR); payout counts need `PAYOUT.READ` (MFIN, PRECON, PFIN); settlement needs `LEDGER.READ` (MFIN, MVIEW, PRECON, PFIN). Pinned by `backend/test/dashboard.test.ts` | Console | Product, Security, Financial Engineering |
| Q24 | Should Super Admin see the Overview dashboard? With aggregate-count access it could filter Overview to one merchant and see that merchant's fraud rate, success rate, settlement status and pending payouts | 03-05 §10.1 ("default dashboard shows service health, counts and redacted tenant metadata") vs 01-05 §07 Overview | No. Super Admin holds only `area.platform` and `health.view`, lands on the Super Admin page, and `/overview/*` returns 403. Platform counts follow the selected environment; LIVE returns 503 (ADR 0003) | Console | Security, Product |
| Q18 | The §07 side rail lists 12 items, but 03-05 §10.1 gives Super Admin a coordination view (health, counts, redacted tenant metadata) and 02-02 WF-002 a role-administration screen; neither fits a §07 item | 01-05 §07 vs 03-05 §10.1 and 02-02 WF-002 | Add two items after the 12: "Access" (MOWN, PIAM, PSEC; `area.access`; WF-002) "Exceptional access" (PSUP, PSRE, PSEC; ADR 0004) and "Super Admin" (Super Admin only; `area.platform`; alongside the Overview dashboard) | Console | Product, Security |

## Missing documents

The Master Register lists **199** engineering documents (ZP-EDS-01-01 to
ZP-EDS-19-10). Only **51** are in `docs/` (see `docs/spec/INDEX.md`).

**03-03 and 03-04 are not missing.** The founder brief lists them as missing,
but they are present: 03-03 is `Zoiko_Pay_Document_27_Topology_Module_Contracts.docx`
and 03-04 is `Zoiko_Pay_Document_28_Regional_Cell_Residency_Legal_Entity_Architecture.docx`.

Missing, by group:

| Group | Present | Missing |
|---|---|---|
| 01 Charter and governance | 01-01 to 01-12 | none |
| 02 Product requirements | 02-01 to 02-12 | none |
| 03 Architecture | 03-01 to 03-10 | 03-11 |
| 04 API and integration | 04-01 to 04-11 | 04-12 |
| 05 | none | 05-01 to 05-09 |
| 06 Payment lifecycle | 06-01 | 06-02 to 06-12 |
| 07 | 07-02 | 07-01, 07-03 to 07-10 |
| 08 | none | 08-01 to 08-09 |
| 09 Ledger | 09-01, 09-02 | 09-03 to 09-12 |
| 10, 11, 12 | none | all (10-01 to 10-10, 11-01 to 11-10, 12-01 to 12-10) |
| 13 | 13-01 | 13-02 to 13-12 |
| 14 to 19 | none | all (14-01 to 19-10) |

The skeleton does not need any of them. Each later milestone must confirm
its governing documents exist before it starts.
