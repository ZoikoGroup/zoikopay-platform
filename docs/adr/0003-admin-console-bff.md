# ADR 0003: Admin console as a Node.js backend-for-frontend

- Status: **PROPOSED**, needs CTO approval
- Date: 2026-11-10
- Amends: [ADR 0001 §5](0001-contract-freeze.md) (Go for every backend module)
- Related: [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md) Q12 to Q17

## Context

The console brief requires a React frontend and a separate Node.js/Express
backend. ADR 0001 §5 proposes Go for every backend module. The Go services are
still a skeleton: no business tables or APIs exist.

## Decision

`zoiko-pay-console/backend` is a **backend-for-frontend (BFF)** for the
console only. It is not a bounded context and owns no business data.

It may:
- verify sign-in against Zoiko iD (Keycloak locally) and hold tokens
  server-side (the browser only ever has an HttpOnly session cookie). The
  console has its own sign-in form, so the BFF uses the OAuth password grant
  with a confidential client. OAuth 2.1 discourages that grant because the app
  sees the password; the redirect (authorization code + PKCE) flow is the
  safer option if a separate sign-in page is acceptable;
- decide and enforce console authorization: persona → permissions, plus
  tenant, legal-entity, merchant and environment scope on every record;
- record audit evidence for console actions;
- call Go service APIs and shape their responses for the UI.

It must not:
- implement payment, ledger, settlement or funds-movement logic;
- create or store payments, payouts or journal entries of its own;
- dispatch any instruction to a PSP or bank.

### Temporary exceptions (development only)

The Go APIs do not exist yet, so the BFF currently:
- serves deterministic development fixtures for **TEST only**, always labelled
  `source: "fixture"`, and refuses LIVE with `503 LIVE_DATA_UNAVAILABLE`;
- keeps the console audit chain in memory. It moves to the governance
  evidence store.

Memberships are no longer in memory (2026-11-26, OPEN_QUESTIONS Q39): roles
and scope come only from BC-01's `merchant.memberships`, read on every request
through the gateway's `GET /v1/principal` with the user's own access token.
Platform staff hold no grant there yet, so they have no access, and role
administration on the Access screen is refused until Go provides it.

The console has a sign-in page, the Overview dashboard, the 12 Business
Requirements §07 side-rail areas, and three areas outside §07 (Access,
Exceptional access, Super Admin; OPEN_QUESTIONS Q18). Decisions on those
screens (approve, reject, grant, revoke, sandbox create-intent) change only
in-memory TEST fixtures and the console audit chain. None of them moves
money, writes a ledger entry or reaches a PSP; the "must not" list above
still holds. (An earlier draft of this ADR said "read-only: a sign-in page
and a dashboard"; that no longer describes the code.)

### Super Admin (amended 2026-11-13)

03-05 §10.1: "Default dashboard shows service health, counts and redacted
tenant metadata". So Super Admin holds only `area.platform` and `health.view`:

- no Overview. `/overview/*`, `/scope` and `/search` return 403; signing in
  lands on the Super Admin page. Overview's per-merchant filter would
  otherwise show one merchant's fraud rate, settlement and payout queue,
  which is merchant operating data, not coordination data;
- the Super Admin page counts the selected environment only. LIVE returns
  `503 LIVE_DATA_UNAVAILABLE` for counts; live health still shows.

Recorded as OPEN_QUESTIONS Q24.

Each of these is behind an interface (`ConsoleDataSource`,
`MembershipDirectory`, `AuditLog`), so services do not change when the source
changes.

## Consequences

- The backend estate is Go plus one Node.js BFF. The BFF is the only Node.js
  service; new business capabilities still go into Go.
- Authorization rules exist in two places (BFF now; Go services later). Once
  Go enforces them, the BFF keeps its checks as defense in depth.
- `zoiko-pay-console/go.mod` exists only to stop Go tooling from scanning
  `node_modules`.
