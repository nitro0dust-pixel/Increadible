#!/usr/bin/env bash
# Probes a container image the way a deployment would run it. Needs Docker, curl and jq.
# Usage: scripts/probe-image.sh <image-ref>     (e.g. increadible:ci or ghcr.io/org/img@sha256:...)
# Checks: image config (non-root, command, architecture, HEALTHCHECK), health/auth/MCP over HTTP,
# Docker's own health status, that A/B data survives a hard-killed container on a named volume (with AB_FSYNC on,
# and the dead container's data file lock taken over), that a second container on the same volume is refused,
# that a bad tool input does not kill the server, that the image (HOST=0.0.0.0) refuses to start without AUTH_TOKEN,
# that `docker stop` ends the server cleanly (exit 0) and releases the data file lock, and that a data file of 500 000
# measurements (58 MiB) still starts and answers inside a 256 MiB memory limit, the limit the Kubernetes manifests set.
set -euo pipefail
IMAGE=${1:?usage: probe-image.sh <image-ref>}
PORT=${PROBE_PORT:-3000}
TOKEN=probe-token
A="inc-probe-a-$$"; B="inc-probe-b-$$"; C="inc-probe-c-$$"; D="inc-probe-d-$$"; E="inc-probe-e-$$"
VOL="inc-probe-data-$$"; VOL_BIG="inc-probe-big-$$"
SCRIPTS=$(cd "$(dirname "$0")" && pwd)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for c in "$A" "$B" "$C" "$D" "$E"; do docker logs "$c" 2>&1 | tail -30 || true; done
  fi
  docker rm -f "$A" "$B" "$C" "$D" "$E" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$VOL_BIG" >/dev/null 2>&1 || true
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
metrics=$(curl -fs -H "Authorization: Bearer $TOKEN" "localhost:$PORT/metrics")
grep -q 'increadible_tool_call_duration_seconds_count{tool="apply_routing_rules"} 1' <<<"$metrics" \
  || fail "/metrics has no latency histogram for the tool call just made"
# This input used to throw out of the tool and end the process.
rpc '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"discover_apis","arguments":{"query":123}}}' \
  | jq -e '.result.isError == true' >/dev/null || fail "a bad tool input was not reported as a tool error"
curl -fs "localhost:$PORT/health" >/dev/null || fail "the server died on a bad tool input"

echo "[exposure] the image binds 0.0.0.0, so it must refuse to start without AUTH_TOKEN"
docker run -d --name "$D" "$IMAGE" >/dev/null
code=$(timeout 60 docker wait "$D") || fail "the container without AUTH_TOKEN neither exited nor was refused within 60s"
[ "$code" != 0 ] || fail "a container without AUTH_TOKEN was allowed to start"
d_logs=$(docker logs "$D" 2>&1)
grep -q "Refusing to listen" <<<"$d_logs" || fail "the container without AUTH_TOKEN failed for the wrong reason: $(tail -5 <<<"$d_logs")"

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
docker run -d --name "$C" -v "$VOL:/data" -e "AUTH_TOKEN=$TOKEN" -e AB_FSYNC=1 "$IMAGE" >/dev/null
code=$(timeout 90 docker wait "$C") || fail "the second container neither exited nor was refused within 90s"
[ "$code" != 0 ] || fail "a second container was allowed to open the same A/B data file"
c_logs=$(docker logs "$C" 2>&1)
grep -Eq "in use by pid|could not be checked from here" <<<"$c_logs" || fail "the second container failed for the wrong reason: $(tail -5 <<<"$c_logs")"
curl -fs "localhost:$PORT/health" >/dev/null || fail "the first container was disturbed by the refused second one"

echo "[healthcheck] Docker's HEALTHCHECK must report healthy (waiting up to 60s)"
healthy=""
for _ in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$B")" = "healthy" ] && { healthy=yes; break; }
  sleep 1
done
[ -n "$healthy" ] || fail "container never became healthy (status: $(docker inspect --format '{{.State.Health.Status}}' "$B"))"

echo "[shutdown] docker stop must end the server cleanly (exit 0, not SIGKILL's 137) and release the data file lock"
docker stop -t 20 "$B" >/dev/null
code=$(docker inspect --format '{{.State.ExitCode}}' "$B")
[ "$code" = 0 ] || fail "docker stop ended the server with exit code $code (a clean SIGTERM shutdown exits 0)"
listing=$(docker run --rm -v "$VOL:/data" --entrypoint ls "$IMAGE" -a /data)
grep -qx "ab-data.jsonl" <<<"$listing" || fail "the A/B data file is missing after a clean stop: $listing"
! grep -qx "ab-data.jsonl.lock" <<<"$listing" || fail "the data file lock was left behind after a clean stop"
echo "[capacity] 500000 A/B measurements (a 58 MiB data file) must start and answer inside a 256 MiB memory limit (the manifests' limit)"
# The data file is written by the image's own node (as the non-root user, into a fresh named volume), from the script in this checkout.
docker volume create "$VOL_BIG" >/dev/null
gen=$(docker run --rm -v "$VOL_BIG:/data" -v "$SCRIPTS:/scripts:ro" --entrypoint node "$IMAGE" \
  /scripts/make-ab-data.js --file /data/ab-data.jsonl --measurements 500000 2>&1) || fail "could not write the large data file: $gen"
# No swap, so the limit is a hard one. With every measurement held in memory (about 450 bytes each) this container was killed at startup.
docker run -d --name "$E" --memory=256m --memory-swap=256m -p "$PORT:3000" -v "$VOL_BIG:/data" \
  -e "AUTH_TOKEN=$TOKEN" -e AB_FSYNC=1 "$IMAGE" >/dev/null
up=""
for _ in $(seq 1 60); do
  curl -fs "localhost:$PORT/health" >/dev/null 2>&1 && { up=yes; break; }
  [ "$(docker inspect --format '{{.State.Running}}' "$E")" = "true" ] || break
  sleep 1
done
[ -n "$up" ] || fail "the container with 500000 measurements never answered (OOMKilled: $(docker inspect --format '{{.State.OOMKilled}}' "$E"), exit code $(docker inspect --format '{{.State.ExitCode}}' "$E")): $(docker logs "$E" 2>&1 | tail -3)"
big=$(rpc '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_experiment_results","arguments":{"experiment_id":"cap"}}}' \
  | jq -r '.result.content[0].text') || fail "get_experiment_results failed on the large data file"
jq -e '.status == "complete" and .variant_results.A.metrics.q.sample_size == 250000 and .variant_results.B.metrics.q.sample_size == 250000' <<<"$big" >/dev/null \
  || fail "wrong results for 500000 measurements: $big"
[ "$(docker inspect --format '{{.State.OOMKilled}}' "$E")" = "false" ] || fail "the container was OOM-killed under the 256 MiB limit"
# Evidence for the record (not asserted): the most memory the container's cgroup has used. cgroup v2 only; skipped elsewhere.
peak=$(docker exec "$E" cat /sys/fs/cgroup/memory.peak 2>/dev/null || true)
[[ "$peak" =~ ^[0-9]+$ ]] && echo "  peak memory of the container: $((peak / 1048576)) MiB of 256 MiB"
echo "probe: OK"
