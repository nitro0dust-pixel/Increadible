#!/usr/bin/env bash
# Smoke-tests the compiled server (dist/) over stdio and HTTP. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/src/index.js ] || { echo "dist/ missing: run 'npm run build' first" >&2; exit 1; }

TMP=$(mktemp -d)
PID=""
EXTRA=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; [ -n "$EXTRA" ] && kill $EXTRA 2>/dev/null || true; rm -rf "$TMP"; }
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

echo "[persistence] A/B data must survive a process restart (AB_DATA_FILE)"
export AB_DATA_FILE="$TMP/ab-data.jsonl"
EXP='{"id":"smoke","name":"n","hypothesis":"h","metrics":[{"id":"q","name":"q","type":"c","aggregation":"mean"}],"variants":[{"id":"A","name":"a","config":{}},{"id":"B","name":"b","config":{}}]}'
{
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"create_experiment\",\"arguments\":$EXP}}"
  for i in $(seq 1 60); do
    printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$((i+1)),\"method\":\"tools/call\",\"params\":{\"name\":\"record_metric\",\"arguments\":{\"experiment_id\":\"smoke\",\"variant_id\":\"A\",\"metrics\":{\"q\":$((10 + i % 3))}}}}"
    printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$((i+100)),\"method\":\"tools/call\",\"params\":{\"name\":\"record_metric\",\"arguments\":{\"experiment_id\":\"smoke\",\"variant_id\":\"B\",\"metrics\":{\"q\":$((5 + i % 3))}}}}"
  done
} | node dist/src/index.js 2>/dev/null >/dev/null
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_experiment_results","arguments":{"experiment_id":"smoke"}}}' \
  | node dist/src/index.js 2>/dev/null \
  | node -e '
    const r = JSON.parse(JSON.parse(require("fs").readFileSync(0, "utf8")).result.content[0].text);
    const assert = require("assert");
    assert.strictEqual(r.status, "complete", "results lost across restart: " + JSON.stringify(r));
    assert.strictEqual(r.winner, "A");
    assert.strictEqual(r.variant_results.A.metrics.q.sample_size, 60);
  '

echo "[lock] clean exit releases the data file lock; a second writer is refused; SIGTERM releases it"
[ ! -e "$AB_DATA_FILE.lock" ] || { echo "lock left behind after a clean exit" >&2; exit 1; }
hold() { # start a server that stays up (stdin is a fifo we keep open) and wait until it holds the lock
  rm -f "$TMP/hold.fifo"; mkfifo "$TMP/hold.fifo"
  node dist/src/index.js <"$TMP/hold.fifo" >/dev/null 2>"$TMP/holder.err" &
  PID=$!
  exec 3<>"$TMP/hold.fifo"
  for _ in $(seq 1 50); do [ -e "$AB_DATA_FILE.lock" ] && return 0; sleep 0.1; done
  echo "holder never took the lock: $(cat "$TMP/holder.err")" >&2; exit 1
}
hold
if echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | node dist/src/index.js >/dev/null 2>"$TMP/second.err"; then
  echo "a second writer was allowed on the same data file" >&2; exit 1
fi
grep -q "in use by pid $PID" "$TMP/second.err" \
  || { echo "second writer failed for the wrong reason: $(head -5 "$TMP/second.err")" >&2; exit 1; }
kill -TERM "$PID"; wait "$PID" 2>/dev/null || true; PID=""; exec 3>&-
[ ! -e "$AB_DATA_FILE.lock" ] || { echo "SIGTERM did not release the lock" >&2; exit 1; }

echo "[lock] a crashed (SIGKILL) holder's lock is taken over and its data survives"
hold
kill -KILL "$PID"; wait "$PID" 2>/dev/null || true; PID=""; exec 3>&-
[ -e "$AB_DATA_FILE.lock" ] || { echo "SIGKILL should have left the lock behind" >&2; exit 1; }
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_experiment_results","arguments":{"experiment_id":"smoke"}}}' \
  | node dist/src/index.js 2>/dev/null \
  | node -e '
    const r = JSON.parse(JSON.parse(require("fs").readFileSync(0, "utf8")).result.content[0].text);
    require("assert").strictEqual(r.variant_results.A.metrics.q.sample_size, 60, "data lost after a crash: " + JSON.stringify(r));
  '
unset AB_DATA_FILE

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
grep -q '"isError":false' <<<"$RES" || { echo "tools/call over HTTP failed: $RES" >&2; exit 1; }
METRICS=$(curl -s "${AUTH[@]}" "http://127.0.0.1:$PORT/metrics")
grep -q 'increadible_tool_calls_total{tool="get_api_stats"} 1' <<<"$METRICS" \
  || { echo "metrics missing tool counter" >&2; exit 1; }
