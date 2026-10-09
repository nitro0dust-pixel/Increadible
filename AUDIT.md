# Audit of the Increadible repository: findings, fixes and observations

**Period:** from 2026-10-07 about 21:00 UTC (8 Oct 02:30 IST) to the merge of pull request #30 on 2026-10-09. **Tree at the start:** work branch `claude/nice-keller-aoooos` at `c73622f`, content identical to `main` `322238c`. **Tree at the end:** `main` after pull request #30 (this report). **Method:** every finding was reproduced before it was fixed, every fix got a test, and every new guard was broken on purpose to confirm it fails (the "negative control"). Where something could not be checked it says `NOT VERIFIED`, `NOT AVAILABLE` or `BLOCKED`; no number here is a projection.

This is the report the owner asked for: each gap with the fix made, and the observations from the first step to the last. `ROADMAP.md` holds the status and the open decisions; `CHANGELOG.md` the behaviour changes; the pull requests hold the evidence.

## 1. Summary

| Area | Findings | Fixed in | Highest severity |
|---|---|---|---|
| API gateway (`features/09`) | GW-1, GW-3, GW-4 | PR #23 | High (memory and fan-out a caller could force) |
| A/B testing (`features/08`) | AB-2 to AB-9 | PR #24, PR #27 | High (one value could spoil an experiment for good) |
| Routing (`features/07`) | RT-1 to RT-5 | PR #25 | Medium (state changed before a failed write) |
| Protocol and transport (`src`) | P-1 to P-6 (P-7 accepted) | PR #25 | Low |
| Scripts, alerts, CI | D-1 to D-4 fixed; D-5, D-6 recorded; D-7 | PR #26 | Medium (an alert that could not fire; a check that passed a partial run) |
| Tests | C-1 to C-5 | PR #27, PR #30 | Medium (two documented behaviours never tested; 421 code changes that no test noticed) |
| Documents | E-1 to E-4 | PR #26, PR #27 | Low |
| Tool interface | I-1 | PR #30 | Low (a schema that said less than the handler accepts) |
| Repository hygiene | F-02 license, F-03 toolchain (42 advisories), F-07, F-08 | PR #27, PR #28 | Medium |
| Security scans | S-scan, S-regex | (no defect) | none found |

**What changed for an operator:** the behaviour changes are flagged in `CHANGELOG.md` (aggregate calls return partial results; new A/B writes are validated; the server accepts only JSON-RPC 2.0 and answers no notification; an invalid rules file falls back to the built-in rules), a NaN `traffic_split` or an empty experiments file is handled, and one alert fires in one more situation. Nothing was deployed, and nothing is deployed beyond a local rehearsal.

## 2. Chronology: every step, in order

