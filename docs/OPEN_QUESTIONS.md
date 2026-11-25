# Open questions

Each question records a conflict or gap in the specs. Code follows the
"Proposed" answer until an owner decides; the decision then goes into an ADR.

**Payments review (closed 2026-11-16):** the owner approved Payments `251e46e`
and confirmed that **Q29–Q34 stay open** as owner decisions. Until each is
decided, the conservative "Proposed" behaviour stays in force: no invented event
names (Q30), retry limits (Q31), escalation times or default expiry (Q32),
cancellation rules (Q33) or authentication mechanism (Q34). Q1 and Q26–Q28 are
also still open.

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
| Q15 | Console-only identifier prefixes: `xa_` (exceptional-access grant), `ben_` (beneficiary, from the 04-05 example), `po_` (payout, from the 04-05 example), `ten_`, `cell_` | ADR 0001 §6 lists pi_, op_, re_, mer_ only | Add `po_`, `ben_` to ADR 0001 §6; `xa_` stays console-internal. **`ten_` (2026-11-25):** now used by BC-01 `merchant.tenants` as `ten_` + UUIDv7, proposed in ADR 0001 §6 pending approval | M2 | Payments, Security |
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
| Q35 | (a) No spec defines tenant lifecycle states (e.g. suspended or closed tenants), although 02-02 §2.3 requires an active membership and live grant. (b) 04-03 §4 marks the merchant states as "Proposed canonical states" and gives no transition rules for SUSPENDED and CLOSED (for example, whether CLOSED is final) | 01-03 "tenant", 02-02 §2.3 vs 04-03 §4 | `merchant.tenants` has no status column. `merchant.merchants.status` accepts the eight 04-03 states (upper case); the database fixes identity, tenant and environment and requires revision +1 per update, but enforces no transition graph until the BC-01 reducer is specified | Before tenant suspension or merchant onboarding | Product, Compliance |
| Q36 | Tenant memberships hold the merchant personas only. How are platform-staff grants (POR, PFIN, PRISK, PRECON, PCOMP, PSEC, PIAM, PSRE, PSUP, PPSP, SUPER_ADMIN) stored and scoped, given 02-02 "No default cross-tenant search" and that no tenant, legal-entity or environment boundary may be bypassed, even by super administration? Also: are invitations (TENANT.USERS.INVITE, "Invitation TTL") and pending maker-checker requests stored by BC-01, and is "never grant above delegator" checked in the database or only in the application? | 02-02 §0.3 (boundaries), §01 (cross-tenant search), §3 Identity/Tenancy register; 03-05 §10.1 | `merchant.memberships` (2026-11-25): one approved, effective grant per row, keyed by the verified (issuer, subject); maker ≠ checker ≠ member enforced by CHECK; revocation final; forced tenant RLS plus a SELECT-only policy for the caller's own active grants. Staff grants, invitations and the delegator rule are not built; the console keeps its in-memory directory until they are. **Lead (2026-11-25): follow 02-02 and 03-05; where they are silent, choose the safest option. Answered item by item in [Q36 decisions](#q36-decisions-2026-11-25) below** | Before the Go principal resolver (plan step 5) | Security, Product |
| Q37 | Which HTTP status and trace behavior apply when the gateway authenticates requests (plan step 6), where 02-02 §6.3, 03-05 and 04-01 leave choices open? | 02-02 §2.3, §6.3; 04-01 §8; 03-05 §6.2 | Answered item by item in [Q37 decisions](#q37-decisions-2026-11-25-request-authentication-and-response-codes) below; defaults pending lead review | Before the gateway serves real traffic | Security, API Council |
| Q25 | 02-02 §03 grants `PAYMENT.READ` only to MOWN, MOPS, MFIN, MVIEW, POR. Should Finance (PFIN), Reconciliation (PRECON) and Risk (PRISK) also open individual payment records, e.g. to investigate a reconciliation break or a risk alert? | 02-02 §03 register vs the roles' stated intent ("approve reconciliations", "review risk alerts") | Follow the register: these roles see counts (and amounts for PFIN/PRECON), the payout queue and settlement where their own register rows allow, but no payment records. Risk details on a payment need `RISK.CASE.READ` (PRISK, PCOMP, POR); payout counts need `PAYOUT.READ` (MFIN, PRECON, PFIN); settlement needs `LEDGER.READ` (MFIN, MVIEW, PRECON, PFIN). Pinned by `backend/test/dashboard.test.ts` | Console | Product, Security, Financial Engineering |
| Q24 | Should Super Admin see the Overview dashboard? With aggregate-count access it could filter Overview to one merchant and see that merchant's fraud rate, success rate, settlement status and pending payouts | 03-05 §10.1 ("default dashboard shows service health, counts and redacted tenant metadata") vs 01-05 §07 Overview | No. Super Admin holds only `area.platform` and `health.view`, lands on the Super Admin page, and `/overview/*` returns 403. Platform counts follow the selected environment; LIVE returns 503 (ADR 0003) | Console | Security, Product |
| Q18 | The §07 side rail lists 12 items, but 03-05 §10.1 gives Super Admin a coordination view (health, counts, redacted tenant metadata) and 02-02 WF-002 a role-administration screen; neither fits a §07 item | 01-05 §07 vs 03-05 §10.1 and 02-02 WF-002 | Add two items after the 12: "Access" (MOWN, PIAM, PSEC; `area.access`; WF-002) "Exceptional access" (PSUP, PSRE, PSEC; ADR 0004) and "Super Admin" (Super Admin only; `area.platform`; alongside the Overview dashboard) | Console | Product, Security |

## Q36 decisions (2026-11-25)

The lead's instruction for Q36: follow 02-02 and 03-05; where they are silent,
choose the safest option (deny by default, fail closed, no bypass of tenant
isolation). **Spec** rows follow the cited text. **Default** rows are
**decided by default, pending lead review**.

| # | Topic | Decision | Basis |
|---|---|---|---|
| 36.1 | Platform staff and tenant data | Staff personas (POR, PFIN, PRISK, PRECON, PCOMP, PSEC, PIAM, PSRE, PSUP, PPSP, SUPER_ADMIN) get **no standing tenant data access**: no wildcard tenant, merchant or environment scope. | **Spec:** 03-05 §4.1 "Roles never imply universal object visibility", "Human roles are scoped to exact tenant/merchant/cell"; 02-02 §0.3 no boundary bypass "including by super administration, customer support"; PSUP "No default cross-tenant search"; 03-05 §10.1 |
| 36.2 | How staff reach merchant data | Only through exceptional access (support JIT, break-glass): ticket, independent approver, read-only, expiring, owned by BC-08 (ADR 0004). Not through `merchant.memberships`, which accepts the five merchant personas only. | **Spec:** 03-05 §10.1–10.2; 02-02 `support_access` "Strict JIT TTL and read-only default"; ADR 0004 |
| 36.3 | Standing, tenant-scoped staff grants (for example POR assigned to one merchant) | **Not built; staff hold nothing until a staff-grant model is approved.** The Go resolver gives staff no tenant scope. The console's in-memory directory still gives staff wildcard scope, which conflicts with 36.1; it is replaced when the console reads grants from Go (ADR 0003). | **Default** (the specs require scoped staff roles but do not say where they are stored) |
| 36.4 | Super Admin | Coordination only: health, counts, redacted tenant metadata. Holds no tenant grant and is not a requester or approver of tenant grants. | **Spec:** 03-05 §10.1; Q19, Q24 |
| 36.5 | Which grants count | Only approved, unrevoked grants inside their validity window. Proposed or pending grants, invitations and approval requests confer **nothing**. | **Spec:** 03-05 §13.1 grant states; 02-02 §2.3 `live_grant`, "Unknown, stale … DENY" |
| 36.6 | Grant validity window | Every grant has a required `effective_from` and `expires_at`; both are immutable. There is no open-ended grant. | **Spec:** 03-05 §13.1 "Every grant has … effective_from, expires_at"; 02-02 §6.1 `tenant_membership.expires_at` |
| 36.7 | Maximum grant duration | Not invented. Expiry is required, but no maximum is set until Security sets one (02-02 entitlement review and recertification). | **Default** (spec silent on a number; same approach as Q32) |
| 36.8 | Grant suspension (03-05 §13.1 SUSPENDED) | Not supported. Revocation is final; reinstating access needs a new grant with a new maker and checker, so access is never silently restored. | **Default** (spec lists the state but not who may lift it) |
| 36.9 | Grant version | Grants are immutable rows; any change is revoke plus new grant, so the membership ID identifies the grant version. | **Default** (02-02 requires "version"; immutability gives it without a counter) |
| 36.10 | Invitations | Single use, expiring, tenant-scoped; an accepted invitation grants nothing until an approved grant exists; expired or replayed → deny. **Not built yet.** The expiry has no default value: it must be configured. | **Spec:** 02-02 TENANT.USERS.INVITE "Invitation TTL; tenant scope", JRN-01, AT-013, AT-014. **Default:** no TTL value invented |
| 36.11 | Pending approvals | Role-grant requests follow the 03-05 §9.2 approval state machine and the 02-02 §6.1 `approval_request` model (maker, approver, object hash, policy snapshot). Stored by BC-01 when built; confer nothing while pending. **Not built yet.** | **Spec:** 03-05 §9.2, 02-02 §6.1. **Default:** owner BC-01 |
| 36.12 | "Never grant above delegator" meaning | The maker and the checker must each hold a **live MOWN** grant for the same tenant and environment whose scope covers the new grant (a merchant-scoped MOWN covers only that merchant), and the new grant may not expire later than theirs. Self-grant and self-approval are already refused. | **Spec:** 02-02 TENANT.ROLE.GRANT, JRN-03, AT-016, AT-020, `role_grant` "Grant cannot outlive source mandate"; 03-05 §11.1. **Default:** MOWN is the only merchant persona that may grant |
| 36.13 | PIAM as maker or checker | Not possible until staff grants exist (36.3): a PIAM's authority cannot be verified, so it is refused. | **Default** (02-02 names PIAM; 03-05 §4.2 says an identity administrator "cannot directly create a payment transaction authorization grant") |
| 36.14 | First owner of a new tenant | Created only by governed tenant provisioning, never through the ordinary grant path. **Not built:** 05-03 (tenant provisioning) is missing. | **Spec:** 03-05 §2.1 tenant_id "Only governed tenant provisioning". **Default:** no bootstrap shortcut |
| 36.15 | Where the delegator rule is enforced | In the database (a trigger on new grants) **and** in the application, so an application bug cannot create an over-broad grant. Built with grant administration; step 5 builds only the read side. | **Default** |
| 36.16 | Sandbox and production principals | The environment comes from the deployment's configuration, never from the request. A subject with live grants in **both** TEST and LIVE is refused as ambiguous. | **Spec:** 02-02 §2.4 "distinct principals", §2.3 ambiguous → DENY, AT-008. **Default:** refuse the whole principal rather than pick one environment |
| 36.17 | Cell scope of grants | 03-05 §4.1 scopes human roles to a cell, but no cell registry exists (05-03 missing). Grants carry no cell, and the resolver gives **no** cell authority: any decision that needs a cell must deny until cells are modelled. | **Spec** requirement noted; **Default:** fail closed |
| 36.18 | Human vs service identities | Not modelled yet (02-02 §6.1 `identity_subject.subject_type`). Meanwhile only the console client's access tokens carry the gateway audience (ADR 0007), so service-account tokens are refused before grants are read. | **Spec:** 02-02 SOD-11, AT-009. **Default:** keep service clients off the gateway audience |
| 36.19 | Revocation timing | Grants are read on every request, with no cache, so a revoked grant denies on the next request even while the token is unexpired. | **Spec:** 02-02 AT-005, AT-015; 03-05 §7.2 |

## Q37 decisions (2026-11-25): request authentication and response codes

Plan step 6 connects the token verifier (ADR 0007) and the principal resolver
(Q36) to the gateway's first route, `GET /v1/merchants/{merchant_id}` (04-03
`getMerchant`). Same convention as Q36: **Spec** rows follow the cited text;
**Default** rows are **decided by default, pending lead review**.