echo "[hardening] a tool input that throws must not kill the server (HTTP and stdio)"
BAD='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_apis","arguments":{"query":123}}}'
RES=$(curl -s "${AUTH[@]}" -d "$BAD" "http://127.0.0.1:$PORT/mcp" || true) # a dead server must reach the message below, not abort on curl's exit code
grep -q 'query must be a string' <<<"$RES" || { echo "bad discover_apis input was not reported as a tool error: $RES" >&2; exit 1; }
[ "$(code "http://127.0.0.1:$PORT/health")" = 200 ] || { echo "the HTTP server died on a bad tool input" >&2; exit 1; }
printf '%s\n' "$BAD" '{"jsonrpc":"2.0","id":2,"method":"ping"}' | node dist/src/index.js 2>/dev/null | node -e '
  const assert = require("assert");
  const msgs = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(msgs.length, 2, "the stdio session ended early: " + JSON.stringify(msgs));
  assert.strictEqual(msgs[0].result.isError, true);
  assert.deepStrictEqual(msgs[1].result, {});
'

echo "[hardening] an open API beyond this machine is refused, unless explicitly allowed"
P2=$((PORT + 1))
for token in unset empty; do
  # `timeout`: a server that wrongly starts never returns, which must fail here instead of hanging the script
  rc=0
  if [ "$token" = unset ]; then
    timeout 10 env HOST=0.0.0.0 PORT=$P2 node dist/src/index.js >/dev/null 2>"$TMP/open.err" || rc=$?
  else
    timeout 10 env AUTH_TOKEN="" HOST=0.0.0.0 PORT=$P2 node dist/src/index.js >/dev/null 2>"$TMP/open.err" || rc=$?
  fi
  [ "$rc" = 1 ] || { echo "HOST=0.0.0.0 with AUTH_TOKEN $token must be refused with exit 1, got $rc" >&2; exit 1; }
  grep -q "Refusing to listen" "$TMP/open.err" || { echo "refused for the wrong reason ($token): $(head -3 "$TMP/open.err")" >&2; exit 1; }
done
ALLOW_UNAUTHENTICATED=1 HOST=0.0.0.0 PORT=$P2 node dist/src/index.js >/dev/null 2>"$TMP/open.err" &
SRV=$!; EXTRA="$SRV"
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$P2/health" >/dev/null 2>&1 && break; sleep 0.1; done
[ "$(code "http://127.0.0.1:$P2/health")" = 200 ] || { echo "ALLOW_UNAUTHENTICATED=1 did not start the server" >&2; exit 1; }
kill "$SRV"; wait "$SRV" 2>/dev/null || true; EXTRA=""

echo "[hardening] SIGTERM: /ready answers 503 while draining; a stalled client cannot hold the process"
cat >"$TMP/stall.js" <<'JS'
const s = require("net").connect(Number(process.argv[2]), "127.0.0.1");
s.on("error", () => process.exit(0));
s.on("close", () => process.exit(0));
s.write('POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":');
setTimeout(() => process.exit(0), 30000);
JS
start_on() { # port, then extra env assignments: starts a server in the background and waits until it answers
  local port=$1; shift
  env "$@" PORT="$port" HOST=127.0.0.1 node dist/src/index.js >/dev/null 2>"$TMP/srv-$port.err" &
  SRV=$!; EXTRA="$SRV"
  for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$port/health" >/dev/null 2>&1 && return 0; sleep 0.1; done
  echo "server on $port did not start: $(head -3 "$TMP/srv-$port.err")" >&2; exit 1
}
wait_exit() { # seconds: waits for $SRV to exit and leaves its exit code in $RC
  for _ in $(seq 1 $(($1 * 10))); do kill -0 "$SRV" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$SRV" 2>/dev/null; then kill -KILL "$SRV"; echo "the server was still running $1 s after SIGTERM" >&2; exit 1; fi
  wait "$SRV" && RC=0 || RC=$?
  EXTRA=""
}
P3=$((PORT + 2))
start_on "$P3" SHUTDOWN_DRAIN_MS=2000
kill -TERM "$SRV"; sleep 0.5
[ "$(code "http://127.0.0.1:$P3/ready")" = 503 ] || { echo "/ready must answer 503 while draining" >&2; exit 1; }
[ "$(code "http://127.0.0.1:$P3/health")" = 200 ] || { echo "/health must stay 200 while draining" >&2; exit 1; }
wait_exit 8
[ "$RC" = 0 ] || { echo "a drained, idle server must exit 0, got $RC" >&2; exit 1; }

P4=$((PORT + 3))
start_on "$P4" SHUTDOWN_TIMEOUT_MS=1000
node "$TMP/stall.js" "$P4" & STALL=$!
sleep 0.5
kill -TERM "$SRV"
wait_exit 5
kill "$STALL" 2>/dev/null || true
[ "$RC" = 1 ] || { echo "a stalled client must be cut at the deadline (exit 1), got $RC" >&2; exit 1; }
grep -q "deadline passed" "$TMP/srv-$P4.err" || { echo "no deadline message: $(head -3 "$TMP/srv-$P4.err")" >&2; exit 1; }
echo "smoke: OK"
