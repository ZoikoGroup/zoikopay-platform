# Local code and documentation review — 2026-11-17

Baseline: `e6de47e` on `Naresh_65`. This is a design-level inventory and code cross-check, not a requirement-by-requirement compliance certification. The review inventories all 52 Word documents, extracts their text without modifying them, and examines their structure and selected governing requirements alongside the ADRs, open questions, completion reports, application wiring, contracts, and representative implementations. The Word specifications contain approximately 343,000 words; detailed conformance against every acceptance requirement remains separate work.

## 1. What the project is

Zoiko Pay is intended to orchestrate payments through approved payment providers. It owns payment intent state, transaction evidence, operational accounting, reconciliation, and the controls surrounding those activities. A payment service provider (PSP), acquirer, or bank executes the external financial activity assigned to it.

The specifications do not establish that Zoiko Pay is a bank, owns a license, holds customer funds, or has permission to activate every market. Those are evidence and approval questions. Wallets, remittance, custody, FX, cross-border funds movement, payouts, and additional rails require their own approved scope.

The intended separation of truth is particularly important:

- Zoiko iD owns identity assertions; Pay enforces access to Pay resources.
- Pay owns its payment lifecycle and operational subledger.
- Provider and bank evidence establishes external execution and settlement facts.
- Zoiko CoreX owns enterprise general-ledger accounting, including its acknowledgment of exports.
- Zoiko Assure supplies assurance evidence; it does not independently authorize payments.
- Zoiko Remit remains a separate remittance product and legal boundary.

An authorization is not a capture. A capture is not bank settlement. A successful API response is not proof that money reached a beneficiary. The documents repeatedly require these facts to stay separate.

## 2. How the code is arranged

| Location | Responsibility | Current state |
|---|---|---|
| `frontend/` | React/TypeScript operations console, port 5173 | Real source directory; routes, screens, session UI, permission-based navigation |
| `backend/` | Express/TypeScript backend for that console, port 4000 | Keycloak login, server-side access checks, TEST fixture services, in-memory workflows |
| `internal/platform/` | Shared Go foundation | Money, IDs, tenant transactions, idempotency, events, outbox/inbox, migrations, health/bootstrap |
| `internal/payment/` | BC-03 payment intent and lifecycle | Domain reducer, commands, observations, recovery, storage and HTTP adapter implemented |
| Other `internal/<module>/` directories | Merchant, eligibility, connector, ledger, reconciliation, billing, governance, notifications | Primarily package documentation/placeholders, not complete business implementations |
| `cmd/` | Executable service wiring and migration CLI | Six service programs plus `migrate`; service programs expose health infrastructure rather than wired payment business processing |
| `db/migrations/payment/` | Platform tables and payment schema | Two versioned SQL migration files; reports record application only in disposable test databases |
| `api/openapi/` | API contracts | Private execution/payment contract populated; public merchant and other service contracts remain placeholders |
| `api/events/payment/` | Payment event contracts | Five event schemas |
| `deploy/compose/` | Local dependency stack | PostgreSQL, Temporal, Keycloak, MinIO, Grafana stack |
| `zoiko-pay-console/` | Console documentation and combined launcher | Source was moved to the real root folders; this directory no longer owns frontend/backend source |

The documents call for four application deployables containing nine business contexts. These are different counts: a context is an ownership boundary, not necessarily its own running service. The repo also has a supporting outbox-relay program and a mock-PSP program, making six service programs locally.

| Business deployable | Program | Intended ownership |
|---|---|---|
| D1 / A: API and Merchant Control | `cmd/gateway` | Merchant ingress, public API, identity/merchant controls |
| D2 / B: Payment Execution | `cmd/execution` | BC-03 payments and BC-04 provider connectivity |
| D3 / C: Financial Integrity | `cmd/finance` | Ledger, reconciliation/settlement, billing |
| D4 / D: Governance and Intelligence | `cmd/governance` | Policy authority, risk/governance, communications/insights |

The current pilot proposal uses Go business modules, PostgreSQL schema ownership, one runtime role per deployable, Temporal locally, and a PostgreSQL outbox instead of a broker. These are recorded project choices, not evidence that every target-state infrastructure capability is deployed.

## 3. What is implemented and what remains

### Shared platform — Module 1

Implemented: integer minor-unit money; decimal strings on the API; checked arithmetic; currency validation; UUIDv7/internal versus public resource identifiers; scoped request deduplication; atomic outbox writes; inbox deduplication; ordered event delivery library; retries and parking; audited requeue; tenant row-level security; restricted database grants; checksummed, locked, forward-only migrations.

