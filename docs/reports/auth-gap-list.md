# Authentication and authorization: gap list

- Date: 2026-11-26
- Scope: what plan steps 2 to 8 built (tenants, memberships, token verifier,
  principal resolver, gateway middleware, audit log, console roles from Go),
  compared with the Build Plan and specs 03-05 and 02-02.
- Status: engineering assessment for lead review. Nothing listed as missing
  has been built.

**Note on "Stage 1":** neither the Build Plan nor 03-05 defines an
authentication "Stage 1". This list measures against:

- the Build Plan's gates G1 (tenant boundary), G2 (security scope) and G5
  (tenant isolation);
- 03-05's eight work packages (§18) and its attack tests (§17);
- 02-02's identity rules (§2) and acceptance tests (§7).

The local evidence is `make e2e-auth` (see
[docs/runbooks/local-auth-e2e.md](../runbooks/local-auth-e2e.md)): 103 of 103
checks passed from a clean stack on 2026-11-26.

## Done (steps 2–8)

- Tenants, merchants and memberships, with forced tenant isolation in the
  database and least-privilege roles (G1, WP-03).
- Token verification that works with any identity issuer (ADR 0007), plus
  roles resolved only from memberships, deny by default.
- 401, 404 and 403 behave as specced, and the TEST/LIVE environment comes from
  configuration.
- Revocation takes effect on the next request (AT-005, AT-015).
- Append-only audit of every gateway request (part of WP-07).
- The console reads roles from Go, with no staff wildcard.
- Covered by tests: AT-001, 002, 003 (expired), 004 (fail closed), 005, 006,
  007 and 012 (self-grant blocked in the database); attack tests A01, A02,
  A04, A05, A30 and A32.

## Decisions

Numbered 1 because the missing items below depend on it.

1. **Decisions only, no code.**
   - Lead review of the Q36–Q39 defaults.
   - CTO and Security approval of ADR 0007.
   - API Council approval of the `/v1/principal` path.
   - Security to set the revocation time target and the maximum grant length
     (36.7).

   Everything below builds on these.

## Missing

What each depends on, in the suggested order.

2. **Step-up enforced in Go, tied to the operation** (03-05 §7.2, AT-010).
   Depends on Security's assurance and MFA decision and on what Zoiko iD
   supports. The gateway already reads `auth_time` but doesn't enforce it.
   Grant approvals and money operations need this.
3. **Grant administration in BC-01** (invite, request, approve, revoke, with
   maker-checker and the "never above the delegator" rule enforced in both the
   database and the app, plus grant-change audit). Depends on 1 and 2. It
   unblocks the Access screen and AT-013 to AT-021.
   **Update 2026-11-26: built without step-up**, with approvals and revocations
   refused outside TEST until item 2 exists (OPEN_QUESTIONS Q40, including what
   was left out). The console Access screen is not wired to it yet.
4. **Session revocation:** logging out of Keycloak should cut off the gateway
   before the token expires (02-02 §2.2, A06). Depends on Security choosing
   introspection or session versions (ADR 0007 option 2). The session ID is
   captured but not checked.
5. **Human vs service identities, and service-to-service authentication**
   (AT-009, 03-05 §7.3, Q34). Depends on Security's mTLS/workload-identity
   decision. It unblocks mounting the payment API (ADR 0006).
6. **Staff access model** (36.3). Depends on a product and security decision
   on how staff grants are stored and scoped. It makes Super Admin and the
   staff screens reachable again.
7. **Exceptional access in BC-08** (WP-06, ADR 0004). Depends on 6 and 8.
8. **Audit, second half** (WP-07):
   - a security-review read path for audit staff;
   - tamper-evident chaining (38.5);
   - moving the console's in-memory audit chain to governance;
   - a retention policy.

   Depends on 6, the evidence store choice (Q9), and a Legal/Privacy retention
   decision.
9. **Policy decision point formalised** (WP-01/02: decision IDs, policy
   versions, reason codes, obligations; 03-05 §3). Depends on G1 architecture
   approval. It can grow route by route, and the permission catalogue (AUTH-02
   to AUTH-20) arrives with each route.
10. **Cells and legal entities** (WP-04, 36.17, AT-019 and AT-025) and
    **tenant provisioning / first owner** (36.14). Both are blocked on spec
    05-03, which is missing.
11. **Gateway rate limiting and lockout, plus an alert when the identity
    provider is down** (03-05 §6.1, AT-004's "alert"). Depends on SRE's
    observability decision. Today only the console rate-limits sign-ins; the
    gateway has an error code for it but no limiter.
12. **Accessibility of sign-in** (AT-011). Not verified yet. Needs a WCAG 2.2
    AA review of the sign-in page.
13. **Independent penetration test and the chaos, failover and TOCTOU suites**
    (G4, G5, WP-08). Last, after the above.
