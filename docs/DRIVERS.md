# Request drivers: real calls to the server, from the command line

Four small programs that start the real server (or reach one that is running), send it real JSON-RPC requests, check the answers
against written expectations, and print a report. They are Stage 1 of the plan for drivers; what is not built yet is in
section 10. Nothing here is a load test (that is `npm run loadtest`, [PERFORMANCE.md](../PERFORMANCE.md)) and nothing here proves
that Claude Desktop accepts the package (that needs the app, [INSTALL-CLAUDE-DESKTOP.md](INSTALL-CLAUDE-DESKTOP.md)).

| | |
|---|---|
| Status | built and tested on Linux with Node 22 (the authoring sandbox); the same tests run in CI on Node 24 |
| Windows | **NOT VERIFIED**: no Windows machine was available. The drivers use no shell and no Unix-only call, but how Windows ends a process on SIGTERM differs, so the shutdown checks are the first place to look |
| Against a real provider | **NOT AVAILABLE**: every gateway call in these drivers answers sample data (`source: "mock"`); live calls are Stage 4 and need the owner |
| Dependencies | none (Node's own modules only) |

## 1. Which driver answers which question

| Driver | `npm run` | It starts | It answers |
|---|---|---|---|
| stdio | `drive:stdio` | `dist/src/main.js`, the file Claude Desktop starts, with its own data directory | does the server do what its tools promise when a client talks to it the way Claude Desktop does, and does it leave cleanly when the client goes away |
| http | `drive:http` | `dist/src/index.js` on a free loopback port with a random bearer token; or nothing: with `--url` it reaches a server that is already running | the same scenario over `POST /mcp`, plus `/ready`, `/health`, the refusal of a request without the token, `/metrics`, and the SIGTERM shutdown |
| probe | `drive:probe` | both servers, one after the other | how the server answers what a well-behaved client never sends (malformed JSON, a batch, an oversize body, a foreign Origin) and how it ends; where it differs from the MCP specification |
| bundle | `drive:bundle` | the server **from the `.mcpb` package**, unpacked the way Claude Desktop unpacks it | is the package complete and does it start with the manifest's own command and environment; does the data land in the folder the user chose |

All four use one library (`scripts/drive-lib.js`) and one scenario format (section 6). The stdio and the bundle driver run the
same scenario with the same checks, so a difference between them is a difference in the package, not in the driver.

## 2. Before you run any of them

1. Node 22 or later (`node --version`); the repository root as the current directory.
2. `npm ci` once.
3. `npm run build` (stdio, http, probe). The build wipes `dist/`, so do not run it while a driver is running.
4. `npm run mcpb` (bundle only). It builds `dist/mcpb/increadible-<version>.mcpb` from the committed sources and needs `npm ci` and the
   npm registry. The bundle driver can also do this itself with `--build`.

Every driver takes `--help` and prints one line of usage. Exit code: **0** every check passed, **1** a check failed, **2** the driver could
not run (a missing build, an unknown option, a scenario file with a typo); with 2 it prints a message, never a stack trace.

## 3. Execution steps

The commands are the same in bash and in PowerShell; where they differ the two forms are given. Add `--json` to any of them for a
machine-readable report (the same checks, the full answers).

### 3.1 stdio

```
npm run drive:stdio
npm run drive:stdio -- --scenario basic --json
npm run drive:stdio -- --data-dir ./drive-data --keep     # keep what the server wrote
npm run drive:stdio -- --env GATEWAY_LIVE_APIS=hackernews # give the server a setting (the value is not printed)
```

What happens: a fresh data directory in the system's temporary folder (removed afterwards unless you pass `--keep` or `--data-dir`),
then `node dist/src/main.js` with only `PATH`, the home and temporary-folder variables and the data settings, the handshake, the scenario, stdin closed,
and a check that the server left with exit code 0 and that stdout carried nothing but JSON-RPC.
Expected: `PASS 19/19` and exit code 0 (the 16 steps of the `basic` scenario and three the driver adds).

### 3.2 http, self-contained

```
npm run drive:http
npm run drive:http -- --scenario basic --json
```

What happens: a free port on `127.0.0.1`, a random token (never printed), `node dist/src/index.js`, a wait for `/ready`, the checks of
section 1, the scenario, `GET /metrics`, then `SIGTERM` and a check for exit code 0. Expected: `PASS 22/22`.

### 3.3 http, against a server that is already running (a container, a Railway service, a port-forward)

bash:

```
MY_TOKEN='the-bearer-token' npm run drive:http -- --url https://your-service.example --token-env MY_TOKEN
```

PowerShell:

```
$env:MY_TOKEN = 'the-bearer-token'
npm run drive:http -- --url https://your-service.example --token-env MY_TOKEN
Remove-Item Env:MY_TOKEN
```

The token is read from the variable you name and nowhere else (not from the command line, where other users of the machine could see it).
**The steps that write A/B data are skipped** (the report says `SKIP`) because the A/B log is append-only and never compacted: a test
experiment on a deployment stays there. Pass `--allow-writes` only for a server whose data you do not mind. The gateway steps expect
sample data (`source: "mock"`), so against a server with live APIs switched on they fail on purpose: the scenario is for the mock.

### 3.4 probe

```
npm run drive:probe
npm run drive:probe -- --transport http
npm run drive:probe -- --list
```

Expected: `PASS 26/26 (5 KNOWN: recorded deviations from the MCP spec, behaviour unchanged)`. Section 8 explains the five.

### 3.5 bundle

```
npm run mcpb
npm run drive:bundle
npm run drive:bundle -- --bundle ./dist/mcpb/increadible-1.0.5.mcpb --setting durable_writes=false
npm run drive:bundle -- --setting live_apis=hackernews --setting contact=you@example.org
```

What happens: the zip is read with an independent reader and every checksum is checked (a damaged package stops the run here); it is unpacked
into a folder whose path contains a space (`.../Claude Extensions/increadible`, as on macOS and Windows); the manifest's variables
`${__dirname}`, `${/}` and `${user_config.*}` are resolved with the manifest's own defaults plus your `--setting`s; the server is started
with exactly the manifest's command, arguments and environment; the scenario runs; and afterwards the driver checks that `ab-data.jsonl`
holds this run's experiment in the data folder and that no `.lock` file is left. Expected: `PASS 22/22`.
`--build` makes the package first. The driver uses the Node that runs it (`--node PATH` to choose another); Claude Desktop uses its own, so
the Node version in Claude Desktop is **not** tested here.

## 4. Reading a report

```
  7   routing: a code task gets a provider       PASS  ok                  2 ms
  23  http.get-mcp-is-404                        KNOWN 404                 2 ms
        . The Streamable HTTP rules ask a server that offers no event stream to answer 405 ...
  12  A/B: create an experiment                  SKIP  skipped
  14  gateway: a call answers sample data        FAIL  ok                  1 ms
        - json.source: expected "mock", got "live"
```

| Word | Meaning | Counts as a failure |
|---|---|---|
| `PASS` | the check held | no |
| `FAIL` | the check did not hold; the lines under it say what was expected and what came | **yes** |
| `SKIP` | a write step was left out on purpose (`--url` without `--allow-writes`) | no, but the total says how many |
| `KNOWN` | (probe only) the server differs from what the MCP specification asks, exactly as recorded | no; a *different* behaviour than the recorded one is a `FAIL` |
| `INFO` | (probe only) behaviour recorded without any specification claim | no, same rule |

A server that stopped answering is reported as `no answer to <method> within N ms` with the last lines of the server's own stderr (secrets
replaced by `<hidden>`). stderr is not an error channel in the MCP stdio transport: a server may write logs there, and the driver only shows it when something failed.

