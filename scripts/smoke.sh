#!/usr/bin/env bash
# Smoke test for the skeleton. Needs the local stack (`make up`) and built
# binaries (`make build`). For each of the six services it:
#   1. starts the binary with the local environment,
#   2. waits for /healthz to return 200 with "status":"ok",
#   3. sends SIGTERM and checks the process exits 0 and logs "service stopped".
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
logdir="$(mktemp -d)"
trap 'rm -rf "$logdir"' EXIT

services=(gateway:8080 execution:8081 finance:8082 governance:8083 outbox-relay:8084 mockpsp:8090)
failed=0

for entry in "${services[@]}"; do
  svc="${entry%%:*}"; port="${entry##*:}"
  log="$logdir/$svc.log"
  scripts/local-env.sh "$svc" env ZP_STARTUP_TIMEOUT=30s "bin/$svc" >"$log" 2>&1 &
  pid=$!

  body=""
  for _ in $(seq 1 60); do
    if body="$(curl -fsS "http://localhost:$port/healthz" 2>/dev/null)"; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done

  if [[ "$body" == *'"status":"ok"'* ]]; then
    kill -TERM "$pid"
    if wait "$pid" && grep -q '"service stopped"' "$log"; then
      echo "PASS $svc  $body"
    else
      echo "FAIL $svc  did not shut down cleanly"; failed=1; cat "$log"
    fi
  else
    echo "FAIL $svc  /healthz never became ok (last body: ${body:-none})"; failed=1
    kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
    cat "$log"
  fi
done

exit "$failed"
