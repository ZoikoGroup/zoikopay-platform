#!/usr/bin/env bash
# Authentication end-to-end check from a clean local stack (run: make e2e-auth).
#
#   1. Deletes the local stack's data (make nuke) and starts it again
#      (Keycloak re-imports the realm), applies migrations and the synthetic
#      seed. Set E2E_KEEP_STACK=1 to skip the reset (faster, but not clean).
#   2. Starts the gateway, the console backend and the frontend, each logging
#      to a file in a fresh log directory.
#   3. Runs backend/scripts/e2e-auth.mjs, which prints PASS/FAIL per check.
#   4. Stops the three servers. The Docker stack is left running.
#
# LOCAL STACK AND SYNTHETIC DATA ONLY. Needs Docker, Go, Node, and `npm ci`
# done in backend/ and frontend/. Ports 8080, 4000 and 5173 must be free.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

logs="${E2E_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/zoikopay-e2e.XXXXXX")}"
mkdir -p "$logs/bin"
pids=()

say() { printf '\n== %s\n' "$*"; }
die() { printf 'e2e-auth: %s\n' "$*" >&2; exit 2; }

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Stops a server and anything it started. On Windows (Git Bash) the native
# process is ended with taskkill, which a plain kill does not always reach.
stop() {
  local pid="$1"
  if [ -r "/proc/$pid/winpid" ] && command -v taskkill >/dev/null 2>&1; then
    taskkill //F //T //PID "$(cat "/proc/$pid/winpid")" >/dev/null 2>&1 || true
  fi
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  local code=$?
  for pid in "${pids[@]}"; do stop "$pid"; done
  printf '\nServers stopped. Logs: %s\n' "$logs"
  exit "$code"
}
trap cleanup EXIT INT TERM

wait_for() { # name url seconds logfile
  local i
  for ((i = 0; i < $3; i++)); do
    if curl -fsS -o /dev/null "$2" 2>/dev/null; then printf '   %s is up\n' "$1"; return 0; fi
    sleep 1
  done
  printf 'e2e-auth: %s did not start; last log lines:\n' "$1" >&2
  tail -20 "$4" >&2 || true
  exit 1
}

say "Prerequisites"
for tool in docker go node curl make; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
for dir in backend frontend; do [ -d "$dir/node_modules" ] || die "run 'npm ci' in $dir/ first"; done
for port in 8080 4000 5173; do
  if port_busy "$port"; then die "port $port is in use: stop the gateway, console backend or frontend that is running, then retry"; fi
done
printf '   tools present, ports free, logs in %s\n' "$logs"

if [ "${E2E_KEEP_STACK:-}" = 1 ]; then
  say "Local stack: reusing it (E2E_KEEP_STACK=1, not a clean run)"
  make up
else
  say "Local stack: deleting local data and starting clean (synthetic data only)"
  make nuke
  make up
fi
make migrate
say "Synthetic seed"
make seed-local >"$logs/seed.log"
printf '   tenants, merchants and merchant-user grants written (see seed.log)\n'

# Start time for the container log scan; container logs before it are ignored.
export E2E_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export E2E_LOG_DIR="$logs"

say "Starting the gateway, console backend and frontend"
exe=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe" ;; esac
go build -o "$logs/bin/gateway$exe" ./cmd/gateway
scripts/local-env.sh gateway "$logs/bin/gateway$exe" >"$logs/gateway.log" 2>&1 &
pids+=("$!")
# The backend reads the committed local example settings, never a personal .env.
(cd backend && exec node --env-file=.env.example --import tsx src/server.ts) >"$logs/backend.log" 2>&1 &
pids+=("$!")
(cd frontend && exec node node_modules/vite/bin/vite.js --port 5173 --strictPort) >"$logs/frontend.log" 2>&1 &
pids+=("$!")
wait_for gateway http://localhost:8080/healthz 60 "$logs/gateway.log"
wait_for "console backend" http://localhost:4000/api/v1/health/live 60 "$logs/backend.log"
wait_for frontend http://localhost:5173/ 60 "$logs/frontend.log"

say "Running the checks"
node backend/scripts/e2e-auth.mjs