## 5. What each scenario step may check

Section 6 is the format. The shipped scenario, `scripts/drive-scenarios/basic.json`, is one pass through the three parts of the server: the
protocol (ping, `tools/list`), routing, A/B testing (create, assign, record, read back) and the gateway (discover, call, aggregate,
statistics), then four error cases: an unknown API and an unknown experiment (a tool error: `isError` with `{"error": ...}` in the text),
an unknown tool (JSON-RPC error `-32602`) and an unknown method (`-32601`). The three channels are different on purpose and each is checked.

## 6. Writing your own scenario

A scenario is a JSON file. Pass its path to `--scenario`, or put it in `scripts/drive-scenarios/` and pass the name.

```json
{
  "name": "my-check",
  "steps": [
    { "name": "provider for code",
      "tool": "apply_routing_rules", "arguments": { "task_type": "code" },
      "expect": { "json": { "provider": { "$type": "string" } } } },
    { "name": "create",  "tool": "create_experiment", "writes": true,
      "arguments": { "id": "mine-${run_id}", "name": "n", "hypothesis": "h", "variants": [ ... ], "metrics": [ ... ] },
      "expect": { "json": { "status": "success" } } },
    { "name": "assign",  "tool": "assign_variant", "writes": true,
      "arguments": { "experiment_id": "mine-${run_id}" },
      "save": { "variant": "variant_id" } },
    { "name": "bad method", "method": "no/such", "expect": { "rpc_error": -32601 } }
  ]
}
```