| # | When (UTC, 7-8 Oct) | Step | Outcome |
|---|---|---|---|
| S0.1 | 21:0x | Baseline of `c73622f`: `npm ci`, type-check, lint, tests, audits | 337 tests passed, 6 todo; production audit 0; full audit 42 (all development tools) |
| S0.2 | 21:1x | A clean-room run on Node 22 reported 189 of 195 tests | **Not a repository defect.** My own older script had archived a stale scratch worktree (4 of 7 suites). Re-run with the right script: 337 passed on Node 22.22.0 and 24.21.0. Lesson: a check must say which tree it tested and must fail on a partial run (now `scripts/verify.sh` and `scripts/cleanroom.sh`, D-3 and D-4) |
| S0.3 | | Read all configuration | Items already recorded in `ROADMAP.md` (actions pinned by tag, scanner choice, runner starvation, default branch) are not new findings |
| S0.4 | | Four independent reviewer agents (security, correctness, QA, docs) | All failed on an account session limit; **no findings from them.** The audit continued by hand |
| S0.5 | | Black-box probes of the built server (Node 22) | F-07 below became P-1 to P-6 |
| S1 | | Gateway probes: 2 000 distinct calls with 200 KB params; a 5 000-item aggregate | GW-1, GW-3, GW-4 reproduced; fixed and merged as PR #23 |
| S2 | | A/B probes and an independent exact t distribution | AB-2 to AB-7 reproduced; the p-value approximation was found conservative (left alone); PR #24 |
| S3 | | Routing and protocol probes, a failing-write simulation | RT-1 to RT-5, P-1 to P-6; PR #25 |
| S4 | | Scripts, Dockerfile, manifests, monitoring, CI workflow | D-1 to D-7; PR #26 |
| S5 | | Coverage report, repeated and randomised runs, docs-versus-code checks, secret and ReDoS scans | C-1 to C-5, E-1 to E-4, AB-8, AB-9, S-scan, S-regex; PR #27 |
| S6 | | Gateway research (three tracks) and verification of the decisive claims | `GATEWAY.md` (proposed, not built); PR #27 |
| S7 | | Development toolchain | F-03; PR #28 |
| S8 | 8-9 Oct | Whole-code-base mutation testing (StrykerJS in a scratch copy: two full runs of about an hour each), new tests for what it showed, and every mutant that still survived applied by hand | Section 6; PR #30 |
| S9 | 9 Oct | This report; roadmap and changelog; CI on the final head; merge | PR #30. CI run 37865895943 (head `37a2e96`): all jobs passed; the logs of Tests (20 suites, 718 passed, 6 todo; coverage 97.22% / 95.24% / 95.1% / 97.95%), the Docker probe (`probe: OK`) and promtool (`prometheus: OK`) were read |

### The ways to pinpoint the 189-versus-337 discrepancy

| # | Technique | Evidence from this case |
|---|---|---|
| 1 | Print which commit and tree was tested | The failing run's directory was named `clean-*` and held an old scratch worktree (`fe3e025`), not `HEAD`: the decisive finding |
| 2 | Compare suites run with test files present | 4 of 7 suites ran in the failing run |
| 3 | Re-run the original script verbatim | Part of the investigation; no separate result was recorded |
| 4 | Look for leftover processes and stale directories | Same |
| 5 | Bisect the difference between the two scripts | Same; the difference was the tree each one archived |
| 6 | Run an instrumented copy that logs the command before anything vanishes | Same |
| 7 | Run the correct script on `HEAD` | 337 passed |
| 8 | Repeat on a second runtime (Node 22 and 24) | 337 on both: the environment was ruled out |
| 9 | Compare with CI's log of the same commit | Tests job of the pull request head: 337 passed |
| 10 | Make the check itself print its tree and fail on a partial run | `scripts/verify.sh` and `scripts/cleanroom.sh` (D-3, D-4) |

## 3. Findings, fixes and evidence

Severity is my judgement of the impact on a deployment of this server. "Caught" means the deliberate breakage made a test fail.

### API gateway (PR #23)

