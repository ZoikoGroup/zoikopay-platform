# ADR 0004: Exceptional access (support JIT and break-glass)

- Status: **PROPOSED**, design only, no code yet; needs Security and CTO approval
- Date: 2026-11-13
- Specs: 03-05 §10.1 and §10.2 (privileged access), 02-02 §0.3, §2.4, §3
  (SUPPORT.* permissions), WF-007 (support case and temporary access),
  WF-011 (privileged incident and break-glass), JRN-14, data store `support_access`
- Related: ADR 0003 (console BFF), [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md) Q15, Q19 to Q23

## 1. Context

By default nobody can see merchant transactions or customer data outside
their scope. Super Admin sees only health and counts (03-05 §10.1); Support
has no default cross-tenant search (02-02). Sometimes a person must look at
real records to resolve a support ticket or an incident. 03-05 §10.2 defines
how: a case, a second approver, purpose-scoped temporary access that is
masked and read-only by default, full recording, automatic revocation and an
independent review.

Two screens in 02-02 use this process:

| Screen | Who requests | Who approves | Bound to | Grants |
|---|---|---|---|---|
| WF-007 Support JIT | Support (PSUP) | Security (PSEC), independent | Support ticket + merchant consent | Masked read-only view of named merchant records |
| WF-011 Break-glass | SRE (PSRE) or Security (PSEC) | Security (PSEC), a different person | Incident ticket | Read-only diagnostic tools on named systems |

**Super Admin is not a requester.** The 02-02 permission register names only
PSUP for `SUPPORT.ACCESS.JIT.REQUEST` and PSEC for `SUPPORT.ACCESS.JIT.APPROVE`,
and WF-011 names PSRE and PSEC. Super Admin sees counts only (Q19).

## 2. Decision

One **exceptional-access engine** with two kinds of grant, `support` and
`breakglass`, sharing one lifecycle, one enforcement point and one evidence
trail. It is owned by **BC-08 Risk, Compliance & Governance** (deployable D,
`governance`); the console BFF only presents it.

### 2.1 Lifecycle

```
REQUESTED ──approve──▶ ACTIVE ──(expires_at)──▶ EXPIRED ─┐
    │                    │                                 ├──review──▶ REVIEWED
    ├──reject──▶ REJECTED ├──revoke──▶ REVOKED ────────────┤
    └──(30 min)─▶ LAPSED  └──close (case/incident)─▶ CLOSED ┘
```

| Transition | Who | Rules |
|---|---|---|
| request | PSUP (support), PSRE/PSEC (break-glass) | Ticket id required; exact resources and fields; purpose; duration ≤ max TTL; requester must currently hold the role and cell |
| approve | PSEC | Not the requester; different role from requester for break-glass (§10.2 "distinct person and role"); password re-entry (02-02 §2.4); reviews the exact version |
| reject | PSEC | Reason required |
| lapse | system | Unapproved requests expire after 30 min (Q21) |
| revoke | PSEC, case owner, the grantee themselves | Immediate; effective on the next request |
| expire | system | At `expires_at`; no extension, only a new request |
| close | system | Ticket/incident closed, or grantee's role changes or is revoked (§10.2) |
| review | PSEC, **not** the approver and not the grantee | Reads the access log; outcome `in_policy` or `escalate` with notes |

### 2.2 What a grant can and cannot do

