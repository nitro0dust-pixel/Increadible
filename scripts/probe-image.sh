#!/usr/bin/env bash
# Probes a container image the way a deployment would run it. Needs Docker, curl and jq.
# Usage: scripts/probe-image.sh <image-ref>     (e.g. increadible:ci or ghcr.io/org/img@sha256:...)
# Checks: image config (non-root, command, architecture, HEALTHCHECK), health/auth/MCP over HTTP,
# Docker's own health status, that A/B data survives a hard-killed container on a named volume (with AB_FSYNC on,
# and the dead container's data file lock taken over), and that a second container on the same volume is refused.
set -euo pipefail
IMAGE=${1:?usage: probe-image.sh <image-ref>}
PORT=${PROBE_PORT:-3000}
TOKEN=probe-token
A="inc-probe-a-$$"; B="inc-probe-b-$$"; C="inc-probe-c-$$"; VOL="inc-probe-data-$$"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for c in "$A" "$B" "$C"; do docker logs "$c" 2>&1 | tail -30 || true; done
  fi
  docker rm -f "$A" "$B" "$C" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
rpc() { curl -fs -H "Authorization: Bearer $TOKEN" -d "$1" "localhost:$PORT/mcp"; }
wait_up() {
  # Up to 45s: a hard-killed container leaves a data file lock that the next container (another hostname) may have to wait out.
  for _ in $(seq 1 45); do curl -fs "localhost:$PORT/health" >/dev/null 2>&1 && return 0; sleep 1; done
  fail "server did not become reachable on port $PORT"
}
start() { docker run -d --name "$1" -p "$PORT:3000" -v "$VOL:/data" -e "AUTH_TOKEN=$TOKEN" -e AB_FSYNC=1 "$IMAGE" >/dev/null; wait_up; }

echo "[config] $IMAGE"
[ "$(docker image inspect --format '{{.Config.User}}' "$IMAGE")" = "node" ] || fail "image must run as user 'node'"
[ "$(docker image inspect --format '{{join .Config.Cmd " "}}' "$IMAGE")" = "node dist/src/index.js" ] || fail "unexpected CMD"
[ "$(docker image inspect --format '{{.Architecture}}' "$IMAGE")" = "amd64" ] || fail "expected an amd64 image"
# Capture, then match: under pipefail a `cmd | grep -q` fails with SIGPIPE (141) whenever cmd is still writing after the match.
hc=$(docker image inspect --format '{{json .Config.Healthcheck}}' "$IMAGE")
[[ "$hc" == *'"Test"'* ]] || fail "image has no HEALTHCHECK"

echo "[http] health, auth, MCP tool list"
docker volume create "$VOL" >/dev/null
start "$A"
[ "$(curl -s -o /dev/null -w '%{http_code}' "localhost:$PORT/metrics")" = 401 ] || fail "/metrics must require the token"
rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -e '.result.tools | length == 13' >/dev/null || fail "expected 13 tools"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apply_routing_rules","arguments":{"task_type":"qa","task_complexity":"low"}}}' \
  | jq -r '.result.content[0].text' | jq -e '.provider == "claude-haiku"' >/dev/null || fail "routing tool returned the wrong provider"

echo "[persistence] A/B data must survive a hard-killed container (named volume, non-root, AB_FSYNC=1)"
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_experiment","arguments":{"id":"probe","name":"n","hypothesis":"h","metrics":[{"id":"q","name":"q","type":"c","aggregation":"mean"}],"variants":[{"id":"A","name":"a","config":{}},{"id":"B","name":"b","config":{}}]}}}' \
  | jq -e '.result.isError == false' >/dev/null || fail "create_experiment failed (is /data writable by the non-root user?)"
rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"record_metric","arguments":{"experiment_id":"probe","variant_id":"A","metrics":{"q":1}}}}' \
  | jq -e '.result.isError == false' >/dev/null || fail "record_metric failed"
docker rm -f "$A" >/dev/null # SIGKILL: A cannot release its data file lock, B has to take it over
start "$B"
rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_experiment_results","arguments":{"experiment_id":"probe"}}}' \
  | jq -r '.result.content[0].text' | jq -e '.statistical_analysis.current_samples == 1' >/dev/null || fail "A/B data was lost across the restart"

echo "[lock] a second container on the same volume must be refused while the first one runs"
docker run -d --name "$C" -v "$VOL:/data" -e AB_FSYNC=1 "$IMAGE" >/dev/null
code=$(timeout 90 docker wait "$C") || fail "the second container neither exited nor was refused within 90s"
[ "$code" != 0 ] || fail "a second container was allowed to open the same A/B data file"
c_logs=$(docker logs "$C" 2>&1)
grep -Eq "in use by pid|could not be checked from here" <<<"$c_logs" || fail "the second container failed for the wrong reason: $(tail -5 <<<"$c_logs")"
curl -fs "localhost:$PORT/health" >/dev/null || fail "the first container was disturbed by the refused second one"

echo "[healthcheck] Docker's HEALTHCHECK must report healthy (waiting up to 60s)"
for _ in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$B")" = "healthy" ] && { echo "probe: OK"; exit 0; }
  sleep 1
done
fail "container never became healthy (status: $(docker inspect --format '{{.State.Health.Status}}' "$B"))"
