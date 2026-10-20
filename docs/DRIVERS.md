# Request drivers: real calls to the server, from the command line

Four small programs that start the real server (or reach one that is running), send it real JSON-RPC requests, check the answers
against written expectations, and print a report. They are Stage 1 of the plan for drivers; what is not built yet is in
section 10. Nothing here is a load test (that is `npm run loadtest`, [PERFORMANCE.md](../PERFORMANCE.md)) and nothing here proves
that Claude Desktop accepts the package (that needs the app, [INSTALL-CLAUDE-DESKTOP.md](INSTALL-CLAUDE-DESKTOP.md)).

| | |
|---|---|
| Status | built and tested on Linux with Node 22 (the authoring sandbox); the same tests run in CI on Node 24 |
| Windows | **NOT VERIFIED**: no Windows machine was available. The drivers use no shell and no Unix-only call, but how Windows ends a process differs (SIGTERM on Windows is not graceful), so the shutdown checks and the clean-up on interruption are the first places to look |
| Against a real provider | **NOT AVAILABLE**. The drivers refuse to switch the gateway's live calls on (`--env GATEWAY_LIVE_APIS=...` and `--setting live_apis=...` end with exit code 2), so every gateway call they make answers sample data (`source: "mock"`). With `--url` the target decides: a server that has live APIs on will call its providers when the scenario's gateway steps run, and those steps fail on purpose (section 3.3) |
| Dependencies | none (Node's own modules only) |

## 1. Which driver answers which question

| Driver | `npm run` | It starts | It answers |
|---|---|---|---|
| stdio | `drive:stdio` | `dist/src/main.js`, the file Claude Desktop starts, with its own data directory | does the server do what its tools promise when a client talks to it the way Claude Desktop does, and does it leave cleanly when the client goes away |
| http | `drive:http` | `dist/src/index.js` on a free loopback port with a random bearer token; or nothing: with `--url` it reaches a server that is already running | the same scenario over `POST /mcp`, plus `/ready`, `/health`, the refusal of a request without the token, `/metrics`, and the SIGTERM shutdown |
| probe | `drive:probe` | both servers, one after the other, on loopback | how the server answers what a well-behaved client never sends (malformed JSON, a batch, an oversize body, a foreign Origin) and how it ends; where it differs from the MCP specification |
| bundle | `drive:bundle` | the server **from the `.mcpb` package**, unpacked the way Claude Desktop unpacks it | is the package complete and does it start with the manifest's own command and environment; does the data land in the folder the user chose |

All four use one library (`scripts/drive-lib.js`) and one scenario format (section 6). The stdio and the bundle driver run the
same scenario with the same checks, so a difference between them is a difference in the package or in its settings: the stdio,
http and probe drivers start the server with `AB_FSYNC=false` and `AB_LAZY_OPEN=true` (fast), the bundle driver uses what the
manifest sets (`AB_FSYNC=true` by default, `AB_LAZY_OPEN=true`).

## 2. Before you run any of them

1. Node 22 or later (`node --version`); the repository root as the current directory.
2. `npm ci` once.
3. `npm run build` (stdio, http, probe). The build wipes `dist/`, so do not run it while a driver is running.
4. `npm run mcpb` (bundle only). It builds `dist/mcpb/increadible-<version>.mcpb` from the committed sources and needs `npm ci` and the
   npm registry. The bundle driver can also do this itself with `--build`.

Every driver takes `--help` and prints its usage. Exit code: **0** every check passed, **1** a check failed, **2** the driver could not run (a
missing build, an unknown option, a number that is not a number, a scenario file with a typo): it prints a message, never a stack trace, and
it has started and created nothing yet. A driver you interrupt (Ctrl-C or `kill`) ends the servers it started and removes its work
directory before it leaves, with exit code 130 (SIGINT) or 143 (SIGTERM); `kill -9` cannot be answered, and leaves what it found:
the work directory (`increadible-drive-*` in the temporary folder) and, for the http driver, its server.

## 3. Execution steps

The commands are the same in bash and in PowerShell; where they differ the two forms are given. Add `--json` to any of them for a
machine-readable report (the same checks with the full answers, and the server's stderr). Through npm the banner `> increadible@... drive:...`
is printed first, so for a machine to read it use `npm --silent run drive:stdio -- --json` or `node scripts/drive-stdio.js --json`.

### 3.1 stdio

```
npm run drive:stdio
npm run drive:stdio -- --scenario basic --json
npm run drive:stdio -- --data-dir ./drive-data --keep     # keep what the server wrote
npm run drive:stdio -- --env AB_FSYNC=true                # give the server a setting
```

What happens: a fresh data directory in the system's temporary folder (removed afterwards unless you pass `--keep` or `--data-dir`),
then `node dist/src/main.js` with only `PATH`, the home and temporary-folder variables and the data settings, the handshake, the scenario, stdin closed,
and a check that the server left with exit code 0 and that stdout carried nothing but JSON-RPC. The report lists the server's environment by name; a value
is shown only for `PORT`, `HOST`, `AB_FSYNC`, `AB_LAZY_OPEN`, `GATEWAY_LIVE_APIS`, `ALLOW_UNAUTHENTICATED` and `RATE_LIMIT_PER_MINUTE`, every other variable as `(set)`.
Expected: `PASS 19/19` and exit code 0 (the 16 steps of the `basic` scenario and three the driver adds).

### 3.2 http, self-contained

```
npm run drive:http
npm run drive:http -- --scenario basic --json
```

What happens: a free port on `127.0.0.1`, a random token (never printed), `node dist/src/index.js`, a wait for `/ready`, the checks of
section 1, the scenario, `GET /metrics` (the tool-call counter must have grown during the scenario), then `SIGTERM` and a check for exit code 0.
Expected: `PASS 22/22`. A scenario that calls no tool has no metrics step.

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

`--url` takes the server's address only (scheme, host, port): a path, a query or a user name and password in it is refused (exit code 2), because the
driver uses the server's own `/mcp`, `/ready`, `/health` and `/metrics`. The token is read from the variable you name and nowhere else (not from the command
line, where other users of the machine could see it). Without `--token-env` the auth and metrics steps are left out, and a server that wants a token fails at the handshake.

**The steps that write A/B data are skipped** (the report says `SKIP`) because the A/B log is append-only and never compacted: a test
experiment on a deployment stays there. Pass `--allow-writes` only for a server whose data you do not mind. The steps that remain still touch the
target's memory: its gateway statistics and cache (`get_api_stats`) and its `/metrics` counters rise by what the run called; nothing that outlives the server process is written.
The gateway steps expect sample data (`source: "mock"`), so against a server with live APIs switched on they fail on purpose, after the server
has called its provider: the scenario is for the mock.

### 3.4 probe

```
npm run drive:probe
npm run drive:probe -- --transport http
npm run drive:probe -- --list
```

Expected: `PASS 27/27 (4 KNOWN: recorded deviations from the MCP spec, behaviour unchanged)`. Section 8 explains the four, and the three `INFO` lines.

### 3.5 bundle

```
npm run mcpb
npm run drive:bundle
npm run drive:bundle -- --bundle ./dist/mcpb/increadible-1.0.5.mcpb --setting durable_writes=false
npm run drive:bundle -- --data-dir ./drive-data
```

What happens: the zip is read with an independent reader and every checksum and file name is checked (a damaged package stops the run here); it is unpacked
into a fresh folder of the driver's own whose path contains a space (`.../Claude Extensions/increadible`, as on macOS and Windows), never into the folder you
chose for the data; the manifest's variables `${__dirname}`, `${/}` and `${user_config.*}` are resolved with the manifest's own defaults plus your `--setting`s; the server is started
with exactly the manifest's command, arguments and environment; the scenario runs; and afterwards the driver checks that the data file exists and is not empty
(and, when the scenario names its experiments with `${run_id}`, that it holds this run) in the data folder, and that no `.lock` file is left. Expected: `PASS 22/22`.
`--build` makes the package first. The driver uses the Node that runs it (`--node PATH` to choose another); Claude Desktop uses its own, so
the Node version in Claude Desktop is **not** tested here. **The package's code is run**: open only a package you built or trust. "Well-formed" means checksums and
file names are sound, not that the package is safe, and the zip is read into memory whole.

## 4. Reading a report

```
  7   routing: a code task gets a provider       PASS  ok                  2 ms
  22  http.get-mcp-is-404                        KNOWN 404                 2 ms
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

## 5. What the shipped scenario does

`scripts/drive-scenarios/basic.json` is one pass through the three parts of the server: the
protocol (ping, `tools/list`), routing, A/B testing (create, assign, record, read back) and the gateway (discover, call, aggregate,
statistics), then four error cases: an unknown API and an unknown experiment (a tool error: `isError` with `{"error": ...}` in the text),
an unknown tool (JSON-RPC error `-32602`) and an unknown method (`-32601`). The three channels are different on purpose and each is checked.
The gateway call carries the run id in its parameters, so a second run against the same running server is not answered from the gateway's cache.

## 6. Writing your own scenario

A scenario is a JSON file. Pass its path to `--scenario`, or put it in `scripts/drive-scenarios/` and pass its name without `.json`. A value with a path
separator or ending in `.json` is a file; anything else is the name of a shipped scenario (so a file called `basic` in the current directory does not hide the shipped one).

```json
{
  "name": "my-check",
  "steps": [
    { "name": "provider for code",
      "tool": "apply_routing_rules", "arguments": { "task_type": "code" },
      "expect": { "json": { "provider": { "$type": "string" } } } },
    { "name": "rules exist",
      "tool": "get_rule_stats",
      "expect": { "json": { "rules_count": { "$gte": 1 } } } },
    { "name": "the tools are listed",
      "method": "tools/list",
      "expect": { "tools_include": ["apply_routing_rules", "call_api"] } },
    { "name": "bad method", "method": "no/such", "expect": { "rpc_error": -32601 } }
  ]
}
```

(A step that writes, with `${run_id}` and `save`, is in `basic.json`: the four "A/B" steps.)

| Key of a step | Meaning |
|---|---|
| `name` | required, unique in the file |
| `tool` + `arguments` | a `tools/call`; or `method` + `params` for any other request. Exactly one of `tool` and `method`; `params` on a tool step and `arguments` on a method step are refused |
| `writes` | `true` when the step changes data that outlives the run **or needs data a skipped step made**: a step that uses a variable saved by a `writes` step must itself be marked `writes`, or against `--url` it fails with "unknown variable" |
| `save` | `{ "name": "dotted.path" }`: keeps a value from the answer for later steps as `${name}`. For a tool step the path walks the JSON the tool put in its text; for a method step, the raw `result` |
| `expect` | what must hold (below). With none, the step must simply succeed: a result, and for a tool no `isError` |

| `expect` key | Holds when | Allowed on |
|---|---|---|
| `json` | `{ "dotted.path": value-or-matcher }` over the JSON the tool put in its text (paths walk arrays: `0.id`) | tool steps |
| `contains` | the tool's text contains the string | tool steps |
| `tool_error: true` | the tool answered `isError: true` (without it, `isError: true` fails the step) | tool steps |
| `result` | the same as `json`, over the raw `result` | any step |
| `rpc_error`, `message_contains` | the answer is a JSON-RPC error with that code (and text); nothing else may be expected of that step, and it cannot `save` | any step |
| `tools_include` | `tools/list` names all of them | the method `tools/list` |

Matchers: a plain value (compared as JSON; objects without regard to the order of their keys, arrays in order), or an object with `$type` (`string`, `number`, `boolean`, `array`, `object`, `null`), `$gte`, `$lte`,
`$includes`, `$matches` (a regular expression, which must compile) or `$exists`. `${run_id}` (unique per run) and every saved name are replaced in `arguments`,
`params` and `expect`. A file with a misspelled key (`argumnets`, `tool_eror`), a duplicate step name, an unknown matcher, a wrong type, or an expectation its kind of step can never
evaluate (`json` on a method step, `message_contains` without `rpc_error`) is refused with the step named, before anything is started, because a check that
silently checks nothing is worse than no check.

## 7. Safety

| Question | Answer |
|---|---|
| What does a run leave behind? | Nothing, unless you pass `--keep` or `--data-dir` (the bundle driver's `--data-dir` receives the server's data and nothing else; the package is unpacked into a folder of the driver's own). Its work directory is created with the prefix `increadible-drive-` and only such a directory is ever removed. Interrupted with Ctrl-C or `kill`, it cleans up (section 2); after `kill -9` it cannot. |
| Which secrets can it show? | Those it knows. The values of the server's variables whose name contains TOKEN, SECRET, PASSWORD, KEY or CREDENTIAL, the random token of the http driver and a token from `--token-env` are replaced by `<hidden>` in everything the driver prints that came from a server (the answers, the problems, the server's stderr), when they are four characters or longer; a secret it was never told about, or a shorter one, cannot be hidden. Control characters other than tab and line breaks in such text are replaced by `?`, so a server cannot steer your terminal. The bundle driver shows a setting as `(set)` when the manifest marks it `sensitive`, when its name looks like a secret, and for `contact`. A test passes secrets in and looks for them in the output. |
| What does the server inherit from your shell? | Only `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `SYSTEMROOT`, `TEMP`, `TMP`, `TMPDIR`, `LANG` and `LC_ALL`, plus what you give with `--env`. Your tokens do not reach it. |
| Does it open a port? | The http and the probe driver, on `127.0.0.1` and a free port, for the length of the run. |
| Does it write to a deployment? | Not data, by default (section 3.3); the steps that run still change the target's in-memory statistics and counters. |
| Does it call a real provider? | It never switches live calls on and refuses to. A server you point `--url` at may have them on (section 3.3). |
| Can a server or a package hurt the machine running the driver? | The drivers read at most 8 MiB of an HTTP answer and give each exchange a deadline, but they print what a server sends (scrubbed as above) and `drive:bundle` runs the package's code. Do not point them at a server or a package you do not trust. |

## 8. The deviations the probe records

Four checks are marked `KNOWN` and three `INFO`. They are what this server does today where the MCP specification asks for something
else (or says nothing). The statements are from the specification sources as published for **revision 2025-11-25** (the transports page and the lifecycle page),
read from the specification repository on 2026-10-14 by an independent reviewer because the website itself was not reachable from the sandbox; **read the page itself before relying on a
line of it.** A newer revision, 2026-07-28, is marked latest in the repository's documentation index (NOT VERIFIED on the website); as read, its changelog drops the
initialize handshake and `ping` (stateless servers, `server/discover`), requires an `MCP-Protocol-Version` header on every POST and answers GET and DELETE with 405. This server
speaks the earlier, stateful protocol, and the probe's HTTP client is **not a fully conformant client**: it sends neither `MCP-Protocol-Version` nor `Accept: application/json, text/event-stream`,
both of which revision 2025-11-25 asks of a client. Whether to change anything is the owner's decision; nothing here changes the server.

| Check | The server | The specification (revision 2025-11-25) asks | Note |
|---|---|---|---|
| `stdio.date-shaped-version-is-echoed` (`KNOWN`) | `initialize` answers any `YYYY-MM-DD` it is given (`1999-01-01`); anything else, and nothing, gets `2024-11-05` | version negotiation (lifecycle page): the same version if it supports it, otherwise another version it supports | the server declares no set of supported versions, so it never negotiates |
| `http.get-mcp-is-404` (`KNOWN`) | `GET /mcp` answers 404 | an event stream, or `405 Method Not Allowed` | a client built on the reference TypeScript SDK (1.20.2; its source was read by a reviewer, **not run against this server**) opens this GET after initializing and reports any status other than 405 as an error |
| `http.origin-is-not-validated` (`KNOWN`) | a foreign `Origin` is accepted | the server validates `Origin` (DNS rebinding) and answers 403 for an invalid one | `/mcp` needs the bearer token, which a web page cannot add; a reviewer showed that a server started without one (`ALLOW_UNAUTHENTICATED` on loopback) answers a POST sent with `Origin` and `Host` of another site, and with `Content-Type: text/plain`, which a web page may send without a preflight request |
| `http.protocol-version-header-is-ignored` (`KNOWN`) | an invalid `MCP-Protocol-Version` header is accepted | `400 Bad Request` | |
| `stdio.big-line-is-answered` (`INFO`) | a 5,000,000-byte line is answered | (nothing) | HTTP refuses more than 1,000,000 bytes with 413 |
| `http.host-is-not-validated` (`INFO`) | a foreign `Host` is accepted | (nothing: the specification names `Origin` only) | a DNS-rebinding defence usually checks it too |
| `http.content-type-is-not-checked` (`INFO`) | a JSON body sent as `text/plain` is accepted | (nothing claimed) | see the `Origin` row |

If someone fixes one, the probe fails on that line (`expected: ...`) on purpose: update the check and this table in the same pull request.

## 9. How these drivers were tested

Every claim above has a test in `tests/drive-lib.test.ts` (the library, against small fake servers: no answer, a crash, stray output, a server that
ignores every polite goodbye, an answer cut off or too large) or `tests/drive.test.ts` (the four drivers as processes, against the server compiled from the sources, a package
built by `scripts/mcpb.js`, and stand-in servers that misbehave: one that echoes the bearer token, one that is slow so the driver can be interrupted mid-run). The tests that matter most break something on purpose and expect the driver to say so: a patched server that
answers 403 instead of 401, 400 instead of 413, a different parse-error code, 405 for `GET /mcp`, a counter stuck at zero, an exit code of 5 on SIGTERM; a damaged package; a scenario that claims
to write and does not.

The drivers themselves were also broken one guard at a time, and each breakage had to make a test fail (`tests/drive-lib.test.ts` and `tests/drive.test.ts`):

| Round | Date | Breakages | Caught at once | What the survivors were |
|---|---|---|---|---|
| 1 (first version of the drivers) | 2026-10-14 | 68 | 59 | 9 checks no test could make fail: the `$exists` matcher, the `result` expectation, a JSON answer that is not JSON-RPC, "how did the server end", the handshake's server name, the HTTP shutdown's exit code, the redaction of the random token, the bundle's lock-file check and data check. One test each was written; the first five were re-run and are caught, the other four are in round 2 |
| 2 (the code the independent review made necessary) | 2026-10-20 | 56 | RUN UNDER WAY: the numbers are filled in when it ends, before this change merges | |

Besides, an independent review by separate agents (a tester, a security reviewer and a documentation follower; a code reviewer was cut off by the usage limit and has not reviewed) found 46 issues in the first version; four skeptic agents each
reproduced the finding they were given. They are fixed, each with a test, and this document was corrected from them. Two things found by the tests themselves are worth saying: the first `basic` scenario could not be repeated against a running server (the second run hit the gateway's cache and
failed `cached: false`), and the HTTP client returned an oversize answer as a result when the whole of it had already arrived.

## 10. What is not built yet

| Stage | Content | State |
|---|---|---|
| 2 | scenario drivers that go deeper: the gateway's error channels and limits, the A/B statistics against known data, routing rules | not started |
| 3 | the multi-agent workflow scripts that run the drivers in parallel and judge the reports, with their own documentation | not started. Until then the drivers can be run side by side by hand or in CI: each one picks its own port and work directory and they do not share files (twelve at once, three of each kind, and sixteen http runs at once, all passed in the review), so `npm run drive:stdio & npm run drive:probe & wait` (bash) is safe; two bundle runs at once are too |
| 4 | an opt-in live driver for the gateway, tested against a local stub of a provider | not started. A call to a real provider needs the owner's decision per provider and stays **NOT VERIFIED** until the owner runs it |

## 11. When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `.../dist/src/main.js does not exist: run "npm run build" in ... first` | no build, or the build is of another checkout | `npm run build` |
| `.../increadible-<version>.mcpb does not exist` | no package built | `npm run mcpb`, or `--build`, or `--bundle FILE` |
| `no answer to initialize within 20000 ms` and a stderr tail | the server started and did not answer (a crash, a wrong `--root`) | read the stderr tail under the report; run the server by hand: `node dist/src/main.js` |
| `HTTP 401 without a JSON-RPC body` | the token is wrong or missing for `--url` | check the variable named by `--token-env`; the failing step is `handshake` |
| `/ready did not answer 200 within ...` | nothing listens at the URL, or the server is still starting | wait and retry, or raise `--ready-timeout-ms` |
| `--timeout-ms must be a whole number from 1 to 2147483647` | a number that is not a whole number of milliseconds | give one |
| `GATEWAY_LIVE_APIS switches on calls to real providers, which these drivers do not make` | `--env GATEWAY_LIVE_APIS=...` or `--setting live_apis=...` | leave it out (section 10, stage 4) |
| `the server did not leave when stdin closed (it needed SIGTERM)` | the server ignored the closed pipe; Claude Desktop would have had to kill it | a regression; `npm run smoke` checks the same shutdown with real processes |
| a scenario file is refused: `unknown key "..."` or `"json" applies to a tool step` | a typo, or an expectation that step can never evaluate | the message names the file, the step and the key |
| `gateway: a call answers sample data` fails with `got "live"` | live APIs are switched on for that server | by design: this scenario is for the sample data |