For example, GBP 19.99 is represented as `amount_minor: "1999"`, with `currency: "GBP"`. Financial amounts do not use floating-point arithmetic. The current currency registry accepts GBP, EUR and USD, not every ISO currency. The per-transaction amount limit is provisionally 15 digits. An exact calculation that produces fractional minor units is rejected until an approved rounding policy exists.

Two requests with the same idempotency key and same request are one logical operation. Reusing that key with different request content is refused. An unresolved operation is not forgotten simply because a retry timeout elapsed.

The relay library is implemented and integration-tested. `cmd/outbox-relay` does not instantiate and run it; that executable currently only provides health/dependency infrastructure. Library completeness therefore does not mean deployed event delivery is operational.

### Payments — Module 2 / BC-03

Implemented in the library and tests: create with a token reference, confirm, automatic success handling, full manual capture, cancellation/void paths, expiry, normalized provider observations, idempotency, audit history, recovery cases, evidence conflict handling, strict HTTP contracts and scoped persistence.

Its reducer is the sole state-transition authority. Internal states include `REQUIRES_PAYMENT_METHOD`, `REQUIRES_CONFIRMATION`, `REQUIRES_CUSTOMER_ACTION`, `PROCESSING`, `REQUIRES_CAPTURE`, `SUCCEEDED`, `FAILED`, `CANCELED` and `EXPIRED`. Although `PARTIALLY_CAPTURED` is defined in the canonical vocabulary, partial/multiple capture is disabled in the pilot implementation.

If a provider times out after a possible charge, the result is UNKNOWN. The system must obtain evidence before allowing another effect. It must not turn uncertainty into FAILED or dispatch a second charge through a different provider.

The private payment HTTP adapter exists, but `cmd/execution` does not mount it. Service-to-service authentication is not implemented. Provider dispatch, signed webhook verification, inquiry adapters and durable workflow wiring are also pending. Refunds are a separate aggregate and are not implemented as a Go financial capability.

### Console

Implemented: sign-in against local Keycloak, sessions, server-side role/resource checks, dashboard and navigation, payment explorer, operations screens, access administration, exceptional-access demo flows, search, notifications, exports and audit views. Individual wireframe actions remain incomplete; a visible page does not establish full workflow coverage.

Payment/merchant/payout/settlement business records are generated TEST fixtures. Screen decisions change in-memory records, not PSP transactions or ledger postings. LIVE never silently falls back to TEST records. System-health probes are real. Account registration/password operations use the configured identity integration.

Membership seeds, access state, exceptional grants, sessions, screen decisions and console audit records are development implementations. The audit log is hash-chained in memory, not a durable independently stored production evidence system. A restart loses process-local state. Super Admin deliberately sees health, counts and redacted coordination metadata rather than unrestricted merchant transactions.

### Remaining business capabilities

Provider connectivity, ledger posting, independent PSP/bank reconciliation, settlement processing, commercial billing, production policy governance, merchant onboarding backends and evidence-backed communications still require implementation. Runtime Go authentication, authorization and telemetry packages also contain placeholders. A local dependency health check is not proof these capabilities exist.

## 4. What every Word document covers

The file-to-ID mapping is in [the spec index](../spec/INDEX.md). The summaries below cover all 52 Word files, including the master register and gap analysis. They describe intended contracts rather than claiming implementation.

### Program, business and governance documents

| Document | Plain-language meaning |
|---|---|
| Master Register | Defines the target document estate, build sequencing, ownership and G0–G7 evidence gates. Not all referenced future documents are present. |
| 01-01 Product Charter | Explains the product, customer value, commercial positioning and boundaries of the first release. |
| 01-02 Governance and RACI | Defines who builds, reviews, approves and is accountable for decisions. |
| 01-03 Glossary | Defines payment objects, states, financial terminology, identifiers and events consistently. |
| 01-04 Source of Truth | Requires evidence of existing systems and distinguishes verified implementation from assumptions. |
| 01-05 Business Requirements | Sets business requirements, use cases, navigation and 14 main operational wireframes. |
| 01-06 Regulatory Matrix | Binds an operating entity, jurisdiction and activity to verified authority and partner coverage. |
| 01-07 Funds Flow and Beneficial Ownership | Tracks who owns funds, obligations and settlement evidence at each stage. |
| 01-08 Partner Responsibilities | Allocates contractual, operational and financial duties between Pay and partners. |
| 01-09 System of Record | Specifies which system owns each fact and how conflicting evidence is resolved. |
| 01-10 ADR Register | Governs architecture decisions, review, evidence, approval and supersession. |
| 01-11 Release Scope and Capability Flags | Defines activation controls; a flag cannot bypass legal, partner or risk restrictions. |
| 01-12 Risks and Open Decisions | Records assumptions, unresolved choices, blockers, ownership and escalation. |

