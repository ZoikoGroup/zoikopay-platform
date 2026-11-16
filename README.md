# ZoikoPay

Payment orchestration platform for the merchant pilot.

**Status: skeleton only.** The six programs start, connect to their
dependencies and report health. There is no business logic, no database
tables and no API endpoints yet.

## 1. Prerequisites (one time)

| Tool | Version | Check |
|---|---|---|
| Go | 1.26 or later | `go version` |
| Docker Desktop (or Docker Engine with Compose v2) | Compose 2.20+ | `docker compose version` |
| make, curl, bash | any | |

Docker needs **about 6 GB of free disk** for the images. Keep at least
2 GB free on your Mac afterwards: if the host disk fills while Docker writes,
images can be silently corrupted (files extracted as 0 bytes).

Nothing else to install. Build tools (sqlc, goose, oapi-codegen,
golangci-lint, govulncheck) are pinned in `tools/go.mod` and run with `go tool`.

## 2. Start the local stack (about 5 minutes the first time)

```sh
cp deploy/compose/.env.example deploy/compose/.env   # optional: change ports or passwords
make up       # waits until every service is healthy
make ps       # status
```

| Service | Purpose | Local address |
|---|---|---|
| PostgreSQL 18.1 | system of record, one role per program | `localhost:55432`, database `zoikopay` |
| Temporal dev server | workflows for execution | `localhost:7233`, UI http://localhost:8233 |
| Keycloak 26.4 | Zoiko iD stand-in, realm `zoikopay` | http://localhost:8180 (admin / `local-dev-only-admin`) |
| MinIO | evidence object store | http://localhost:9000, console http://localhost:9001 |
| Grafana LGTM | Grafana, Tempo, Loki, Prometheus | http://localhost:3001 |

All passwords are local-development defaults; never reuse them elsewhere.

The services restart by themselves when Docker restarts (for example after
the Mac sleeps). If sign-in says "temporarily unavailable", check that Docker
Desktop is running; `make up` starts anything still stopped.

## 3. Run the programs

```sh
make run-gateway       # also: run-execution, run-finance, run-governance,
                       #       run-outbox-relay, run-mockpsp
curl localhost:8080/healthz
# {"service":"gateway","status":"ok","checks":{"oidc":"ok","postgres":"ok"}}
```

| Program | Port | Dependencies checked |
|---|---|---|
| gateway (D1) | 8080 | PostgreSQL as `zp_gateway`, Keycloak |
| execution (D2) | 8081 | PostgreSQL as `zp_execution`, Temporal |
| finance (D3) | 8082 | PostgreSQL as `zp_finance` |
| governance (D4) | 8083 | PostgreSQL as `zp_governance`, Keycloak, MinIO |
| outbox-relay | 8084 | PostgreSQL as `zp_relay` |
| mockpsp | 8090 | none |

Each program exposes `/livez` (process up), `/readyz` (plain text) and
`/healthz` (JSON, one entry per dependency). At start-up it retries each
dependency for up to `ZP_STARTUP_TIMEOUT` (default 60s), then exits with an
error. Ctrl-C or SIGTERM drains and shuts down cleanly.
`scripts/local-env.sh` holds the environment variables used locally.

## 4. Test

```sh
make test               # unit tests and the import-boundary test, no Docker (seconds)
make test-integration   # real PostgreSQL 18 via Testcontainers (needs Docker)
make smoke              # all six programs against the running stack: /healthz ok, clean stop
make lint               # golangci-lint and Spectral (OpenAPI)
make vuln               # govulncheck
make gen                # oapi-codegen (and sqlc once a module has queries)
make help               # every target
```

## 5. Stop

```sh
make down    # stop, keep data
make nuke    # stop and delete all local data
```

## Layout

```
cmd/                     the six programs
internal/<module>/       nine bounded contexts; root package = public contract,
                         subpackages domain/ app/ store/ http/ events/ are private
internal/platform/       shared code (health, db, workflow, httpserver, ...)
internal/apigen/         code generated from api/openapi (do not edit)
api/openapi/             OpenAPI 3.1 contracts (empty placeholders)
api/events/<module>/     event schemas
db/migrations/<module>/  goose migrations (empty)
db/queries/<module>/     sqlc queries (empty)
deploy/compose/          local stack
docs/                    specs (.docx, read-only), ADRs, open questions
```

## Admin console

`zoiko-pay-console/` holds the operations console: a React frontend (port
5173) and a Node.js backend-for-frontend (port 4000), each a separate server.
See [zoiko-pay-console/README.md](zoiko-pay-console/README.md) and ADR 0003.

Run it from this folder (after `make up`):

```sh
npm run dev                        # both servers in one terminal (Ctrl+C stops both)
# or, in two terminals:
cd backend  && npm run dev         # `backend` and `frontend` are shortcuts to zoiko-pay-console/*
cd frontend && npm run dev
```

Open http://localhost:5173 and sign in (e.g. `ops.agent` / `Zoiko@123`).

## Documentation

- `docs/spec/INDEX.md`: spec ID to founder document.
- `docs/adr/`: architecture decisions (both PROPOSED, awaiting CTO approval).
- `docs/OPEN_QUESTIONS.md`: spec conflicts and missing documents.
- `CLAUDE.md`: short guide for coding agents.
