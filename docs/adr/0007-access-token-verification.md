# ADR 0007: Provider-agnostic access-token verification

- Status: **PROPOSED**, needs CTO and Security approval. 01-02 §10.2 state: DRAFT. Security scope: yes. Financial scope: none.
- Date: 2026-11-25
- Author: to be named
- Accountable architecture owner: Global CTO (01-02 §6 D-02); person to be named
- Mandatory concurrence: CISO / Security Engineering Lead (01-02 §5 and D-02 stop right; 03-05 §19 G2 Security gate, "identity protocol"); person to be named
- Consulted: Principal Solutions Architect and Head of Engineering (01-02 D-02); Platform and Privacy for the identity workstream (03-05 Appendix B, §19 G2); names to be named
- Approved version: none yet. Superseded by: none
- Specs: 03-05 §7.1 (Zoiko iD and approved issuers), 02-02 §2.2 (required identity claims), 03-01 (issuer and audience verification)
- Builds on: ADR 0002 (Keycloak as the local Zoiko iD stand-in), ADR 0003 (console BFF)
- Related: OPEN_QUESTIONS Q34 (service-to-service authentication, not covered here), Q36

## Context

03-05 §7.1: "Zoiko iD is the proposed identity assertion source; issuer,
protocol and production endpoint are unverified. Pay validates issuer,
audience, signature algorithm/key, time bounds, subject …". Keycloak stands in
for Zoiko iD locally, and is the only issuer in use (decided 2026-11-25; an
alternative issuer that had been suggested was dropped). The production issuer
is still unverified, so the code must not depend on Keycloak specifically. Go
services had no token verification (`internal/platform/authn` was empty).

## Options considered

| # | Option | For | Against | Outcome |
|---|---|---|---|---|
| 0 | **Do nothing** (status quo) | No new code or dependency | Go services cannot authenticate anyone: the gateway serves no authenticated route, the payment command API stays unmounted (ADR 0006 §7), and the console BFF remains the only place where sign-in is checked. Blocks principal resolution and route enforcement (plan steps 5–6). | Rejected |
| 1 | **Local JWT verification against the issuer's JWKS, using `go-jose`** | Works with any OIDC issuer through configuration; no call to the issuer per request; full control over algorithms, key handling and required claims; well-reviewed JOSE library | Token revocation is not immediate (expiry-bounded; see Consequences); adds one dependency | **Chosen** |
| 2 | Token introspection (RFC 7662) on every request | Immediate revocation | Couples every request to the issuer's availability and latency; each service needs a client secret; introspection support differs between issuers | Not chosen now. May complement option 1 for high-risk revocation (03-05 §7.2 "versioned grants or central introspection") |
| 3 | `coreos/go-oidc` verifier | Discovery and key caching built in | Designed for ID tokens (client-ID audience); less control over required claims, refresh rate limiting and embedded-key refusal; built on `go-jose` anyway | Not chosen |
| 4 | Hand-written verification on Go's standard library | No dependency | Re-implements JOSE parsing and key handling: higher risk of subtle security defects | Not chosen |

## Decision

`internal/platform/authn` verifies access tokens from **one configured issuer**.
Everything issuer-specific is configuration (`ZP_OIDC_*`); the code names no
product.

| Rule | Behaviour |
|---|---|
| Algorithms | Asymmetric only (default RS256, PS256, ES256). `none` and HS* cannot be configured. |
| Keys | Only from the configured JWKS URL. Tokens carrying a key (`jwk`) are refused; `jku`, `x5u`, `x5c` are never used. A key's declared `alg` must match the token's. Private, symmetric, encryption-only and duplicate-ID keys in the JWKS are ignored. |
| Key cache | Refreshed after 10m, or early for an unknown key ID, at most once a minute. If the JWKS fails, the last good keys serve for up to 1h; then verification fails closed (`ErrKeysUnavailable`). |
| Claims | `iss` exact; `aud` must contain this API's audience; `sub` 1–255 chars; `exp` and `iat` required; `nbf` honoured; 30s leeway; `exp − iat` ≤ 1h; optional required claims (e.g. `typ=Bearer`). |
| Transport | Issuer and JWKS URLs must be https, except loopback or with an explicit `ZP_OIDC_ALLOW_INSECURE_HTTP` for local Docker. |
| Output | `Identity`: issuer, subject, audience, times, session ID, token ID. **No roles, tenant, merchant or custom claims**: authority comes from `merchant.memberships`, keyed by (issuer, subject). |

### Keycloak (local Zoiko iD stand-in)

```
ZP_OIDC_ISSUER=http://localhost:8180/realms/zoikopay
ZP_OIDC_AUDIENCE=zoikopay-gateway
ZP_OIDC_JWKS_URL=http://localhost:8180/realms/zoikopay/protocol/openid-connect/certs
ZP_OIDC_REQUIRED_CLAIMS=typ=Bearer
```

Keycloak access tokens carry **no `aud`** by default, so the realm import now
gives the `zoikopay-console` client an audience mapper that adds
`zoikopay-gateway` to its access tokens (not its ID tokens). `typ=Bearer`
refuses Keycloak ID tokens (`typ=ID`); refresh tokens are HMAC-signed and
refused by algorithm. `TestKeycloakTokens` checks all of this against a real
Keycloak container built from the same image and realm import.

