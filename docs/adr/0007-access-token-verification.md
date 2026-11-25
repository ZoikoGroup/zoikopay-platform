# ADR 0007: Provider-agnostic access-token verification

- Status: **PROPOSED**, needs Security approval
- Date: 2026-11-25
- Specs: 03-05 §7.1 (Zoiko iD and approved issuers), 02-02 §2.2 (required identity claims), 03-01 (issuer and audience verification)
- Builds on: ADR 0002 (Keycloak as the local Zoiko iD stand-in), ADR 0003 (console BFF)
- Related: OPEN_QUESTIONS Q34 (service-to-service authentication, not covered here), Q36

## Context

03-05 §7.1: "Zoiko iD is the proposed identity assertion source; issuer,
protocol and production endpoint are unverified. Pay validates issuer,
audience, signature algorithm/key, time bounds, subject …". The issuer may
change: Keycloak stands in for Zoiko iD locally, and another OIDC issuer
(for example Supabase Auth) has been suggested. Go services had no token
verification (`internal/platform/authn` was empty).

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

## Consequences

- One new dependency: `github.com/go-jose/go-jose/v4` (JOSE parsing and signature verification).
- Token expiry is not revocation: 02-02 §2.4 requires revocation to reach
  enforcement points "within an approved and measured bounded interval".
  Short tokens (Keycloak: 5m) plus the membership check on every request
  bound it for now; the session check is a later step.
- The verifier is not yet mounted on any route (plan step 6).
