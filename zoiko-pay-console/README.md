# Zoiko Pay Console

A black-and-white sign-in page and payment-operations dashboard for Zoiko Pay,
built as two independent Node.js servers:

| Part | Stack | Port | Role |
|---|---|---|---|
| `frontend/` | React 19, TypeScript, Vite | **5173** | The web app: sign-in page and dashboard. Proxies `/api` and `/auth` to the backend, so the browser sees one origin. |
| `backend/` | Node.js, Express 5, TypeScript | **4000** | Backend-for-frontend (ADR 0003): checks passwords with Keycloak, enforces permissions, serves dashboard data. No payment or ledger logic. |

**Status: development build.** Dashboard numbers and payments are labelled
mock data for the TEST environment, because the Go services have no business
APIs yet. System health is live.

Screenshots: [docs/preview/](docs/preview/). Design notes: [docs/DESIGN.md](docs/DESIGN.md).

## What it does

1. **Sign-in page.** Zoiko Pay's own form (username, password). The backend
   checks the password with Keycloak; you never see the Keycloak page.
2. **Dashboard** (after sign-in):
   - welcome panel with a dotted world map;
   - six key indicators: payment volume, successful transactions, success
     rate, fraud rate, pending approvals, settlement status (24H / 7D / 30D);
   - payment activity chart with succeeded/failed breakdown;
   - system health (live);
   - recent transactions with search, status filter, sorting and paging; click
     a row for the payment's details and evidence timeline;
   - recent activity;
   - header: TEST/LIVE switch, merchant, jurisdiction and currency selectors,
     help, and your name with **Sign out**.

3. **Sidebar and screens:** the 12 side-rail items of Business Requirements
   §07, in that order. Each user sees only the items the specs give their role
   (decided by the backend). Every item opens working screens built from its
   §07 wireframe (mock data, TEST only):

   | Item | Screens | Actions (server-enforced) |
   |---|---|---|
   | Merchants | 002 KYB review, 003 capabilities | approve / request info / reject (reason); activate (password re-entry), block |
   | Payment Operations | 005 explorer + evidence, 004 sandbox intent | sandbox create-intent with Idempotency-Key (simulated, 04-08 replay/conflict) |
   | Routing | 006 policies | simulate, submit, approve promotion (maker-checker, re-entry), reject |
   | Partners | 007 connectors | certify (maker-checker, re-entry) |
   | Refunds & Disputes | 008 voids, refunds, disputes | approve (≤ refundable, re-entry), reject |
   | Finance | 009 four-way reconciliation, 011 unknown outcomes | close period (independent Finance, residual 0); inquire, resolve with evidence |
   | Payouts | 010 approval queue | approve (maker ≠ checker, re-entry, gates, deadline), reject |
   | Risk & Compliance | 012 regulatory cells | approve change, suspend |
   | Developers | 013 keys, webhooks, reports; 004 sandbox | read-only |
   | Audits | hash-chained audit log | read-only |
   | QA & Release | 014 gate control room, 001 traceability | sign GO (all G0–G7 passed), sign NO-GO |
   | Access (outside §07) | 02-02 WF-002 role administration | request, approve, revoke role grants (maker-checker) |
   | Exceptional access (outside §07) | 02-02 WF-007, WF-011 (ADR 0004) | request, approve, revoke, review time-limited masked access |
   | Super Admin (outside §07) | 03-05 §10.1 coordination page | read-only: health, counts, redacted organisations |

   Every screen has search, a status filter, CSV export of exactly the rows you
   may see, a detail panel with history, and loading/empty/no-permission/stale
   states. The header has global search and notifications (decisions awaiting
   you), as §07 requires.

What each person sees depends on their role (see the user table).

## Prerequisites

- Node.js 22 or later (tested with 26), npm 10+
- The repository's local stack running (`make up` in the repo root), for
  Keycloak
- For live system health: the Go services running (`make run-<service>` or
  `make smoke` in the repo root)

## Install

```sh
cd zoiko-pay-console/backend  && npm ci
cd ../frontend                && npm ci
cp ../backend/.env.example ../backend/.env
```

## Run (development)

Two terminals:

```sh
cd zoiko-pay-console/backend  && npm run dev   # http://localhost:4000
cd zoiko-pay-console/frontend && npm run dev   # http://localhost:5173
```

Open **http://localhost:5173** and sign in.

## Build and production start

```sh
cd backend  && npm run build && npm start      # node dist/server.js on 4000
cd frontend && npm run build && npm start      # vite preview of dist/ on 5173, with proxy and security headers
```

## Users (local development)

Every user's password is **`Zoiko@123`**. On the sign-in page you can also **create an account** (it has no role until an administrator assigns one) or **change a password**. Passwords need 8+ characters with upper case, lower case, a digit and a symbol, and must not contain the username.