| # | Topic | Decision | Basis |
|---|---|---|---|
| 37.1 | Trace ID | The server generates one random ID per request (32 lower-case hex, the W3C trace-id format) and returns it on **every** response, including health checks, as `X-Trace-Id`, and in every error body as `trace_id`. Client-supplied `X-Trace-Id`, `X-Request-Id` and `traceparent` are never trusted or echoed. | **Spec:** 04-01 `X-Request-Id` "server-issued … accept client hint only as untrusted data", `Traceparent` "not accepted as identity". **Default:** the `X-Trace-Id` name and format (lead's rule; not in the specs) |
| 37.2 | Request ID | The same value is also returned as `X-Request-Id` and `request_id`, which 04-01 requires, so support and logs need one ID only. | **Spec:** 04-01 §8. **Default:** one value for both |
| 37.3 | Authentication failures | Missing, malformed, badly signed, expired, wrong-issuer or wrong-audience tokens all get **401** `authentication_required` with one identical generic body and `WWW-Authenticate: Bearer`. The specific reason goes only to the log, never a token. | **Spec:** 02-02 §6.3 "401: no authenticated identity"; RFC 6750 §3. **Default:** one body for all reasons |
| 37.4 | Dependency outages | Signing keys unavailable or grants unreadable: **503** `temporarily_unavailable`, never a permissive fallback. | **Spec:** 02-02 §6.3, AT-004 |
| 37.5 | 404 or 403 | **404** whenever the caller has no grant covering the resource: another tenant's merchant, a sibling merchant without a relation, another environment, or an unknown or malformed ID. All get the same body. **403** only when a grant covers the resource but lacks the permission. | **Spec:** 02-02 §2.3 "shall not reveal whether another tenant or merchant exists", §6.3 "use 404 masking", AT-006, AT-007. **Default:** masking also applies within a tenant |
| 37.6 | Where lookups run | Only in the caller's own tenants whose grants cover the requested merchant, one tenant transaction (`db.InTenantTx`) each, so row-level security applies. Other tenants' rows are never queried, so timing cannot reveal them either. | **Spec:** 03-05 §6.2; lead's rule 6. **Default:** query nothing outside the caller's scope |
| 37.7 | Valid token, no live grant | Nothing to search: **404** on resource routes, like 37.5 (deny by default). | **Default** |
| 37.8 | Subject with grants in TEST and LIVE (36.16) | **403** `permission_denied`, generic detail. | **Default** |
| 37.9 | Cell and legal entity in tenant transactions | The caller has no cell authority (36.17), so the session's `zp.cell_id` and `zp.legal_entity_id` are set to `zp:none`, which no real record carries. Any policy that checks a cell then denies. | **Default:** fail closed |
| 37.10 | Permissions | `MERCHANT.PROFILE.READ` = MOWN, MOPS, MFIN, MVIEW. POR is in the 02-02 register but is a staff persona with no tenant grants (36.1). Only permissions used by a route are added; the rest come with their routes. | **Spec:** 02-02 §3 Merchant actions. **Default:** add permissions route by route |
| 37.11 | Merchant status on the wire | Lower case (`draft`), following ADR 0001 §2 and Q29's proposal, although the 04-03 example shows `DRAFT`. | Follows Q29 (open) |
| 37.12 | Merchant response fields | `id`, `object`, `display_name`, `status`, `revision`, `created_at`, `updated_at`, plus `ETag: "merchant-rev-N"`. `business_model` and `country_of_establishment` are not stored yet, so they are omitted rather than invented. | **Spec:** 04-03 §6 example. **Default:** omit unstored fields |
| 37.13 | Logging | One line per request: trace ID, method, path without query, status and duration. Never the `Authorization` or `Cookie` header, the query string, the body or a token; tests capture the log and search it for the token. | **Spec:** 04-01 "Never include tokens"; 02-02 §6.4. **Default:** fields logged |
| 37.14 | Deployment environment | `ZP_ENVIRONMENT` (TEST or LIVE) is required, with no default. The gateway refuses to start without it. | **Default** (36.16 needs a configured environment) |
| 37.15 | Unknown routes under `/v1` | Authentication runs first, so an unauthenticated caller gets 401 for every `/v1` path and cannot discover which routes exist. Authenticated unknown routes get a 404 problem. | **Default** |

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