### Product requirements

| Document | Plain-language meaning |
|---|---|
| 02-01 PRD | Defines the minimum launch slice and acceptance expectations. |
| 02-02 Personas and Permissions | Specifies who can see or perform each action, including support and exceptional access. |
| 02-03 Functional Requirements | Gives traceable requirements for behavior and negative cases. |
| 02-04 Nonfunctional Requirements | Defines proposed reliability, performance, recovery and capacity budgets; these are not measured production achievements. |
| 02-05 Money, Currency and Timezones | Requires precise amounts, explicit currency precision, controlled rounding and consistent time handling. |
| 02-06 Eligibility | Requires legal, merchant, provider, method and risk approval before a payment action. Missing evidence denies the action. |
| 02-07 Unknown Outcomes | Defines inquiry-first recovery, safe retries and evidence-based finality after ambiguous execution. |
| 02-08 Pricing and Billing | Defines versioned fees, exact economics, merchant-service invoices and accounting exports. |
| 02-09 Notifications and Receipts | Requires customer messages to reflect verified facts, with controlled templates and privacy. |
| 02-10 Accessibility and Localization | Covers accessible interaction, locale formatting, disclosures and consent. |
| 02-11 Support Entitlements | Defines support commitments, incident responsibilities and evidence needed before promising service levels. |
| 02-12 Traceability Ledger | Links each requirement to its design, code, test evidence, owner and release gate. |

### Architecture

| Document | Plain-language meaning |
|---|---|
| 03-01 Context and Trust Zones | Maps users, merchant systems, providers and ecosystem services across security boundaries. |
| 03-02 Bounded Contexts | Defines nine ownership boundaries grouped into four initial application deployables. |
| 03-03 Topology and Module Contracts | Specifies placement, interfaces, data ownership and cross-module interaction rules. |
| 03-04 Regional Cells | Pins each payment to an authorized cell/entity and governs residency, secrets, backups and cross-border access. |
| 03-05 Tenant Authorization | Requires server-side tenant/resource checks, deny-by-default access and restricted privileged access. |
| 03-06 Workflows and Sagas | Defines durable orchestration, recovery, compensation and transaction boundaries. Compensation cannot erase an external financial fact. |
| 03-07 Technology and Vendors | Establishes evidence-based selection of language, database, workflow engine, hosting and supporting vendors. |
| 03-08 Stores, Caches, Search and Messaging | Separates authoritative storage from projections and defines event/replay/durability rules. |
| 03-09 Zoiko Ecosystem Integration | Defines contracts with iD, CoreX, Assure and Remit without transferring ownership of their authoritative records. |
| 03-10 Capacity and Failure Domains | Defines workload models, admission control, latency measurement, isolation and failure/recovery testing. |

### APIs and integration

| Document | Plain-language meaning |
|---|---|
| 04-01 Public API Standard | Defines paths, versions, errors, pagination and compatibility rules. |
| 04-02 Payment API | Specifies payment-intent and operation endpoints and their request/response contracts. |
| 04-03 Merchant API | Specifies onboarding, evidence, capabilities and reviewed credential issuance. |
| 04-04 Routing and Capability APIs | Defines safe eligibility explanation, evidence-backed provider coverage and controlled routing. |
| 04-05 Payout and Beneficiary APIs | Defines separate beneficiary/payout lifecycles and conditional financial controls. |
| 04-06 Events | Defines the canonical event envelope, registry names, versions, causality and schema compatibility. |
| 04-07 Webhooks | Defines provider-specific authenticity checks, merchant signatures, replay protection and delivery controls. |
| 04-08 Idempotency | Defines request-key scope, fingerprints, concurrent duplicate handling and replay safety. |
| 04-09 Errors and Ambiguity | Defines stable error/decline classification and safe action after uncertain external execution. |
| 04-10 SDK and Sandbox | Defines developer integration libraries, deterministic scenarios, examples and certification requirements. |
| 04-11 API Security | Defines action scopes, token checks, quotas, concurrency limits and abuse response. |

### Payment, provider, finance and security detail

