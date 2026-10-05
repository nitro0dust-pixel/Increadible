#!/usr/bin/env bash
# Smoke-tests the compiled server (dist/) over stdio and HTTP. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/src/index.js ] || { echo "dist/ missing: run 'npm run build' first" >&2; exit 1; }

TMP=$(mktemp -d)
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
export RULES_FILE="$TMP/rules.yaml" EXPERIMENTS_FILE="$TMP/experiments.yaml"

echo "[stdio] initialize, tools/list, tools/call; stdout must be pure JSON-RPC"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"apply_routing_rules","arguments":{"task_type":"qa","task_complexity":"low"}}}' \
  | node dist/src/index.js 2>"$TMP/stderr" \
  | node -e '
    const assert = require("assert");
    const msgs = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(msgs.length, 3, "expected 3 replies (the notification gets none)");
    assert.strictEqual(msgs[0].result.serverInfo.name, "increadible");
    assert.strictEqual(msgs[1].result.tools.length, 13);
    assert.strictEqual(JSON.parse(msgs[2].result.content[0].text).provider, "claude-haiku");
  '

PORT=${SMOKE_PORT:-3199}
echo "[http] port $PORT: health, auth, /mcp, /metrics"
PORT=$PORT HOST=127.0.0.1 AUTH_TOKEN=smoke-token node dist/src/index.js 2>"$TMP/http.err" &
PID=$!
for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "http://127.0.0.1:$PORT/health")" = 200 ] || { echo "health failed" >&2; exit 1; }
[ "$(code "http://127.0.0.1:$PORT/metrics")" = 401 ] || { echo "metrics must require auth" >&2; exit 1; }
AUTH=(-H "Authorization: Bearer smoke-token")
RES=$(curl -s "${AUTH[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_api_stats","arguments":{}}}' "http://127.0.0.1:$PORT/mcp")
echo "$RES" | grep -q '"isError":false' || { echo "tools/call over HTTP failed: $RES" >&2; exit 1; }
curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/metrics" | grep -q 'increadible_tool_calls_total{tool="get_api_stats"} 1' \
  || { echo "metrics missing tool counter" >&2; exit 1; }
echo "smoke: OK"