| ID | Sev. | Finding (reproduced) | Fix | Evidence |
|---|---|---|---|---|
| GW-1 | High | The result cache never shrank: 2 000 distinct calls with 200 KB params held 385 MB of heap, against a 256Mi pod limit | At most 500 entries and about 16 MiB (expired, then oldest dropped), a result over 4 MiB not kept, long keys stored as a SHA-256 | Heap flat at 5 MB over the same 2 000 calls; 21 breakages caught, 1 redundant check removed |
| GW-3 | High | One `aggregate_apis` request started every call at once: 5 000 requested, 5 000 started (in live mode, 5 000 simultaneous calls to a provider with the gateway's own key) | At most 100 calls per request, five at a time, and 10 live calls at once across the gateway with 100 allowed to wait | A 5 000-item aggregate is refused before any call; a 100-item one peaks at 5; 60 parallel calls peak at 10 |
| GW-4 | Med | One bad call discarded every good result; a wrong type surfaced as `apis.map is not a function` | A failed call holds its own `{error}`; types are checked. **Behaviour change** | 17 new tests |

### A/B testing (PRs #24 and #27)

| ID | Sev. | Finding | Fix | Evidence |
|---|---|---|---|---|
| AB-2 | Med | Duplicate or missing variant ids and an empty experiment id accepted; `assign_variant` then returned no variant | New writes need non-empty, unique ids (at most 200 characters, never `__proto__`) | Tests; stored data and YAML still load |
| AB-3 | **High** | One finite `1.7e308` made the mean 2.8e306 and the deviation, interval, p-value and confidence `null` for good; the log is append-only | Values limited to -1e15..1e15 | 21 breakages caught |
| AB-4 | Low | An unknown experiment answered the text `null` | An error from every tool | |
| AB-5 | Low | `metrics: null` or an array, and an object `user_id`, accepted | Checked | |
| AB-6 | Low | A variant `__proto__` vanished from the results | Refused (no global pollution: checked) | |
| AB-7 | Low | The 95% interval for few values was too narrow (df 1: 4.33 against the exact 12.71) | Exact Student-t table up to 30 values, 29 entries each checked against an independent incomplete-beta implementation | The only change to the numbers: 58 `ci_95` figures in 13 of the 120 golden datasets, worst disagreement 0.000155. The p-value approximation was checked against the exact distribution and is **conservative below 25 degrees of freedom** (never a false winner), so it was left alone |
| AB-8 | Low | An empty `experiments.yaml` logged a `TypeError` | Loads as no experiments | PR #27 |
| AB-9 | Low | `traffic_split: .nan` in the YAML passed validation and sent every user to the second variant | `Number.isFinite` | PR #27; the NaN test failed before the fix |

### Routing and protocol (PR #25)

| ID | Sev. | Finding | Fix |
|---|---|---|---|
| RT-1 | Low | A rule id such as `constructor` or `toString` turned its hit count into the text of Object's function and the share into `NaN%` | Counts kept in a `Map` |
| RT-2 | Med | `update_rules` replaced the live rules before writing the file: a failed write (the read-only ConfigMap in the manifests) reported an error while routing had changed, and the change was lost at restart | Validate, write first, then switch |
| RT-3 | Low | `update_rules` accepted a NaN priority, a list as `match`, a string as `fallback`, duplicate ids | One shared validator (also at start-up) |
| RT-4 | Med | A rules file that parsed but held a malformed rule made every routing call fail; `enabled: "no"` counted as enabled | The file falls back to the built-in rules with a message |
| RT-5 | Low | The rules file was rewritten in place (a crash could leave it truncated) | Temporary file renamed over the target |
| P-1..P-6 | Low | `jsonrpc: "1.0"` accepted; object-valued ids echoed; `initialize` echoed any protocol version; a notification got a reply; `HEAD /health`, `/health?x=1` and a lower-case `bearer` got 401 when a token was set (a load balancer's probe could mark the pod unhealthy); `/mcp?x=1` was a 404 | Strict JSON-RPC 2.0; query strings ignored; scheme name case-insensitive. **Behaviour change** |
| P-7 | Accepted | An A/B persistence error can name the data-file path | Authenticated callers only; the path is the operator's own |

Evidence: 64 new tests (27 of 35 routing tests and 13 plus 5 protocol tests fail against the old files); 29 deliberate breakages caught, one redundant check removed.

### Scripts, alerts and CI (PR #26)

| ID | Sev. | Finding | Fix |
|---|---|---|---|
| D-1 | Med | `IncreadibleDown` was `up == 0`, which cannot fire for a target that is gone (Deployment deleted, ServiceMonitor not matching): there is no series, although its summary says "not being scraped" | Also fires on `absent(up{...})`; two promtool cases fail against the old rule |
| D-2 | Low | CI cancelled running workflows on `main` too: two quick merges would cancel the first merge's image push and verification | `cancel-in-progress` is false on `main`. The expression was accepted by GitHub; that a second push is not cancelled has **not been observed** |
| D-3 | Med | `scripts/verify.sh` used one fixed `/tmp` log, said nothing of the tree it tested, **passed a partial test run**, and was silent about the alert-rule check | Names the commit and tree, unique log, fails when fewer suites ran than test files, runs promtool when present or says `NOT AVAILABLE` |
| D-4 | Med | No tracked way to test exactly what is committed | `scripts/cleanroom.sh [commit]` (`git archive`, `npm ci`, verify) |
| D-5 | Info | The secret scanner's action is pinned (`trufflehog@v3.97.9`), the scanner is not: `VERSION: latest` ran 3.99.0 | **Recorded, owner decision** |
| D-6 | Info | The `docker` job does not wait for the `prometheus` job | **Accepted**: the image holds no alert rules |
| D-7 | Low | `ROADMAP.md` said 334 tests, 93.1% / 85.3% coverage and 13 alert cases | Corrected from the CI log |

Evidence: 15 tests that run both scripts against stubs and a throwaway git repository; 20 deliberate breakages caught, one shown equivalent (`pipefail` on a tar pipe: `tar` also fails on an empty archive); my first control left `set -e` untested, which an added test now covers.

### Tests, documents, hygiene (PRs #27 and #28)

| ID | Sev. | Finding | Fix / evidence |
|---|---|---|---|
| C-1 | | Flakiness | None: 3 runs as is, 3 in band, 3 with 8 busy loops on 4 cores, and `--randomize` with two seeds, all passed |
| C-1b | | Flakiness of the 222 tests added later, which include tests that start real processes and use timers | None: on the final tree, 2 runs as is, 1 in band, `--randomize` with two seeds, and 1 with 8 busy loops on 4 cores: 718 passed every time. Clean rooms on commit `9709aba`, Node 22.22.0 and 24.21.0: type-check, lint, tests, build, smoke and promtool PASS |
| C-2 | Med | The coverage report listed behaviour no test had run, including two whole documented behaviours: the route taken when no routing rule matches, and the entire `suggest_rules` tool | 35 tests; 24 breakages caught |
| C-3 | Low | One vacuous assertion (`not.toBe(undefined)`) | Strengthened. A scan of 345 tests found none without an assertion |
| C-4 | Low | My first `suggest_rules` tests depended on running in order | Fresh module per test; passes under `--randomize` |
| C-5 | Med | Whole-code-base mutation testing: of 1 973 small changes to the code that the tool could test, 421 were noticed by no test | Six new test files, 222 tests; section 6 |
| I-1 | Low | `assign_variant` accepts a number as `user_id` (the handler and `INTEGRATION_GUIDE.md` say so) but its advertised schema said string only, so a client that validates arguments against the schema would have refused a numeric id. Found by the new `tools/list` contract test | Schema allows both (a widening). **Behaviour change of the interface, not of the server** |
| E-1 | Low | README said five vendored projects; there are six (F-01) | Fixed; a test ties the count to `.gitmodules` |
| E-2 | Low | README: `create_experiment` defines "a 2-variant experiment" (two to ten) | Fixed |
| E-3 | Low | `DEPLOYMENT.md`: no latency metric (tool-call and event-loop latency are exported) | Fixed |
| E-4 | Low | Stale figures in `ROADMAP.md` | Fixed (D-7) |
| F-02 | Med | `package.json` says MIT; there was no `LICENSE` | Added, `Increadible Team`, 2026. **The holder and the license are for the owner to confirm** |
| F-03 | Med | 42 advisories (37 high) in development tools; ESLint 8 end of life | Jest 30, ESLint 10 (flat config), typescript-eslint 8: 20 advisories, none high. The 20 left are one development-only chain whose last link, `sprintf-js`, has **no patched version** |
| F-07 | Low | The image did not carry the license text | `COPY LICENSE`; guard test |
| F-08 | Info | `.gitignore` ignores every `*.js`, so an `eslint.config.js` would never be committed | The config is `eslint.config.mjs` |
| S-scan | | Secrets in tracked files and history | None found (own scan; CI also runs trufflehog, verified secrets only) |
| S-regex | | Regular expressions with nested quantifiers, `new RegExp` on user input | None found by that heuristic |

## 4. What held up

| Area | What was checked | Result |
|---|---|---|
| A/B statistics | Sticky assignment; Welford running aggregates; Holm correction; the winner rule at low degrees of freedom; prototype pollution of `Object.prototype` | Correct or conservative; the 120-dataset golden master is byte-identical except the 58 deliberate `ci_95` figures |
| Gateway live layer | Other hosts and paths, redirects, non-JSON, size and time caps, credential never in a result, error or cache key | Held against a real local server and 60 000 random hostile endpoints (never run against a real provider) |
| Token check | Constant-time compare, refusal to start open beyond loopback | Correct |
| Infrastructure | `smoke.sh`, `probe-image.sh`, `check-prometheus.sh`, `install-promtool.sh`, both Kubernetes manifests (they differ only in namespace, pull policy and header), the `Dockerfile` | No defect |
| Alert rules | Every metric named in a rule is emitted by the server | Yes (two metrics are emitted and used by no rule) |
| Documents | Links, repository paths, environment variables, `npm run` names, 13 tools in code against 13 in the README, the nine egress hosts, the constants quoted in the guides, the "within 0.2%" claim for the t formula | All true (worst error 0.158% against 12 standard table values) |

## 5. Not verified, and blocked on the owner

| Item | State |
|---|---|
| Any real cluster; the production and monitoring manifests; the GHCR pull path | `NOT AVAILABLE` here; only staging was applied, once, to a local cluster |
| Live gateway calls against real providers | `NOT VERIFIED`: tested only against a local server |
| `PERFORMANCE.md` measurements | Not re-measured in this audit (they need an idle machine) |
| The new alert expression against a live Prometheus | promtool unit tests only |
| `cancel-in-progress` on two real pushes to `main` | Not observed |
| Windows | Not verified |
| Mutation testing as a standing check | Not added to CI or to the dependencies (a run takes about an hour and needs a tool this repository does not otherwise use); the procedure is in section 6 so it can be repeated |
| Image vulnerability scanner; Actions SHA pinning; base-image digest | Need the owner's approval to look up and pin |
| Secret scanner version (D-5) | Owner decision |
| Default branch `main`; rate limit; latency alert threshold; release tag; GHCR visibility; cluster target | Owner decisions listed in `ROADMAP.md` |
| License and its holder (F-02); a security contact | Owner decisions |
| The gateway direction in `GATEWAY.md` (build the core, no giant, with a gated catalog) | Waiting for the owner |

## 6. Mutation testing of the whole code base

## 6. Mutation testing of the whole code base

**What it is.** A mutation tool changes the code in small ways (a `>` becomes `>=`, a condition becomes `true`, a call is deleted) and runs the tests. A change that no test notices marks a place where a real bug of the same shape would also go unnoticed. It answers a question coverage cannot: not "did a test run this line" but "would a test fail if this line were wrong".

**How it was run.** StrykerJS 10.0.0 (`core`, `jest-runner`, `typescript-checker`), installed in a scratch copy of the repository only: **nothing was added to this repository's dependencies**, in line with the rule that a new tool needs the owner's approval. Six files were mutated (`src/server.ts`, `src/index.ts`, `features/07-routing-plugins/src/mcp-server.ts`, `features/08-ab-testing/src/mcp-server.ts`, `features/09-api-gateway/src/mcp-server.ts`, `features/09-api-gateway/src/live.ts`), all mutators except string literals, the TypeScript checker (changes that do not compile are not counted), `coverageAnalysis: "perTest"`. `tests/config.test.ts` and `tests/scripts.test.ts` were left out of the run because they read source text and run shell scripts, which the tool's instrumentation changes. A full run takes about an hour (run 2: 56 min 8 s, 3 132 changes instrumented, 1 972 that compile and are not string literals).

| File | Run 1 (before any new test) | Run 2 (after the first batch of tests) | Not caught, run 1 → run 2 |
|---|---|---|---|
| `features/07-routing-plugins/src/mcp-server.ts` | 80.0% | 90.3% | 39 → 19 |
| `features/08-ab-testing/src/mcp-server.ts` | 82.1% | 90.2% | 170 → 93 |
| `features/09-api-gateway/src/live.ts` | 81.1% | 95.1% | 31 → 8 |
| `features/09-api-gateway/src/mcp-server.ts` | 74.2% | 93.4% | 90 → 23 |
| `src/index.ts` (the process entry is not run by Jest) | 56.4% | 72.4% | 68 → 43 |
| `src/server.ts` | 85.7% | 93.1% | 23 → 11 |
| **All six** | **78.7%** (1 552 of 1 973 caught) | **90.0%** (1 775 of 1 972 caught) | **421 → 197** |

Run 1 was on the tree of `d26243f`, run 2 on the same sources with the first batch of new tests (five test files). The score is the share of changes caught; "not caught" counts both changes that survived and changes in code no test ran.

**What was written.** Six new test files, 222 tests, none of them testing a mock: `tests/gateway-boundaries.test.ts` (48), `tests/routing-boundaries.test.ts` (30), `tests/ab-boundaries.test.ts` (80), `tests/server-boundaries.test.ts` (35), `tests/tool-contract.test.ts` (16) and `tests/entry-point.test.ts` (13, which compiles the project and starts the real server as a process). They pin: every limit at the limit and one past it, the exact text of error messages, the A/B lock at the ages where it is judged, its exit hook, what a replay does with each kind of line and with any read size, the draw at the exact split, multi-variant and guardrail decisions that no test had run (including a p-value of exactly 0.05, which must not count as significant), the options built from the environment, the input schema of all 13 tools, and the behaviour of the process entry point (a whitespace-only `AUTH_TOKEN`, the warning for an unauthenticated server beyond loopback, the listening address, the settings handed to the HTTP server, SIGINT and SIGTERM in both modes). Writing them found **no defect in the server**; every failure while writing was a wrong expectation of mine. The contract test found one mismatch in the interface (I-1).

**What happened to the 197 that run 2 did not catch.** Run 2 was not repeated after the last tests (a third full run is another hour). Instead each of the 197 was applied to the source by hand and the full suite run against it, so that nothing rests on my reading alone:

| Outcome | Count | Meaning |
|---|---|---|
| Caught by the final tests | **123** | 61 are in code that runs when a module loads (tool schemas, constants), which Stryker's jest runner reports as surviving whatever the tests do (it also reported 17 of them as survivors with the coverage analysis off); 24 are ordinary changes caught by the tests written after run 2; 38 are in the process entry point (23 caught by `scripts/smoke.sh`, 15 only by `tests/entry-point.test.ts`) |
| Not caught: same result by another route | 36 | For example `Holm` ties (`a - b` against `a + b`: equal p-values give equal adjusted values), a loop that runs one step more and does nothing, `{ force: true }` on removing a file that exists, a chunk size that changes how the file is read but not what is read |
| Not caught: a check made redundant by the next one | 17 | For example `typeof x === "number" && Number.isFinite(x)`: `Number.isFinite` is already false for anything that is not a number. These could be simplified; they were left alone, as they are harmless and written for readers |
| Not caught: cannot be reached | 11 | The negative branch of `erfc` (its argument is never negative here), a Student-t statistic of infinity (needs a variance below the smallest double), and the last check in `buildRequestUrl` that the 60 000-endpoint property test shows is never needed (kept as defence in depth) |
| Not caught: a failure there is caught anyway | 5 | An optional chain on a value that cannot be missing (`error?.message` of a thrown `Error`), where the failure would be swallowed by the `try` around it |
| Not caught: Node makes the line redundant | 5 | `server.closeIdleConnections()` (Node 19 and later close idle connections in `server.close()`; `engines` is `>=22`), `require.main === module` changed to `true` (no difference when the file is the entry), `host.trim()` (a host with spaces cannot be bound), the exit after stdio ends (the process ends with code 0 anyway), and `headersTimeout >= requestTimeout` (assigns an equal value) |
| **Total** | **197** | |

If all 123 count as caught, 1 898 of 1 972 changes are caught, **96.3%**. That figure is arithmetic on the hand results above, **not a Stryker measurement**. The 74 left are, by my reading, equivalent or unreachable; "equivalent" is a judgement per change, and a reader who disagrees with one of them has found a test to write.

**Limits.** A mutation score is not a proof of correctness: it measures how well the tests notice small changes to the code, not whether the specification is right. Equivalence is judged by reading. The `src/index.ts` score stays at 72.4% in Stryker's own figure because the process entry runs in a separate process that its coverage tracking cannot see; the hand results for it are in the table. Mutation testing was **not** added to CI or to the dependencies: a run is about an hour and needs a tool this repository does not otherwise use. It is a decision for the owner whether to run it again at releases.

**To repeat it.** In a scratch copy of the repository (not in the repository), after `npm ci`:

```
npm install --no-save @stryker-mutator/core@10 @stryker-mutator/jest-runner@10 @stryker-mutator/typescript-checker@10
npx stryker run          # with the stryker.config.json below; about one hour
```

```json
{
  "testRunner": "jest",
  "jest": { "configFile": "jest.config.js", "config": { "testPathIgnorePatterns": ["/node_modules/", "/tests/config\\.test\\.ts$", "/tests/scripts\\.test\\.ts$"] } },
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "mutate": ["src/server.ts", "src/index.ts", "features/07-routing-plugins/src/mcp-server.ts", "features/08-ab-testing/src/mcp-server.ts", "features/09-api-gateway/src/mcp-server.ts", "features/09-api-gateway/src/live.ts"],
  "mutator": { "excludedMutations": ["StringLiteral"] },
  "coverageAnalysis": "perTest",
  "concurrency": 3,
  "timeoutMS": 60000,
  "timeoutFactor": 3,
  "reporters": ["clear-text", "json"]
}
```

The submodule directories `features/01-06` need only exist (empty), as they are not part of the code under test.

## 7. Observations

1. **The most valuable checks were the ones that look at what was tested.** The 189-versus-337 scare, the verify script that passed a partial run and the alert that could not fire for a vanished target are one failure: a check that reports success without establishing what it covered.
2. **Controls can be wrong too.** Several of my own breakages did not compile, one survived because other code made the same script fail anyway, and some turned out equivalent. Each was redone, covered or removed rather than counted.
3. **Writing the missing tests found defects.** Two real bugs (`.nan` and the empty experiments file) came from covering lines no test had run.
4. **Several claims in the research could not be settled from here** (catalog sizes, advisory details of products I did not run, the scale of a vendor incident). They are labelled, not rounded up.
5. **A tool has blind spots too.** Stryker's jest runner could not switch the 67 mutants in code that runs when a module loads (tool schemas, constants) and reported them as survivors although the suite fails when the same change is applied by hand. They were not counted as fixed or as missed: each was applied by hand and the result is in section 6.
6. **A contract test is cheap and found a real mismatch** (I-1) in the first hour. Interfaces that clients build from (`tools/list`) deserve to be pinned the way code is.
7. **Nothing was built because it is popular.** The gateway recommendation is to build the core and buy nothing; the evidence is in `GATEWAY.md`, and the decision is the owner's.

## 8. Decisions the owner is asked for

- [ ] Confirm the license and the copyright holder (`LICENSE`).
- [ ] Approve or change the gateway direction and the gated catalog (`GATEWAY.md`).
- [ ] Choose the secret scanner version policy (D-5): pin by digest, or follow `latest`.
- [ ] Enable private vulnerability reporting, or give a contact, so a `SECURITY.md` can be written.
- [ ] The decisions already listed under "Open decisions" in `ROADMAP.md`.