| Document | Plain-language meaning |
|---|---|
| 06-01 Payment Lifecycle | Authoritative payment-intent state transitions, operations, attempts, evidence and concurrency invariants. |
| 07-02 Provider Capability Registry | Records what a specific provider/account may legally and technically perform; unsupported actions must be refused. |
| 09-01 Chart of Accounts | Defines operational account classes, economic events, recognition and balanced journal examples. |
| 09-02 Double-Entry Ledger | Defines immutable journals, balanced posting, economic-effect deduplication and correction controls. |
| 13-01 Security Architecture | Defines trust boundaries, threats, identity/secret protection and security acceptance evidence. |
| Architecture and Competitive Gap Analysis v3.0 | Provides strategic comparison, proposed architecture and prioritized gaps. It is not evidence of live provider integrations or deployed product features. |

## 5. How to interpret the Markdown documents

| File/group | Purpose and caveat |
|---|---|
| `docs/spec/INDEX.md` | Maps numbered specs to Word files. Some titles still say “see file,” even though their contents have descriptive titles. |
| ADR 0001 | Reconciles conflicting amount formats, state names, API paths, IDs and release gates. Still marked PROPOSED. |
| ADR 0002 | Defines import boundaries, PostgreSQL roles/schemas, outbox-based messaging and local stand-ins. Still marked PROPOSED. |
| ADR 0003 | Defines the console BFF exception to Go-only business services and its fixture limitations. Old nested source paths need refreshing. |
| ADR 0004 | Defines privileged/exceptional access. Its header says design only/no code, but section 2.9 and the current BFF implement a console demo; production governance persistence is absent. |
| ADR 0005 | Describes Module 1 money, IDs, database security, event reliability and migration guarantees. |
| ADR 0006 | Describes completed BC-03 scope, dependencies, excluded capabilities and why the HTTP handler is not mounted. |
| `docs/OPEN_QUESTIONS.md` | Records conflicts, conservative interim choices, decision owners and missing specification groups. It is not a list of finished features. |
| Stage 1 baseline report | Historical read-only architecture/database inventory, not a statement that all later functionality is deployed. |
| Module 1 completion report | Historical platform scope and test evidence; includes a PostgreSQL incident that is no longer the current observed health state. |
| Module 2 completion report | Historical implementation/test evidence, owner-approved scope, pending decisions and unapplied-migration record. Approval of that scope is not production approval. |

## 6. Decisions and documentation gaps

The major unresolved decisions are the final amount representation/casing, transaction maximum, idempotency retention/full-response storage, rounding, missing terminal event names, retry budget, recovery escalation/expiry timing, cancellation from `REQUIRES_PAYMENT_METHOD`, and D1→D2 authentication. See Q1 and Q26–Q34. Current code follows the conservative documented interim behavior.

The controlling gate interpretation in ADR 0001 follows the Master Register: G0 authority/funds flow; G1 scope/architecture; G2 provider/security scope; G3 financial correctness; G4 integration/reconciliation; G5 security/resilience/operations; G6 merchant pilot; G7 expansion. Other documents contain conflicting gate labels; do not combine them into a new scheme.

Specific documentation drift:

1. Root README layout still calls OpenAPI contracts and migration directories empty. The private payment API and two payment migrations now exist.
2. Root README describes the ADR directory as “both PROPOSED”; there are six ADRs with more nuanced approval notes.
3. ADR 0004’s header contradicts its implemented console-demo section. The production implementation is still pending.
4. ADR 0003 and historical reports refer to the previous `zoiko-pay-console/backend` location. Historical evidence should retain its date; current guidance should use `backend/` and `frontend/`.
5. Completion-report counts and security scan findings are dated evidence. They must not be presented as fresh scans. The security-maintenance branch remains separate from this reviewed baseline.
6. Several entire target specification groups are absent, as listed in `OPEN_QUESTIONS.md`; the 52 supplied files are not the complete Master Register estate.

## 7. Verification and practical next work

During this session, before this read-only review, the current source layout passed frontend and backend lint, type checking and builds, 77 frontend tests, 96 backend tests, and Go race-enabled unit/regression tests. Module 1 PostgreSQL integration tests also passed earlier in the session. These are scoped checks, not proof of a complete production payment flow; no new full security scan, load test, legal validation or every-requirement audit was run for this report.

Recommended dependency order, subject to the project's explicit module approvals:

1. Resolve the API/security/financial policy decisions and reconcile current documentation.
2. Implement service identity and authorization before exposing payment commands.
3. Implement BC-04 provider connectivity, normalized evidence and inquiry recovery.
4. Wire the existing relay library, inbox consumer, sweepers and durable workflow execution into services.
5. Build the separately authorized ledger, reconciliation and billing capabilities, then connect console APIs to durable business services.
6. Replace development membership/session/audit/decision stores with production integrations and persistence.
7. Collect provider, financial, recovery, security, performance and release evidence for the selected pilot scope.

No business code, deployment, database schema or remote branch was changed for this review. This report is a new local review artifact.