| Username | Role | Overview dashboard shows (02-02 §03 read permissions) |
|---|---|---|
| `ops.agent` | Payment operations (POR) | UK cell: amounts, counts, transactions with card details and risk screening, health. No payout queue or settlement |
| `super.admin` | Super Admin | Lands on the Super Admin page: health, counts and redacted organisations only. No Overview, no money amounts or transactions |
| `fin.controller.a`, `fin.controller.b` | Finance controller (PFIN) | Both cells: amounts, counts, payout queue, settlement. No transaction records |
| `risk.analyst` | Risk analyst | Counts, success and fraud rates. No transaction records or money amounts |
| `merchant.owner` | Merchant owner | Northwind tenant: amounts, counts, transactions |
| `merchant.ops` | Merchant operations | Northwind UK: amounts, counts, transactions with card details (no risk screening) |
| `merchant.viewer` | Merchant viewer | Alder tenant: amounts, counts, transactions, settlement; no card details |
| `sre.oncall`, `security.officer` | SRE, security | Health only |
| `compliance.officer` | Compliance (PCOMP) | Dashboard frame only; work is in Merchants, Routing, Partners, Payouts, Risk & Compliance, Audits, QA & Release |
| `merchant.finance` | Merchant finance (MFIN) | Northwind: amounts, counts, transactions, payout queue, settlement |
| `merchant.dev` | Merchant developer (MDEV) | Dashboard frame only (no PAYMENT.READ); sandbox under Payment Operations |
| `recon.analyst` | Reconciliation (PRECON) | Amounts, counts, payout queue, settlement. No transaction records |
| `partner.ops` | Partner operations (PPSP) | Health; work is in Partners |
| `support.agent`, `iam.admin` | Support, IAM | Dashboard frame only; no data for these roles yet |

`admin` / `local-dev-only-admin` (unchanged) is the **Keycloak administrator** at
http://localhost:8180/admin. It cannot sign in to the console.

## Configure (backend `.env`)

| Variable | Default (local) | Purpose |
|---|---|---|
| `PORT` | `4000` | Backend port |
| `CONSOLE_PUBLIC_ORIGIN` | `http://localhost:5173` | The only origin allowed to post (CSRF check) |
| `OIDC_ISSUER` | `http://localhost:8180/realms/zoikopay` | Keycloak realm |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | `zoikopay-console` / `local-dev-only-console-secret` | Confidential client in the realm import |
| `SESSION_SECRET` | local-dev value | Signs the session cookie; start-up refuses the dev value when `NODE_ENV=production` |
| `GO_SERVICES` | the six local Go services | Probed for system health |

## Test

```sh
# backend
npm run lint && npm run typecheck && npm test   # 52 tests
npm run test:e2e                                 # 27 checks against real Keycloak + running servers

# frontend
npm run lint && npm run typecheck && npm test   # 67 tests, incl. the black-and-white palette scan
```

## Security model

- **Sign-in:** the form posts to `POST /auth/login` on the backend, which
  checks the password with Keycloak (server to server, confidential client).
  Tokens never reach the browser. A wrong password and an unknown user get the
  same message. Attempts are limited to 10 per minute per client and are
  audited without the password. The session id is regenerated at sign-in.
- **Session:** HttpOnly, SameSite=Lax cookie (`Secure` in production); 30-minute
  idle timeout, 8-hour absolute limit. Sign-out ends the console session and
  revokes the Keycloak session.
- **Authorization (server-side, deny by default):** role → permissions
  (`backend/src/authorization/permissions.ts`, from specs 02-02 and 03-05),
  then a check on every record for tenant, legal entity, merchant and the
  selected environment. Out-of-scope payments answer 404. Nothing the browser
  sends is trusted for role, tenant or environment.
- **Transport:** strict security headers, an Origin check on every POST/PUT,
  input validation, RFC 9457 error bodies with a request id.

**Trade-off:** checking passwords through the app (the OAuth "password"
grant) means the console briefly handles the password. OAuth 2.1 discourages
this; redirecting to the Zoiko iD page is the safer pattern. It was chosen so
the console has its own sign-in page (ADR 0003).

## Gaps and production readiness

Not production-ready:

1. All data is mock data (TEST only); it needs the Go business APIs.
   Decisions change only mock records and the audit log; nothing moves money.
2. Spec actions not built yet: create merchant application and upload
   evidence (002), propose capability (003), draft a new routing policy (006),
   rotate connector secret (007), import and match statements (009), evaluate
   permission (012), create or rotate API keys and webhooks (013), run release
   evidence and freeze scope (014), submit requirement decision (001), and
   "investigate" from the payment explorer (005; use 011 instead).
3. Sessions, decisions and the audit trail are kept in memory and lost on restart.
4. The membership directory (who has which role) is a development list.
5. No multi-factor authentication on the sign-in form yet.
6. Phone-width blocking of sensitive approvals is enforced in the UI only.
7. Manual accessibility audit not done.