| Key of a step | Meaning |
|---|---|
| `name` | required, unique in the file |
| `tool` + `arguments` | a `tools/call`; or `method` + `params` for any other request. Exactly one of `tool` and `method` |
| `writes` | `true` when the step changes data that outlives the run; such steps are skipped against a deployment |
| `save` | `{ "name": "dotted.path" }`: keeps a value from the answer for later steps as `${name}` |
| `expect` | what must hold (below). With none, the step must simply succeed: a result, and for a tool no `isError` |

| `expect` key | Holds when |
|---|---|
| `json` | `{ "dotted.path": value-or-matcher }` over the JSON the tool put in its text (paths walk arrays: `0.id`) |
| `result` | the same over the raw `result` (for `method` steps) |
| `contains` | the tool's text contains the string |
| `tool_error: true` | the tool answered `isError: true` (without it, `isError: true` fails the step) |
| `rpc_error`, `message_contains` | the answer is a JSON-RPC error with that code (and text) |
| `tools_include` | `tools/list` names all of them |

Matchers: a plain value (compared as JSON), or an object with `$type` (`string`, `number`, `boolean`, `array`, `object`, `null`), `$gte`, `$lte`,
`$includes`, `$matches` (a regular expression) or `$exists`. `${run_id}` (unique per run) and every saved name are replaced in `arguments`,
`params` and `expect`. A file with a misspelled key (`argumnets`, `tool_eror`), a duplicate step name or an unknown matcher is refused with the step named, because a check that
silently checks nothing is worse than no check.

## 7. Safety