### Another issuer

Change the four values above. For example, an issuer that names its session
claim `session_id` sets `ZP_OIDC_SESSION_ID_CLAIM=session_id`. Choosing an
issuer other than Zoiko iD is an approval decision under 03-05 §7.1, not a
code change.

## Affected areas

| Area | Effect |
|---|---|
| Code | New `internal/platform/authn`. Consumed by `internal/platform/authz` (principal resolution), which takes only its `Identity`. |
| Deployables | No runtime change yet: the verifier is not mounted on any route. The first user will be D1 `gateway` (plan step 6). |
| Identity provider configuration | `deploy/compose/keycloak/zoikopay-realm.json`: audience mapper on the `zoikopay-console` client. Local stack only. |
| Admin console (BFF) | No code change. Its sign-in reads ID-token claims, which the mapper does not touch; its access tokens now also carry `aud: zoikopay-gateway`. Later (plan step 8, OPEN_QUESTIONS Q39): the BFF keeps the access token server-side and sends it to the gateway's `GET /v1/principal` to read the user's own grants. |
| Regional cells | No cell-specific behaviour; one issuer per deployment. Cell scoping of authority is out of scope (OPEN_QUESTIONS 36.17). |
| Data and money | No database change; no money, ledger or journal behaviour, so no CFO or Controller concurrence is required (01-02 D-02). |
| Dependencies | `github.com/go-jose/go-jose/v4` v4.1.9; `govulncheck` found no vulnerabilities on 2026-11-25. |

## Migration and rollback

- **Data:** none. No schema or data migration.
- **Rollout:** the verifier is a library. Enabling it means wiring it into a
  deployable (plan step 6) and setting `ZP_OIDC_*`; a missing or unsafe value
  stops start-up (`ErrConfig`), so a bad configuration cannot run.
- **Keycloak:** Keycloak imports the realm only when the realm does not
  exist yet. A fresh container (`docker compose up -d --force-recreate keycloak`)
  picks up the audience mapper; an existing Keycloak that keeps its data needs
  the mapper added to the `zoikopay-console` client by an administrator.
- **Key rotation at the issuer:** automatic. An unknown key ID triggers a JWKS
  refresh (at most once a minute); no redeploy.
- **Rollback:** revert the commits. Nothing calls the verifier on a route yet,
  so there is no runtime effect. Removing the audience mapper is safe for the
  console (it does not read `aud`); recreate Keycloak to apply it.
- **Changing issuer:** configuration only, after approval (see "Another issuer").

## Linked tests

| Test | File | Covers |
|---|---|---|
| `TestVerifyAcceptsValidAccessTokens` | `internal/platform/authn/verifier_test.go` | RS256 and ES256 accepted; audience lists; leeway |
| `TestVerifyRefusesWrongClaims` | same | Issuer, audience, subject, expiry, issued-at, not-before, lifetime, token type (ID and refresh tokens) |
| `TestVerifyRefusesForgedAndUnsafeTokens` | same | `alg: none`, HS256 key confusion, wrong key, tampered payload, missing or unknown key ID, embedded key, algorithm mismatch |
| `TestIdentityCarriesNoAuthorityClaims` | same | Forged tenant, role and metadata claims grant nothing; `Identity` has no authority fields |
| `TestKeyCacheRotationAndRefreshLimit` | same | Caching, rotation, refresh rate limit |
| `TestKeysUnavailableFailsClosed` | same | Issuer outage; stale-key limit |
| `TestJWKSKeepsOnlyPublicSigningKeys`, `TestFetchKeepsOnlyPublicSigningKeys` | `verifier_test.go`, `jwks_test.go` | JWKS filtering |
| `TestNewVerifierRefusesUnsafeConfig`, `TestConfigFromEnvKeycloak`, `TestConfigFromEnvRefusesBadValues` | `verifier_test.go`, `config_test.go` | Configuration safety and environment variables |
| `TestBearerToken` | `verifier_test.go` | Authorization header parsing |
| `TestKeycloakTokens` (integration) | `internal/platform/authn/keycloak_integration_test.go` | Real Keycloak tokens: access token accepted; ID, refresh, other-client, tampered and other-realm tokens refused |
| `TestTokenToPrincipal` (integration) | `internal/merchant/store/grants_integration_test.go` | End to end: verified token to principal; forged claims and headers ignored |

## Consequences

- One new dependency: `github.com/go-jose/go-jose/v4` (JOSE parsing and signature verification).
- Token expiry is not revocation: 02-02 §2.4 requires revocation to reach
  enforcement points "within an approved and measured bounded interval".
  Short tokens (Keycloak: 5m) plus the membership check on every request
  bound it for now; the session check is a later step.
- The verifier is not yet mounted on any route (plan step 6).
- The specification this implements, 03-05, is itself a controlled draft with
  all sign-offs pending.

## Approval record

| Authority | Basis | Decision | Name | Date |
|---|---|---|---|---|
| Global CTO (accountable) | 01-02 §6 D-02, §10.2 | PENDING | to be named | |
| CISO / Security Engineering Lead (mandatory concurrence) | 01-02 §5, D-02; 03-05 §19 G2 | PENDING | to be named | |