- **Read-only, always** in the pilot. No action, approval, export, money
  movement, ledger edit, status change or policy change is possible under an
  exceptional grant (02-02 §0.3: "money-movement capability under emergency
  access requires a distinct controlled process not included in the first pilot").
- **Masked by default.** Customer email, card details, names and bank
  identifiers are masked; unmasked fields must be named in the request and
  approved field by field.
- **Exactly the named resources.** Scope is a list of tenant + merchant +
  resource type + optional record ids, inside one legal cell and one
  environment. Never "all merchants", never a cross-cell scope.
- **No export** unless a separate `SUPPORT.EVIDENCE.EXPORT` approval exists
  (masked, signed, logged).
- **No impersonation.** The grantee acts as themselves; their normal role is
  unchanged.
- **Cannot override** holds, legal restrictions or tenant boundaries outside
  the grant.

### 2.3 Enforcement point

The grant never changes the person's role. Authorization evaluates it as an
**overlay**, per request:

```
allow(read, resource) =
     normal_role_allows(read, resource)
  OR exists grant g:
        g.status = ACTIVE ∧ now < g.expires_at
      ∧ g.grantee = subject ∧ subject still holds g.requester_role
      ∧ resource ∈ g.scope (tenant, merchant, cell, environment, type, ids)
      ∧ action = read
```

When access comes from a grant, the response passes through a **masking
filter** (field allowlist from the grant) and every read writes an
**access-log entry** (`grant id`, ticket, resource, fields returned,
request id, time). Denials are logged without result bodies (§10.1).

### 2.4 Data (governance schema, BC-08)

| Table | Key fields |
|---|---|
| `exceptional_access` | `access_id` (`xa_`), `kind`, `ticket_id`, `purpose`, `scope` (JSON: cell, env, tenant, merchants, resource types, ids), `unmasked_fields[]`, `requested_by`, `requested_role`, `approved_by`, `requested_at`, `approved_at`, `expires_at`, `revoked_at`, `closed_reason`, `status`, `version` |
| `exceptional_access_log` | `access_id`, `at`, `subject`, `resource_type`, `resource_id`, `fields[]`, `request_id`; append-only |
| `exceptional_access_review` | `access_id`, `reviewer`, `outcome`, `notes`, `at`; one per grant |

Matches the 02-02 `support_access` store (`access_id, ticket_id, scope,
purpose, issuer, approver, expires_at, revoked_at`). Rows are never updated
in place except `status`, `revoked_at` and `version`; history comes from the
audit log. Runtime role `zp_governance` cannot delete rows.

### 2.5 Timers

Expiry, lapse and review-due are **Temporal timers** in the governance
worker, plus a check on every request (a grant past `expires_at` is denied
even if the timer has not fired). Revocation triggers: role change or revoke
events from role administration (WF-002), ticket closure, incident closure.

### 2.6 API (contract placeholders from 02-02, subject to the API documents)

| Method and path | Purpose |
|---|---|
| `POST /internal/jit-access` | Request support access |
| `POST /internal/breakglass` | Request break-glass access |
| `POST /internal/{jit-access,breakglass}/{id}/decision` | Approve or reject (`version`, step-up) |
| `POST /internal/{jit-access,breakglass}/{id}/revoke` | Revoke now |
| `POST /internal/breakglass/{id}/close` | Close after the incident |
| `POST /internal/{…}/{id}/review` | Independent review |
| `GET /internal/exceptional-access?status=` | Queue and history (scoped) |
| `GET /internal/exceptional-access/{id}/log` | Access log (PSEC and reviewers) |

### 2.7 Screens (console)

| Screen | Users | Shows |
|---|---|---|
| WF-007 Support access | PSUP, PSEC | Ticket, merchant consent, requested scope, TTL countdown, access log; request, approve, revoke |
| WF-011 Break-glass | PSRE, PSEC | Incident, affected systems, time box, read-only tools, approval; request, terminate, review |
| Review queue | PSEC | Expired/closed grants waiting for review, overdue first |
| Platform admin (Super Admin) | SUPER_ADMIN | **Counts only**: active grants, waiting approval, reviews overdue |
| Notifications | approvers, reviewers | "Approve access", "Review due" |

Phone width: request and read allowed; approve and revoke blocked (as other
two-person actions).

### 2.8 Where it runs

- **Target:** BC-08 module in `internal/governance` (Go, deployable D),
  tables in the governance schema, Temporal for timers, events
  `ExceptionalAccessGranted/Revoked/Expired` through the outbox so other
  deployables can enforce the overlay. Built in **M4** with the rest of
  authorization.
- **Interim (console only, optional):** the same rules inside the console
  BFF, in memory, like role administration today, behind an interface that
  the Go service later replaces. Only worth doing for a demo; the real
  enforcement belongs where the data is read.

### 2.9 Console demo (built 2026-11-13)

The console BFF implements this ADR in memory (`backend/src/services/exceptional.ts`,
screen "Exceptional access") with the proposed answers to Q19 to Q23. One
simplification: instead of an overlay on the normal payment routes (§2.3),
an active grant opens a separate read-only window,
`GET /api/v1/exceptional-access/{id}/payments[/{paymentId}]`. Normal routes
are unchanged, so a grant can never widen anything else. Payments are the
only resource type in the demo. Requests lapse, grants expire and close on
role change by a check on every request (no Temporal timer in the BFF).
Acceptance tests 1 to 10 are in `backend/test/exceptional.test.ts`.

## 3. Acceptance tests (to write first)

1. Requester cannot approve own request; approver of a break-glass grant has a different role.
2. No ticket, cross-tenant scope, cross-cell scope, "all merchants", or TTL over the maximum → refused.
3. Approval without fresh password → refused.
4. Granted person reads a named record → allowed, masked, logged; any other record → refused.
5. Any write, approval, export or money action under the grant → refused.
6. One request after `expires_at` → refused, even before the timer fires.
7. Revoke, role change or ticket closure → next request refused.
8. Reviewer cannot be the approver or the grantee; unreviewed grants surface as overdue.
9. Super Admin sees counts, never the grant's resources or log.
10. Audit chain contains every transition and every read.

## 4. Consequences

- Support and SRE can help in real incidents without standing access to data.
- Every exceptional read is attributable and reviewable.
- Needs a masking layer on every read path, which is also required by 03-05
  for exports; build it once in the platform `authz` package.
- Depends on decisions Q19 to Q23 below.
