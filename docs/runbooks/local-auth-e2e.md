# Runbook: local stack and the authentication end-to-end check

How to set up the local stack from scratch, sign in to the console, and run
`make e2e-auth`, the end-to-end check of authentication and authorization
against real Keycloak, Postgres and the Go gateway.

**Local and synthetic only.** Everything here uses the local Docker stack, the
fictional users of the local Keycloak realm and the synthetic seed. No real
person, merchant, money or provider is involved. The passwords and secrets in
this repository are local development values; never reuse them anywhere else.

## 1. Prerequisites (once)

- Docker Desktop (running), Go 1.26, Node.js 22 or later, GNU make, curl.
- On Windows, run `make` and the scripts from **Git Bash**.
- Install the console dependencies:

  ```sh
  (cd backend && npm ci)
  (cd frontend && npm ci)
  ```

## 2. Start the local stack

From the repository root:

```sh
make up            # Postgres, Keycloak, Temporal, MinIO, Grafana; waits until healthy
make migrate       # applies db/migrations as zp_migrator
make seed-local    # synthetic tenants, merchants and grants for the merchant users
```

`make seed-local` gives grants only to the five merchant users. Platform staff
(super.admin, ops.agent, iam.admin, …) get no grant, so they sign in with no
access (OPEN_QUESTIONS Q39 39.3). Re-running it is safe; it also replaces
expired or revoked seed grants.

## 3. Run the gateway and the console

Three terminals, from the repository root:

```sh
make run-gateway                  # Go gateway on http://localhost:8080
(cd backend && npm run dev)       # console backend on :4000 (reads backend/.env)
(cd frontend && npm run dev)      # console on http://localhost:5173
```

For the backend, copy `backend/.env.example` to `backend/.env` first. The
`.env` file is gitignored and must stay that way.

Open http://localhost:5173 and sign in with a local realm user, for example
`merchant.owner`, `merchant.ops` or `merchant.viewer`. The password is the
local realm password your team uses; it is set in
`deploy/compose/keycloak/zoikopay-realm.json`.

What you should see:

- `merchant.owner`: both Northwind merchants.
- `merchant.ops`: Northwind UK only.
- `merchant.viewer`: Alder only.
- `super.admin` and other staff: the "no access" page.

## 4. Run the end-to-end check

```sh
make e2e-auth
```

It **deletes all local stack data** (`make nuke`), starts the stack clean,
migrates, seeds, starts its own gateway, console backend and frontend, runs
the checks, then stops those three servers. It takes about 4 minutes, most of
which is two 61-second waits for the console's sign-in rate limit.

Before you run it:

- Stop any gateway, console backend or frontend you started yourself.
  Ports 8080, 4000 and 5173 must be free.
- Accept that accounts you created in the local realm, and local database
  rows, will be gone.

Each check prints `PASS`, `FAIL` or `SKIP`, then a total. The exit code is 0
only if every check passed. Server logs are kept in the directory printed at
the end (`gateway.log`, `backend.log`, `frontend.log`, `seed.log`).

What it checks:

| Area | Checks |
|---|---|
| Valid login | Real Keycloak tokens; the gateway's `GET /v1/principal` and the console show only the grants in `merchant.memberships`; staff get nothing |
| Bad tokens | Missing, empty, wrong scheme, garbage, `alg: none`, tampered payload, attacker-signed, algorithm confusion, embedded key, ID token, refresh token, wrong audience, other issuer and expired: all **401** with one identical body |
| Tenant isolation | Another tenant's merchant, a sibling merchant without a grant, an unknown or malformed ID: identical **404**. Own merchant without the permission: **403** |
| Forged authority | Forged headers and query values; real Keycloak-signed tokens carrying forged tenant, persona, realm-role and user-metadata claims: nothing changes |
| Revocation | A grant revoked in Postgres is denied on the next request, for the same token and the same console session; a new grant restores access |
| Audit | Every gateway request has exactly one entry in `governance.audit_events` with the right status and outcome; 401s have no actor, 404s no tenant; every console request is audited through the gateway |
| Logs | No token in the gateway, console backend, frontend, Keycloak or Postgres logs, or in the audit table |

The check briefly changes the local realm (a 5-second token lifespan, extra
claims and roles) and puts every change back. It refuses non-local URLs.

Options:

- `E2E_KEEP_STACK=1 make e2e-auth` reuses the running stack instead of
  resetting it. It is faster but not a clean run.
- `npm --prefix backend run test:e2e` runs only the checks, against servers
  you started yourself. The log-file checks are then skipped (`SKIP`).

## 5. Notes and troubleshooting

**Windows: integration tests and `DOCKER_HOST`.** Run the full Go integration
suite with Docker's pipe set for that one command:

```sh
DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine make test-integration
```

Without it, parallel test packages can fail in under two seconds with
"rootless Docker is not supported on Windows". `make e2e-auth` does not need it.
There is no C compiler on a default Windows setup, so `-race` cannot run
locally; run `go test -tags integration ./...` instead of the make target if it
complains. CI runs on Linux.

**Windows: console tests.** Run `npm test` in `backend/` or `frontend/` from
PowerShell, or from a shell whose working directory uses the same drive-letter
case as Node sees. If every test file fails with "Cannot read properties of
undefined (reading 'config')", the drive letter's case is the cause, not the
code.

**Windows: Spectral.** `make lint-openapi` from Git Bash needs
`MSYS_NO_PATHCONV=1` so Docker receives `/work` unchanged.

**Keycloak realm changes need a new container.** Keycloak imports
`deploy/compose/keycloak/zoikopay-realm.json` only when it creates the realm,
which happens only in a new container. After editing the realm file, recreate
the container:

```sh
docker compose -f deploy/compose/compose.yaml up -d --force-recreate keycloak
```

This also deletes accounts created in the local realm since the last import.
`make nuke && make up` does the same for the whole stack.

**Postgres roles on an old data volume.** Roles come from
`deploy/compose/postgres/init/01-roles.sql`, which runs only when the data
volume is new. If `make migrate` fails because a role such as `zp_audit` is
missing, run `make nuke && make up && make migrate` (this deletes local data)
or create just that role with the statement from the init script.

**Sign-in rate limit.** The console allows 10 password checks a minute per
address (sign-in, password re-entry, registration and password change
together). A script that signs in more often gets `429`.

**A staff user has access.** Access is exactly the user's live rows in
`merchant.memberships`. If a staff user has a role, a merchant grant exists for
their Keycloak ID, for example from earlier manual testing. `make e2e-auth`
starts clean, so it never sees such rows.

**Ports in use.** `make e2e-auth` stops before touching anything if 8080, 4000
or 5173 is in use. Stop the process listening there and retry.