| Question | Answer |
|---|---|
| What does a run leave behind? | Nothing, unless you pass `--keep` or `--data-dir`. Its work directory is created with the prefix `increadible-drive-` and only such a directory is ever removed. |
| Which secrets can it show? | None: the environment the server gets is printed as names, and as values only for `PORT`, `HOST`, `AB_FSYNC`, `AB_LAZY_OPEN`, `GATEWAY_LIVE_APIS`, `ALLOW_UNAUTHENTICATED` and `RATE_LIMIT_PER_MINUTE`. The random token, a token from `--token-env` and any variable whose name contains TOKEN, SECRET, PASSWORD, KEY or CREDENTIAL are replaced by `<hidden>` in every text the driver prints, including the server's stderr and the answers. A test passes a secret in and looks for it in the output. |
| What does the server inherit from your shell? | Only `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, the temporary-folder variables and `LANG`. Your tokens do not reach it. |
| Does it open a port? | Only `http`, on `127.0.0.1` and a free port, for the length of the run. |
| Does it write to a deployment? | Not by default (section 3.3). |
| Does it call a real provider? | No. See the status table. |

## 8. The deviations the probe records

Five checks are marked `KNOWN` and one `INFO`. They are what this server does today where the MCP specification asks for something
else (or says nothing). The specification text below is a summary written on 2026-10-14 from the transport page
(<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>) and from a conformance run against the 1.0.3 build; **read the page itself before relying on a
line of it.** Whether to change any of them is the owner's decision; nothing here changes the server.

| Check | The server | The specification asks | Note |
|---|---|---|---|
| `stdio.unknown-version-is-echoed` | `initialize` answers whatever `protocolVersion` it is given (`1999-01-01`); with none given, `2024-11-05` | a version the server supports | clients that compare the answer to what they asked will accept it |
| `stdio.big-line-is-answered` | a 5,000,000-byte line is answered | (nothing) | HTTP refuses more than 1,000,000 bytes with 413 |
| `http.get-mcp-is-404` | `GET /mcp` answers 404 | an event stream, or `405 Method Not Allowed` | harmless to clients that only POST |
| `http.origin-and-host-are-not-validated` | a foreign `Origin` or `Host` is accepted | the server validates `Origin` (DNS rebinding) | `/mcp` needs the bearer token, which a web page cannot add (analysis, not tested); the open case is a server run without a token on loopback |
| `http.protocol-version-header-is-ignored` | an invalid `MCP-Protocol-Version` header is accepted | `400 Bad Request` | |
| `http.content-type-is-not-checked` (`INFO`) | a JSON body sent as `text/plain` is accepted | (nothing claimed) | |

If someone fixes one, the probe fails on that line (`expected: ...`) on purpose: update the check and this table in the same pull request.

## 9. How these drivers were tested

Every claim above has a test in `tests/drive-lib.test.ts` (the library, against small fake servers: no answer, a crash, stray output, a server that
ignores every polite goodbye) or `tests/drive.test.ts` (the four drivers as processes, against the server compiled from the sources and a package
built by `scripts/mcpb.js`). The tests that matter most break something on purpose and expect the driver to say so: a patched server that
answers 403 instead of 401, 400 instead of 413, a different parse-error code, 405 for `GET /mcp`, a counter stuck at zero, a damaged package, a scenario that claims
to write and does not. The drivers themselves were also mutated one guard at a time (the result is in the pull request that added them). A check that
cannot fail is not a check; the first version of the `basic` scenario could not be repeated against a running server (the second run hit the gateway's cache and
failed `cached: false`), which the `--url` test found and the run id in the call's parameters fixed.

## 10. What is not built yet

| Stage | Content | State |
|---|---|---|
| 2 | scenario drivers that go deeper: the gateway's error channels and limits, the A/B statistics against known data, routing rules | not started |
| 3 | the multi-agent workflow scripts that run the drivers in parallel and judge the reports, with their own documentation | not started. Until then the drivers can be run side by side by hand or in CI: each one picks its own port and work directory and they do not share files, so `npm run drive:stdio & npm run drive:probe & wait` (bash) is safe; two bundle runs at once are too |
| 4 | an opt-in live driver for the gateway, tested against a local stub of a provider | not started. A call to a real provider needs the owner's decision per provider and stays **NOT VERIFIED** until the owner runs it |

## 11. When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `.../dist/src/main.js does not exist: run "npm run build" in ... first` | no build, or the build is of another checkout | `npm run build` |
| `.../increadible-<version>.mcpb does not exist` | no package built | `npm run mcpb`, or `--build`, or `--bundle FILE` |
| `no answer to initialize within 20000 ms` and a stderr tail | the server started and did not answer (a crash, a wrong `--root`) | read the stderr tail under the report; run the server by hand: `node dist/src/main.js` |
| `HTTP 401 without a JSON-RPC body` | the token is wrong or missing for `--url` | check the variable named by `--token-env`; the failing step is `handshake` |
| `/ready did not answer 200 within ...` | nothing listens at the URL, or the server is still starting | wait and retry, or raise `--ready-timeout-ms` |
| `the server did not leave when stdin closed (it needed SIGTERM)` | the server ignored the closed pipe; Claude Desktop would have had to kill it | a regression; `npm run smoke` checks the same shutdown with real processes |
| `a scenario file is refused: unknown key "..."` | a typo in the scenario | the message names the step and the key |
| `gateway: a call answers sample data` fails with `got "live"` | live APIs are switched on for that server | by design: this scenario is for the sample data |
