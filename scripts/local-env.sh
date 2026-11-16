#!/usr/bin/env bash
# Runs a command with the local-stack environment for one ZoikoPay service.
#
#   scripts/local-env.sh <service> <command> [args...]
#   scripts/local-env.sh execution go run ./cmd/execution
#
# Values match deploy/compose/compose.yaml and can be overridden in
# deploy/compose/.env. Local development only: these are not real credentials.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$root/deploy/compose/.env" ]; then
  set -a; . "$root/deploy/compose/.env"; set +a
fi

svc="${1:?usage: local-env.sh <service> <command> [args...]}"; shift

case "$svc" in
  gateway)      role=zp_gateway ;;
  execution)    role=zp_execution ;;
  finance)      role=zp_finance ;;
  governance)   role=zp_governance ;;
  outbox-relay) role=zp_relay ;;
  mockpsp)      role= ;;
  *) echo "unknown service: $svc" >&2; exit 2 ;;
esac

if [ -n "$role" ]; then
  export ZP_DATABASE_URL="postgres://${role}:${ZP_APP_PASSWORD:-local-dev-only-app}@localhost:${ZP_PG_PORT:-55432}/zoikopay?sslmode=disable"
fi
export ZP_TEMPORAL_ADDR="localhost:${ZP_TEMPORAL_PORT:-7233}"
export ZP_TEMPORAL_NAMESPACE="zoikopay-execution"
export ZP_OIDC_ISSUER="http://localhost:${ZP_KEYCLOAK_PORT:-8180}/realms/zoikopay"
export ZP_S3_ENDPOINT="http://localhost:${ZP_MINIO_PORT:-9000}"

exec "$@"
