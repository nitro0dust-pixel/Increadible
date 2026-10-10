# Architecture

One Node.js process, one MCP server, three components we wrote. This page is the map; the code is small enough to read (`src/` and
`features/07` to `09`), and `PERFORMANCE.md` and `DEPLOYMENT.md` hold the numbers and the operations.

```
 Claude Desktop (or any MCP client)                      container / cluster
        |  stdio: newline-delimited JSON-RPC                  |  HTTP: POST /mcp (stateless), /health, /ready, /metrics
        v                                                      v
 +-------------------------------- src/index.ts : transports --------------------------------+
 |  stdio loop | HTTP server: timeouts, bearer token, optional rate limit, drain, refuse-open |
 +----------------------------------------------+----------------------------------------------+
                                                |  one JSON-RPC message at a time
                                      src/server.ts : handler
                          initialize | ping | tools/list | tools/call   (a throwing tool becomes a tool error)
                                                |  metrics: counters, tool-latency and event-loop histograms
        +---------------------------+-----------+---------------+
        v                           v                           v
 features/07 routing        features/08 A/B testing      features/09 API gateway
 rules.yaml (RULES_FILE)    ab-data.jsonl (AB_DATA_FILE) in-memory registry of 9 APIs
 atomic rewrite on update   append-only log + lock       bounded cache; mock by default;
                            running aggregates in RAM    live.ts: the only code that opens a socket
```

## Components

