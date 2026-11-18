# Console single sign-on

The login page offers Microsoft, Google, Apple and Company SSO alongside the existing username/password form. Button availability comes from `GET /auth/providers`, not from frontend flags.

## Current local status

- Company SSO is connected to the existing Zoiko iD stand-in (the local Keycloak `zoikopay` realm). Its complete browser authorization-code flow has been tested.
- Microsoft, Google and Apple applications have not been registered or connected. Their frontend controls and broker integration are implemented, but they are unavailable until the corresponding Keycloak connections exist.
- No provider credentials are embedded in the frontend or committed to this repository.
- A provider identity does not grant a Pay role. Membership is resolved from the verified Keycloak subject; an unregistered subject gets no operating permissions.

## Company SSO locally

From the repository root:

```sh
npm --prefix backend run setup:sso
```

The helper authenticates to the local Keycloak administration API using development settings. It updates only the console client: enables the standard authorization-code flow, disables implicit flow, requires PKCE S256, and adds the exact frontend callback. It refuses remote Keycloak hosts. It does not reset realm users or data.

For fresh local realm imports, the same settings are already in `deploy/compose/keycloak/zoikopay-realm.json`. An existing Keycloak volume is not updated by editing the import file; use the helper.

The current callback is `http://localhost:5173/auth/sso/callback`. A different frontend origin needs its own exact registered callback and matching `CONSOLE_PUBLIC_ORIGIN`. Production uses HTTPS and explicitly sets `OIDC_SSO_ENABLED=true`; SSO defaults to disabled in production.

Company SSO uses the realm directly when `OIDC_SSO_COMPANY_ALIAS` is absent. To connect a separate company identity system, configure its OIDC/SAML broker in Keycloak and set that approved broker alias. This change does not itself configure a Microsoft Entra tenant, Google Workspace organization, or external company directory.

## Connect Microsoft and Google

1. In the Keycloak Admin Console, select realm `zoikopay`, then Identity Providers. Add the appropriate supported provider, using a stable alias such as `microsoft` or `google`.
2. Copy the broker callback URI displayed by Keycloak. This is the callback registered with the external provider; it is different from the console's `/auth/sso/callback` URI.
3. Register a web application in the organization's Microsoft or Google developer console. Configure its allowed account/tenant audience, consent and exact callback URI. Store its client ID/secret in the protected Keycloak configuration.
4. Complete and verify the Keycloak provider connection. Preserve verified account-linking checks; do not automatically link an existing privileged user solely because an email string matches.
5. Set only the approved, connected alias in the backend's ignored `.env` file:

```dotenv
OIDC_SSO_ENABLED=true
OIDC_SSO_MICROSOFT_ALIAS=microsoft
OIDC_SSO_GOOGLE_ALIAS=google
```

Restart the backend after changing environment variables. The matching button becomes available. Provider secrets belong in Keycloak/secret management, not these alias variables, source control, chat or browser code.

Keycloak documents the [Google setup](https://www.keycloak.org/docs/latest/server_admin/#_google) and [Microsoft setup](https://www.keycloak.org/docs/latest/server_admin/#_microsoft), including the external application registrations.

## Connect Apple

Apple requires its own developer registration, Services ID, signing key/client-secret lifecycle and an approved web callback. Apple does not allow `localhost` as its return URL; an appropriate HTTPS domain is required. See [Apple's configuration instructions](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/) and [its web authorization requirements](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.).

The bundled Keycloak realm has no Apple broker adapter or external Apple credentials configured. A supported and reviewed Apple-capable broker integration must first be installed/configured and tested, including Apple's callback mode and signing-secret rotation. The generic console broker path is not evidence that this adapter exists.

Once that connection works, set `OIDC_SSO_APPLE_ALIAS` to its approved alias. Until then, leave Apple disabled. Setting an alias alone does not implement an Apple provider.

## Flow and protections

1. The browser submits a same-origin POST to `/auth/sso/{provider}`. The server allowlists the provider and rejects unavailable connections.
2. The backend creates random state, nonce and PKCE verifier values. The verifier stays in the server session; the browser receives only the authorization redirect.
3. Keycloak authenticates the user itself or brokers to the selected provider with `kc_idp_hint`.
4. `/auth/sso/callback` requires the initiating session, matching state and a transaction no older than five minutes. The attempt is consumed before exchanging the code.
5. `openid-client` exchanges and verifies the authorization code, PKCE, issuer, audience, nonce and ID token. Invalid responses do not create a console session.
6. The console regenerates the session ID and resolves local membership. Tokens are kept server-side; they are not returned in `/me` or put into browser storage.
7. Callback query values and redirect Location headers are removed/redacted from request logs. Browser errors use a small fixed set of safe messages. Callback destinations are fixed server-side; request parameters cannot choose an arbitrary redirect.

The implementation follows [openid-client's authorization-code example](https://github.com/panva/openid-client/blob/main/examples/oidc.ts) and [Keycloak identity brokering](https://www.keycloak.org/docs/latest/server_admin/#_identity_broker).

The current sessions and membership directory remain development stores. Broker sign-in does not replace the separate production persistence, membership provisioning or privileged step-up work. External-only users do not acquire a local password or permission to bypass the existing password-based step-up controls.

## Verification

Backend tests cover provider allowlisting, same-origin initiation, fixed callbacks, state binding, expiry, replay, failed verification, cancellation, session rotation and denied membership. Frontend tests cover branded controls, configured availability, failed discovery and safe error messages. Browser QA verifies Company SSO against the real local Keycloak realm, local role resolution, central-session reuse and callback error display. Microsoft/Google/Apple end-to-end tests require their actual provider registrations and have not been run.