| Part | Files | Responsibility | State it owns |
|---|---|---|---|
| Transports | `src/index.ts`, `src/main.ts` | stdio and HTTP, timeouts, auth, rate limit, graceful shutdown, refusal to start open beyond loopback. `index.ts` starts itself only when it is the program (`require.main === module`); `main.ts`, the entry of the Claude Desktop bundle, always starts it (a launcher that loads `index.ts` with `require()` would get a silent process) | none |
| Handler | `src/server.ts` | JSON-RPC 2.0 validation, tool dispatch, Prometheus text | counters and histograms |
| Routing Plugins (#7) | `features/07-routing-plugins/src/mcp-server.ts` | first matching enabled rule by priority; stats; `update_rules` validates, writes a temporary file, renames it, then switches | the rules (file) and per-rule counters (memory) |
| A/B Testing (#8) | `features/08-ab-testing/src/mcp-server.ts` | experiments with 2 to 10 variants, sticky hash assignment, Welch t-test, Holm correction, guardrails | `AB_DATA_FILE` (append-only JSON lines) and, in memory, counts plus a running mean and variance per variant and metric |
| API Gateway (#9) | `features/09-api-gateway/src/mcp-server.ts`, `live.ts` | discovery, cached `call_api`, bounded `aggregate_apis`; mock data unless an API is made live | a bounded result cache (500 entries, about 16 MiB) |
| Packaging (Claude Desktop) | `mcpb/manifest.json`, `scripts/mcpb.js`, `scripts/zip.js` | builds the one-click `.mcpb` bundle from the committed sources (compile into a clean stage, `npm ci --omit=dev --ignore-scripts` from the lockfile, sorted entries, fixed timestamps) and checks a bundle; `scripts/zip.js` is the zip writer it shares with `scripts/skill.js` | none |
| Vendored third-party | `features/01` to `06` | OmniRoute, claude-mem, token-optimizer-mcp, gstack, agentacct | **not integrated or tested here**; they run beside this server, never inside it (`COMPANIONS.md`) |

## Request flow (one tool call)

1. The client writes one JSON-RPC line (stdio) or POSTs one message (HTTP).
2. The transport enforces its limits (body size, receive timeouts, bearer token, rate limit) and passes the parsed message on.
3. The handler checks it is JSON-RPC 2.0 with a valid id, finds the module that owns the tool and calls it. A thrown error becomes `{error}` with `isError: true`; the handler never throws.
4. The module validates its arguments (types, sizes, ids), does the work, and returns JSON text. A/B writes go to the log first and to memory second.
5. The handler records the call count and latency and wraps the text as MCP content.

## Invariants the tests hold

| Invariant | Held by |
|---|---|
| stdout carries only JSON-RPC; logs go to stderr | `scripts/smoke.sh`, `tests/entry-point.test.ts` |
| One writer per A/B data file; a lost lock makes writes fail closed | `tests/e2e-integration.test.ts` (lock section), smoke and the image probe |
| Memory and query cost of A/B results do not grow with the data | `tests/ab-golden.test.ts` (answers equal to the earlier array-based version), `PERFORMANCE.md` |
| The gateway cannot reach another host or path than the API's registered URL, and a credential never appears in a result, error, log or cache key | `tests/gateway-live.test.ts` (real local server, 60 000-endpoint property test) |
| The 13 tools and their input schemas (item shapes, bounds, enums, examples and defaults included) do not change by accident | `tests/tool-contract.test.ts` |
| Every example in a tool schema is run through the handler; no description states a limit as a number (a tripwire pins the few numbers that remain; the limits are schema keywords); no schema refuses what a handler accepts (the listed places where the schema is stricter are pinned) | `tests/schema-examples.test.ts`, `tests/schema-no-narrowing.test.ts` |
| A server reachable beyond loopback refuses to start without `AUTH_TOKEN` | `tests/server.test.ts`, smoke, image probe |
| One Node major across the image, CI and `@types/node` | `tests/config.test.ts` |
| A copy of the server that cannot have its A/B data file (held by another copy, left locked by a killed one, or on an unusable folder) still answers the handshake and every other tool, with `AB_LAZY_OPEN`; the lock loop has a deadline and never spins; the default (open at start-up, refuse at once) is unchanged | `tests/ab-lazy.test.ts`, `tests/entry-point.test.ts` (child processes with a time limit), `tests/mcpb.test.ts` (copies of the installed bundle side by side) |
| The Claude Desktop manifest lists the tools the server lists, sets only settings the code reads, and agrees with `package.json`; the bundle holds the compiled server and its production dependencies only, is the same bytes when built again, and starts from its unpacked files with the data in the folder the user chose | `tests/mcpb.test.ts` |

## Trust boundaries

| Input | Trust | What is done with it |
|---|---|---|
| Tool arguments (from a model) | untrusted | typed, size-limited and id-checked before use; `endpoint` and `params` of a live gateway call can only form a URL under the registered one |
| The rules file and the experiments file | operator-controlled, still validated | the same validator as `update_rules`; an invalid rules file falls back to the built-in rules with a message |
| The A/B data file | written only by this server | replay skips torn or invalid lines and says how many |
| Environment variables | operator-controlled | integers are bounds-checked; a bad value falls back with a message |
| The `.mcpb` bundle | built here, not downloaded | compiled from the committed sources; dependencies installed from the lockfile with install scripts off; `.env` files, source maps and the lockfile left out; `inspect` refuses unsafe names and bad checksums. It is **unsigned** |
| Provider responses (live gateway) | untrusted | JSON only, size and time capped, redirects refused, error bodies scrubbed of the credential |

## Limits you should know

- **One replica.** The A/B data file has a single writer, so Kubernetes runs one pod with a `Recreate` strategy; scaling out needs a different storage design.
- **The data file is never compacted.** Memory is flat, but the file grows (a 1 GiB volume holds about 8.9 million measurements); rollup or rotation is a backlog item.
- **No savings have been measured.** The old percentages were targets (`ROADMAP.md`).
- **Live gateway calls have run against the real providers only for the four keyless APIs** (one call each, 2026-10-10, from Claude Desktop); the key-based APIs never.
- **Statistics are a fixed-sample snapshot.** Asking repeatedly while data arrives and acting on the first significant answer inflates false positives; there is no sequential testing.
