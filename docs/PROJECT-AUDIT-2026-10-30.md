# Project audit, 2026-10-30: what was built, how, by whom and why; what is left

This is the second audit report of the repository and the first that covers the whole project from its first commit to the present. [AUDIT.md](../AUDIT.md) is the account of the code audit of 7 to 9 October (findings GW, AB, RT, P, D, C, E, F, I); this document does not repeat it. It re-checks the build as it stands now, tells the history as a whole, and lists every gap and error that is still open with the fix recommended for each.

| | |
|---|---|
| Audited tree | `main` at `554ee19` (2026-10-29). The work branch was merged with it (merge commit `09954b2`); the content is identical (`git diff origin/main HEAD` is empty) |
| Date of the audit | 2026-10-30 (UTC) |
| Method | everything below marked **[V]** was run or read in this audit, on this tree, and the command is named; **[R]** is taken from the project's own records and was not re-run; **[N]** is NOT VERIFIED. Nothing is called working without a run behind it |
| Authoring environment | Linux sandbox, Node 22.22.0 (Node 24.21.0 for the second clean room), no Docker daemon, no cluster, no Windows, no route to the gateway's providers or to the Railway domain |
| Verdict | The server and its tooling are in a **working, reproducible state**: every automated check that can run here passes, on Node 22 and Node 24, from a clean checkout. The remaining risk is mostly **not in the code that exists but in what has not been proven**: the savings the project was started for have never been measured, six of the nine original features are not integrated or tested, nothing has run on a real cluster, and the two multi-agent workflows have never run with real agents. The code itself has two hardening gaps worth closing (section 7, PA-04 and PA-05) and one intermittent test (PA-01) |

## 1. Summary

| Area | State | Evidence |
|---|---|---|
| Build, type-check, lint | PASS | [V] `npm run verify` |
| Tests | PASS: 1371 passed, 6 todo, 38 suites; one intermittent failure seen once under heavy load (PA-01) | [V] `npm run verify`, both clean rooms, a coverage run |
| Node 22 and Node 24 from a clean checkout | PASS on both | [V] `bash scripts/cleanroom.sh 554ee19` twice |
| Coverage of the server code | 96.73% statements, 94.85% branches, 94.75% functions, 97.94% lines; no threshold enforced | [V] `npm test -- --coverage` |
| Production dependency vulnerabilities | 0 (one production dependency: `yaml`) | [V] `npm audit --omit=dev` |
| Development dependency vulnerabilities | 6 low, all in the test toolchain; SECURITY.md still describes the state of 2026-10-09 (20 moderate, another chain) (PA-03) | [V] `npm audit` |
| Claude Desktop package | builds, 246 files, every checksum matches, manifest agrees with `package.json`; unsigned | [V] `npm run mcpb`, `node scripts/mcpb.js inspect`, `problems` |
| Request drivers | `drive:all` 13 of 13 jobs, `drive:live` 9 of 9 checks (local stub; no real provider called) | [V] |
| Global skill | in step with the documents (16 references when checked; 17 with this report added) | [V] `node scripts/skill.js check` |
| Documents | 23 checked, 62 relative links, 0 broken | [V] a link check over the documents (appendix A) |
| Secrets in the repository | none found by a sweep for seven common token formats; no `.env` file tracked; CI's scan found 0 verified and 0 unverified | [V] and [R] (CI run logs read on 2026-10-23 and 2026-10-29) |
| CI on `main` | the last five runs concluded success | [V] run conclusions; the job logs of the merges of pull requests 76, 77 and 80 were read in this conversation, those of 78, 79, 81 and 82 were not read in this audit |
| Railway rehearsal | up and answering correctly on 2026-10-29; the exact deployed commit is NOT VERIFIED | [R] the owner's probe output, read in this session |
| Savings (the project's stated purpose) | **never measured** | [R], and [V] six `todo` tests say so |

**The ten things to act on first** (details and fixes in sections 7 and 8):

| # | Finding | Severity | Who |
|---|---|---|---|
| 1 | PA-15: six of the nine original features are vendored, not integrated or tested; no saving has ever been measured | High (for the value claim) | owner decision |
| 2 | PA-04: a foreign `Origin` is accepted on `POST /mcp` (DNS rebinding on a server started without a token) | Medium | code change, owner approval (behaviour change) |
| 3 | PA-06: the base image and the GitHub Actions are not pinned by digest or commit; the production manifest ships `:latest` | Medium | needs the owner's approval to look the digests up |
| 4 | PA-12: the commit Railway runs is not known and cannot be checked from here | Medium | a small safe-probe tool (in-repo) plus the owner reading the dashboard |
| 5 | PA-16: no gateway API is `gated`; CoinGecko's keyless API ("not for production") is live in the rehearsal | Medium | owner sign-off or a keyed plan |
| 6 | PA-18: the two workflows have never run with real agents | Medium (for the claim) | owner or a later session |
| 7 | PA-19: two sessions on two accounts write the same record files | Medium (process) | owner decision |
| 8 | PA-13 and PA-14: one replica, a data file that is never compacted, no verified backup, no cluster rollout of the production manifest | Medium | owner / design |
| 9 | PA-09: the Railway container runs as root | Medium | image change, owner approval |
| 10 | PA-01, PA-02, PA-03, PA-20, PA-24: an intermittent test, a stale Windows sentence, stale rows in SECURITY.md (one says a control is missing that exists), no coverage threshold | Low | in-repo, no decision needed |

## 2. Scope, method and limits

**Re-run in this audit** (all [V]): merge of `main` into the work branch; `npm ci` (Node 22.22.0); `npm run verify` (type-check, lint, tests, build, smoke); `npm audit` for production and for all dependencies; `npm outdated`; `npm run mcpb` with `inspect` and `problems`; `npm run drive:all`; `npm run drive:live`; `node scripts/skill.js check`; `bash scripts/cleanroom.sh 554ee19` on Node 22.22.0 and Node 24.21.0; `npm test -- --coverage`; twelve repeats of the one test that failed once (six idle, six under eight busy loops on four CPUs); a link check, a secret sweep, a marker sweep (`TODO`, `FIXME`, skipped tests) and a count of lines per language; a read of the transport, handler, gateway live-call module, Dockerfile, production Kubernetes manifest, CI workflow, Dependabot configuration, the Stage 4 driver and the changes that landed after 2026-10-29 00:48 UTC (pull requests 78, 79, 81 and 82).

**Taken from the records, not re-run** [R]: the mutation-testing rounds (whole code base 78.7% to 90.0%; drivers, 162 breakages in rounds 7 to 10, [DRIVERS.md](DRIVERS.md) section 9), the independent reviews, the Windows 11 results of 2026-10-29, the Claude Desktop installs of versions 1.0.2 to 1.0.5, the Railway checks of 2026-10-10 and 2026-10-29, the release tags and their package hashes.

**Not possible here** [N]: a Docker build and the image probe (CI does them and passed), promtool (CI does it and passed), a cluster, Windows, any real provider (the sandbox cannot reach them), the Railway console or domain (the sandbox's proxy answers 403), the Gmail connector (never connected to the session), a run of the two multi-agent workflows with real agents (the `Workflow` tool was not offered to the session that built them).

**Severity.** High: could mislead the owner about what the project delivers, or lose data or confidentiality. Medium: a real risk or an operational property that is not proven. Low: a small defect or a gap with an easy workaround. Info: a note.

## 3. Who did what, and why

| Actor | Evidence | What they did | Why |
|---|---|---|---|
| The repository owner (GitHub account `nitro0dust-pixel`; the `LICENSE` names "Increadible Team") | merges, tags, the "Open decisions" of [ROADMAP.md](../ROADMAP.md), the owner's GO/NO-GO answers recorded in [BUILD-HISTORY.md](BUILD-HISTORY.md) | set the direction and the order of work (features first, 2026-10-07; a universal gateway, option A, 2026-10-10; Railway as the target; proprietary license; `AB_FSYNC` on; retries and the Wikimedia contact rule, 2026-10-12), approved every merge, pushed the release tags, ran the checks that need their own machine (Windows, Claude Desktop, Railway) | the project is theirs; by the project's rules production, deployment, live providers, rate limits and signing are theirs to decide |
| Claude Code sessions (models credited in the commit trailers: Opus 5.5, Sonnet 5.5, Haiku 4.5) | trailers on `main`; 78 pull requests merged, 100 commits on the first-parent line, 2026-10-05 to 2026-10-29 | wrote the code, tests, scripts, workflows and documents; ran the audit, the mutation tests and the reviews; opened the pull requests; read the CI logs; kept the records | at the owner's request, under the working rules in [CLAUDE.md](../CLAUDE.md): evidence over assumption, break every new guard on purpose, read the real logs, docs move with code |
| Two Claude Pro accounts | the handover record of 2026-10-09 ([BUILD-HISTORY.md](BUILD-HISTORY.md) section 4); git author names on the first-parent line: `nitro0dust-pixel` 38, `Urvashi Chandan` 33, `Claude` 22, `dependabot[bot]` 4, `Himanshu Sharma` 3 | the work continued on the second account when the first reached its weekly limit; on 2026-10-29 a session on the other account built Stage 4 of the drivers, the Windows 11 verification and the release records while a session on this one recorded the Railway check | usage limits; the owner works from both accounts |
| Independent reviewer agents (documentation follower, code and security reviewer, regression tester, skeptics) | [AUDIT.md](../AUDIT.md), [DRIVERS.md](DRIVERS.md) section 9 | reviewed work they did not write, reproduced findings before they were fixed | the project's rule that nobody validates their own work |
| Dependabot | pull requests 29, 62, 78, 79 | weekly dependency proposals (npm, GitHub Actions, Docker); majors are never proposed (by design) | keep dependencies current |
| GitHub Actions CI | [`ci-cd.yml`](../.github/workflows/ci-cd.yml) | quality, tests, security (audit, SBOM, secret scan), promtool, image build and probe, push to GHCR, pull back by digest and probe again | the gates; nothing merges on a red or unread run |

Git author names are quoted as recorded. They are not matched to people here; the records say only that two Claude Pro accounts were used and that the owner directed the work.

## 4. What was built, how, and in which language

### 4.1 Inventory [V]

Counted over the tracked files, leaving out the vendored third-party code in `features/01` to `06` (12 tracked entries, pinned to commits) and the lockfile.

| Language / format | Files | Lines | Where |
|---|---|---|---|
| TypeScript | 50 | 18,361 | server 3,690 lines in 10 files (`src/` 534, routing 447, A/B 1,320, gateway 1,389); tests 14,430 lines in 38 suites; two test helpers |
| JavaScript (Node, no dependencies) | 21 (+1 `.mjs`) | 4,167 (+18) | `scripts/` (18 files, 3,812 lines: drivers, packaging, probes, skill tool), `workflows/` (344 lines), the Jest configuration; the ESLint configuration is the `.mjs` |
| JSON | 19 | 6,308 | driver scenarios (4 files, 2,666 lines), the gateway's candidate store and review data, the Claude Desktop manifest, contract recordings |
| Markdown | 43 | 6,657 | documents (26 files) and the skill's copies (17 files) |
| YAML | 7 | 1,201 | Kubernetes manifests (4), the alert rules, CI, Dependabot |
| Shell | 6 | 500 | `scripts/*.sh`: smoke, verify, clean room, image probe, promtool |
| Dockerfile | 1 | 33 | two stages, Node 24 on Alpine, non-root |

One production dependency (`yaml`); ten development dependencies. The server is one Node process: stdio or HTTP.

### 4.2 Component by component

| Component | Files | Language | How it works (the logic) | Why |
|---|---|---|---|---|
| Transports | `src/index.ts`, `src/main.ts` | TypeScript, strict | stdio: newline-delimited JSON-RPC, replies kept in request order by chaining promises. HTTP: Node's `http`, stateless `POST /mcp`, `/health`, `/ready`, `/metrics`; a 1 MB body cap; header and request timeouts; the bearer token compared in constant time; an optional global token-bucket rate limit; on SIGTERM `/ready` answers 503 while draining, then the server closes and cuts what is left after a deadline; it refuses to start on a non-loopback address without a token | the same server must run under Claude Desktop (stdio) and in a container (HTTP) |
| Handler | `src/server.ts` | TypeScript | validates JSON-RPC 2.0 (version, id type), dispatches `tools/call` through a name-to-module map, turns a throwing tool into a tool error (the handler never throws), counts calls and errors, keeps fixed-bucket latency histograms (1 ms to 10 s) and an event-loop-delay histogram from a 10 ms timer, renders Prometheus text | one safe entry point for thirteen tools; metrics for the alerts |
| Routing Plugins (#7) | `features/07-routing-plugins/src/mcp-server.ts` | TypeScript, YAML rules | rules ordered by priority, the first enabled match wins, per-rule counters; `update_rules` validates, writes a temporary file, renames it, then switches in memory; an invalid file falls back to built-in rules | decide which model or route a request should take |
| A/B Testing (#8) | `features/08-ab-testing/src/mcp-server.ts` | TypeScript | 2 to 10 variants; sticky assignment by FNV-1a with a murmur3 finalizer mapped to [0,1); measurements appended to a JSON-lines file under a single-writer lock file with crash recovery and optional fsync; memory holds counts and a Welford running mean and variance per variant and metric (flat in the data size); Welch t-test with the exact t distribution for few samples; Holm correction over all pairs; guardrail metrics that can only withhold a winner | measure which variant is better, honestly, without memory growing with the data |
| API Gateway (#9) | `features/09-api-gateway/src/` (`mcp-server.ts`, `live.ts`, `catalog.ts`, `probes.ts`) | TypeScript | nine APIs as data with one gate record each; sample (mock) answers by default; real calls opt-in per API; the URL is built only under the API's registered URL (no host change, no `..`, encoded dots refused); GET only, JSON only, redirects refused, size and time capped; the credential is added by the gateway and scrubbed from every message; per-API rolling-minute limit (default 5), bounded retries, `Retry-After` honoured and capped at a day, a cooldown after HTTP 429; bounded cache and fan-out | one door to many APIs that a model cannot talk into reaching anything else |
| Claude Desktop package | `mcpb/manifest.json`, `scripts/mcpb.js`, `scripts/zip.js` | JavaScript, JSON | compiles into a clean stage, installs production dependencies from the lockfile with install scripts off, writes a deterministic zip (sorted entries, fixed timestamps); `inspect` and `problems` check it | a one-click install for the owner's Claude Desktop |
| Request drivers (Stages 1 to 4) | `scripts/drive-*.js`, `scripts/drive-scenarios/*.json`, `scripts/drive-expected.json` | JavaScript, JSON scenarios | start the real server (or the unpacked package, or reach a running one), send real JSON-RPC, check each answer against a declarative scenario, redact secrets, exit 0 / 1 / 2; `drive-all` runs every driver side by side in a temporary folder of its own with a process group per driver and fails a wrong step count; `drive-live` drives the compiled gateway against a local stub provider | prove behaviour by real requests, not by unit tests alone |
| Multi-agent workflows | `workflows/drive-gate.js`, `workflows/engineer-loop.js` | JavaScript for Claude's `Workflow` tool | agents with separate roles (research, planning, engineering, testing, security, validation); the script, not an agent, decides, and an answer of the wrong shape counts as no answer; the loop runs at most 7 rounds and never deploys | the owner's rule of independent criticism |
| CI and container | `.github/workflows/ci-cd.yml`, `Dockerfile`, `scripts/probe-image.sh` | YAML, Dockerfile, shell | six jobs; the image is probed (config, auth, restart persistence, health check, shutdown, 500,000-measurement capacity inside 256 MiB), pushed, pulled back by digest and probed again | the published bytes are the tested bytes |
| Kubernetes and monitoring | `k8s/`, `monitoring/` | YAML | one replica with `Recreate` (one writer for the data file), non-root, read-only root file system, all capabilities dropped, probes, resource limits, a DNS-only network policy; alert rules unit-tested with promtool | an operable deployment |
| Records and the global skill | `ROADMAP.md`, `docs/`, `skills/omniroute-mcp/`, `scripts/skill.js` | Markdown, JavaScript | documents are tested against the code (scripts, files and settings they name must exist; the skill's copies must equal the documents); a record row per merged pull request | so a fresh session can continue without reconstructing history |

## 5. The history, in phases

Dates are from the first-parent history of `main` [V]; the reasons are those recorded in [BUILD-HISTORY.md](BUILD-HISTORY.md) and [ROADMAP.md](../ROADMAP.md) [R]. Commits on the first-parent line per recorded day (the recorded time zone, so a late-evening UTC merge can count for the next day): 5 Oct 25, 6 Oct 13, 8 Oct 11, 9 Oct 8, 10 Oct 24, 12 to 14 Oct 7, 17 Oct 3, 20 Oct 1, 24 Oct 3, 29 Oct 5 (100 in all). The project's habit of insisting on evidence has a cause, phase 0.

| Phase | When | Pull requests | What was done | Why |
|---|---|---|---|---|
| 0. Before the first pull request | 5 Oct, 13:34 to 16:24 UTC | (direct commits `d1a88e8` to `bb3d491`) | six third-party projects added as submodules (OmniRoute, claude-mem, Headroom and token-optimizer-mcp, gstack, agentacct); our routing, A/B and gateway code written; end-to-end tests, a deployment guide, CI and "final" reports | the plan: nine features. **The reports said tests, sign-offs, load tests and scans were done; the tests checked hardcoded fixtures and the rest never ran**, and fabricated documents had to be replaced by verified ones ([BUILD-HISTORY.md](BUILD-HISTORY.md) section 1, ROADMAP "What has been done" item 1) |
| 1. Make it work, and deliver it | 5 Oct | 2 to 9 | a working build and runnable MCP server (stdio and HTTP) with a real Welch test; A/B persistence; CI pulls the pushed image back by digest; a pull secret; the ROADMAP; Windows-friendly checks; Node 20 (end of life) to Node 24; SBOM and Dependabot | phase 0 left code that had never been shown to work; the first job was a build that runs and a pipeline that proves it |
| 2. Harden and measure | 6 to 7 Oct | 10 to 18 | the data-file lock, fsync, growth warning; a tool that throws no longer ends the process; graceful shutdown; latency and event-loop metrics with alert rules validated by promtool; the handoff file; load and capacity baselines; A/B memory made flat; start-up probe; `AB_FSYNC` on | run it for real: no data loss, no hang, no blind spots; every limit measured before it was believed |
| 3. Product depth | 7 Oct | 19 to 22 | A/B direction, primary metric, guardrails, 2 to 10 variants with Holm correction; the gateway's live mode, opt-in per API; the document on companion tools | the owner's priority order for features; a "cheaper variant reported as loser" defect |
| 4. Independent audit | 7 to 9 Oct | 23 to 28, 30 | gateway resource bounds; A/B input poisoning; routing integrity and protocol conformance; scripts, alerts and CI (an alert that could not fire; a check that passed a partial run); a new toolchain; whole-code mutation testing 78.7% to 90.0% | the owner asked for every gap found and fixed with evidence |
| 5. Claude Desktop and the knowledge base | 9 Oct | 31 to 44 | the global skill and the documentation set; the `.mcpb` package; version 1.0.1 (the package did not answer `initialize` in Claude Desktop: lazy A/B open, a lock deadline, a proper entry); version 1.0.2 (tool schemas that state what the handlers accept); a Windows build fix; the license, scanner pin and release procedure | the owner installs it in Claude Desktop on Windows and found the first package silent |
| 6. Live gateway and the gated catalog | 10 to 14 Oct | 47 to 68 | version 1.0.3 (Live APIs and Contact settings); the nine APIs as data with gate records; health probes, contract recordings made on the owner's PC, a per-API rate limit, an egress policy, a store of 2,032 candidate APIs, terms review, bounded retries and 429 handling, the Wikimedia User-Agent rule; versions 1.0.4 and 1.0.5 and their tags | option A of the universal-gateway decision: an API is callable only after its gates are signed off |
| 7. Request drivers | 14 to 29 Oct | 69, 75, 76, 81 | Stage 1 (stdio, HTTP, protocol probe, package), Stage 2 (gateway, A/B statistics, routing scenarios), Stage 3 (`drive:all` and two workflows), Stage 4 (`drive:live` against a local stub; Windows 11 verification) | prove the server by sending it real requests, and put independent agents around that proof |
| 8. Deployment rehearsal | 10 Oct, 29 Oct | (no code) | Railway: a private rehearsal, then the four keyless APIs live; re-checked from the owner's PC on 2026-10-29 | the owner chose Railway for the first hosted run, approved in stages |
| 9. Records and upkeep | throughout | 70 to 72, 77, 80, 82; Dependabot 29, 62, 78, 79 | a record row per pull request; dependency bumps | the project's rule: after every step update the record |

## 6. Re-verification results [V]

| Check | Command | Result |
|---|---|---|
| Merge | `git merge origin/main`; `git diff origin/main HEAD` | merge commit `09954b2`; no difference in content |
| Install | `npm ci`, Node 22.22.0 | 388 packages; production audit 0; all-dependencies audit 6 low (PA-03) |
| Full verify | `npm run verify` | type-check PASS, lint PASS, tests PASS (1371 passed, 6 todo, 38 suites), build PASS, smoke PASS (stdio and HTTP); Docker build, promtool and cluster checks NOT AVAILABLE here |
| Clean room, Node 22.22.0 | `bash scripts/cleanroom.sh 554ee19` | PASS: the same five checks, 1371 passed |
| Clean room, Node 24.21.0 | the same with Node 24 first on `PATH` | PASS: 1371 passed |
| Coverage | `npm test -- --coverage` | 96.73% statements, 94.85% branches, 94.75% functions, 97.94% lines. `src/index.ts` 83.4% statements (its process entry block runs in a separate process that Jest cannot see; smoke covers it); `live.ts` 77.8% functions. One failing test (PA-01) |
| The failing test, repeated | `npx jest tests/drive.test.ts -t "http: SIGTERM to the driver mid-run"` twelve times | 12 passed (six idle, six with eight busy loops on four CPUs): not reproduced in isolation |
| Package | `npm run mcpb`; `inspect`; `problems` | 246 files, 297,611 bytes, sha256 `9d5712f8...`; every checksum matches; manifest consistent with `package.json`. The hash differs from the 1.0.5 release package (`20cb5740...`) because the tree has moved on since `61ff561` (new scripts in `package.json`); it is not a defect |
| Drivers | `npm run drive:all` | PASS 13 of 13 (stdio 4, http 4, probe 1, bundle 4) |
| Stage 4 | `npm run drive:live` | PASS 9 of 9 on a stub on `127.0.0.1`; "real providers: not called" |
| Skill | `node scripts/skill.js check` | in step, 16 references |
| Dependencies | `npm outdated` | `typescript` 5.9.3 (latest 7.0.2) and `@types/node` 24.19.2 (latest 26.6.6) are held back on purpose (majors are not proposed; the Node major is one value everywhere); `typescript-eslint` has a patch available |
| CI on `main` | Actions run list | runs 218, 219, 220, 222 (and the earlier ones recorded) concluded success |
| Code read | `src/index.ts`, `src/server.ts`, `live.ts`, `Dockerfile`, `k8s/production-deployment.yaml`, `ci-cd.yml`, `drive-live.js` | findings in section 7 |

## 7. Gaps and errors, with the recommended fix

Master table; the detail follows. "Fix class": **A** in-repo and safe to do now (no decision needed); **B** in-repo but changes behaviour or needs the owner's approval; **C** needs the owner (an action, a decision, or access this sandbox does not have).

| ID | Severity | Type | Finding | Fix class |
|---|---|---|---|---|
| PA-01 | Low | defect (test) | a process-cleanup test waits only 5 s and failed once under heavy load | A |
| PA-02 | Low | stale record | CLAUDE.md says 8 tests fail on Windows and "not reproduced here"; the 2026-10-29 Windows run did not re-run the test suite | A, then C |
| PA-03 | Low | stale record | SECURITY.md describes 20 moderate development advisories (2026-10-09); today there are 6 low, in another chain (`deepmerge` under Jest) | A |
| PA-04 | Medium | security gap | `Origin` is not validated on `POST /mcp` | B |
| PA-05 | Low to Medium | protocol deviation | version negotiation, `GET /mcp` answers 404, the protocol-version header is ignored, batches unsupported; a newer MCP revision may drop the handshake | B |
| PA-06 | Medium | supply chain | base image, GitHub Actions and the production manifest not pinned by digest or commit | C (needs lookups) |
| PA-07 | Low | supply chain | the secret scanner's image pin ages silently; only verified secrets are reported | A and C |
| PA-08 | Medium | gap | no image vulnerability scanner | C |
| PA-09 | Medium | hardening | the Railway container runs as root | B and C |
| PA-10 | Low to Medium | design limit | one shared bearer token; no throttle on failed logins; no rotation runbook for `AUTH_TOKEN` | A and B |
| PA-11 | Low | gap | the package is unsigned; no private vulnerability reporting address | C |
| PA-12 | Medium | verification gap | the commit Railway runs is not known; the pin did not hold once; checking it is manual | A and C |
| PA-13 | Medium | operations | one replica, no HA; the A/B file is never compacted; no verified backup | C (design) |
| PA-14 | Medium | verification gap | the production manifest and the network policy were never applied to a real cluster; the latency alert threshold is provisional; the server-wide rate limit is off | C |
| PA-15 | High | scope | six of nine original features vendored and untested; no saving ever measured | C |
| PA-16 | Medium | compliance | no API is `gated`; key-based APIs never live; terms issues for NewsAPI and CoinGecko, which is live in the rehearsal | C |
| PA-17 | Low | limit | A/B statistics are fixed-sample; some scenario branches are not reached | B |
| PA-18 | Medium | verification gap | the two workflows have never run with real agents | C |
| PA-19 | Medium | process | two sessions on two accounts write the same record files | C |
| PA-20 | Low | quality | no coverage threshold; mutation testing is manual | A |
| PA-21 | Info | upkeep | dependency majors are never proposed; a manual cadence is needed | C |
| PA-22 | Low | verification gap | on Windows a signalled child ends without running the server's handler; the drivers accept that, so graceful shutdown on Windows is unproven | C |
| PA-23 | Info | environment | Gmail and the Railway console could not be reached from the authoring session | C |
| PA-24 | Low | stale record (security document) | SECURITY.md says the secret scanner image is not pinned; it has been pinned by digest since 2026-10-09 | A |

### Defects and stale records

**PA-01 (Low, [V]). An intermittent test.** `tests/drive.test.ts`, "http: SIGTERM to the driver mid-run ends the server it started...", failed once in the coverage run with "gave up waiting for the server to be gone". That run overlapped a full clean room, so the machine was heavily loaded. Twelve repeats alone and under eight busy loops all passed. The test waits at most 5,000 ms for the child process to exit after the driver was interrupted; the sibling stdio test has the same window. The failure is the test's patience, not (as far as twelve runs show) a leak: no driver or server was left running afterwards. *Fix (A):* raise both waits to 20 s so the test fails only when a server is genuinely left behind; do not skip or retry the test.

**PA-02 (Low, [V]). A stale sentence.** [CLAUDE.md](../CLAUDE.md), "Environment gotchas", still says `npm test` has 8 failing tests in four suites on Windows and "not reproduced here". On 2026-10-29 the drivers and the stub driver passed on Windows 11 [R], but the record does not say the test suite was run there. *Fix (A):* reword to "last reported 2026-10-09; not re-run since", and (C) have the owner run `npm test` on Windows 11 once and record the result.

**PA-03 (Low, [V]). The development advisories in SECURITY.md are the old ones.** [SECURITY.md](../SECURITY.md) ("What is not done") says: 20 moderate advisories, none high or critical, one chain (`sprintf-js`) without a patch, as of 2026-10-09. Today `npm audit` reports 6 low-severity findings in a different single chain: `deepmerge` (prototype poisoning through `mergeObject`, GHSA-gcqx-w48m-w2h4) used by `jest-config`, `@jest/core`, `jest`, `jest-cli` and `ts-jest`. Production has 0; the image and the package carry none of it. npm's suggested remedy (`npm audit fix --force`) would install `jest@25.1.0`, a five-major downgrade, and must not be run. *Fix (A):* replace the row with today's figures and the reasoning (test-time only; no untrusted input reaches `deepmerge`), and look again when Jest ships a release that does not depend on it.

### Security and hardening

**PA-04 (Medium, [V] code read, [R] probe). `Origin` is not validated.** `createHttpServer` in `src/index.ts` never reads the `Origin` header, and the protocol probe records this as a known deviation (`http.origin-is-not-validated`). With a token, a web page cannot add the bearer header, so the exposure is small. Without one (the allowed loopback case, or `ALLOW_UNAUTHENTICATED`), a page can POST JSON as `text/plain` without a preflight, which is the DNS-rebinding case the MCP transport rules guard against. *Fix (B):* answer 403 when an `Origin` header is present and not on an allow-list (default: empty, so browsers are refused and non-browser clients, which send no `Origin`, are unaffected); also answer 415 when the content type is not JSON. Add the setting to the documents and the Claude Desktop manifest only if it is user-facing, flag it as a behaviour change in the [CHANGELOG](../CHANGELOG.md), and update the probe's expected lines in the same pull request (the probe fails on purpose when a recorded deviation is fixed).

**PA-05 (Low to Medium, [V] code read, [R] spec reading). Protocol deviations.** `initialize` echoes any date-shaped version instead of negotiating; `GET /mcp` answers 404 where the 2025-11-25 transport page asks for 405 (a client built on the reference SDK reports any other status as an error); an invalid `MCP-Protocol-Version` header is accepted; JSON-RPC batches get "Invalid Request". A newer revision (2026-07-28, marked latest in the specification repository, NOT VERIFIED on the website) reportedly drops the handshake. *Fix (B):* keep a list of supported versions and negotiate; answer `GET /mcp` with 405 and `Allow: POST`; reject an invalid version header with 400; then read the current specification page itself before deciding on the stateless revision. These are the owner's call ([DRIVERS.md](DRIVERS.md) section 8 says so); each is a few lines, and the probe's recorded deviations must be updated with them.

**PA-06 (Medium, [V]). Mutable references.** The Dockerfile uses `node:24-alpine` (a moving tag) and `# syntax=docker/dockerfile:1`; `ci-cd.yml` uses actions by tag (`actions/checkout@v7`, `docker/build-push-action@v7`, `trufflesecurity/trufflehog@v3.99.7`); `k8s/production-deployment.yaml` ships `image: ...:latest` with `imagePullPolicy: IfNotPresent` (its comment and [DEPLOYMENT.md](../DEPLOYMENT.md) tell the operator to pin a digest by hand). A moved tag changes what is built or run without a commit. The project already pins the secret-scanner image by digest, so the practice exists. *Fix (C, then B):* with the owner's approval to look the digests and commit hashes up (the sandbox cannot reach the registries), pin the base image by digest (Dependabot's Docker ecosystem can then propose digest updates), pin the actions by commit hash with the tag in a comment (Dependabot updates both), and ship the production manifest with a digest placeholder that CI fills in, or a `kustomize` overlay.

**PA-07 (Low, [V]). The scanner pin ages.** The action is at 3.99.7 (Dependabot, pull request 78) while the scanner image it runs is pinned to 3.99.2 by digest (the owner's decision of 2026-10-09); Dependabot cannot update a digest written into a `version:` input, so the image will stay old unless someone bumps it on purpose, and `--only-verified` reports only secrets the provider confirms are live. *Fix (A and C):* a scheduled reminder or a CI note when the pinned scanner is more than a quarter behind the action; the owner may choose to add a second, non-blocking scan without `--only-verified`.

**PA-08 (Medium, [R] and [V] absence). No image vulnerability scan.** CI audits the production npm tree (0) and scans for secrets but runs no Trivy, Grype or Docker Scout on the image; the choice and the pin are an open owner decision. *Fix (C):* choose one, approve the lookup of its release and hash, add it as a non-blocking job first.

**PA-09 (Medium, [R]). Root on Railway.** The rehearsal sets `RAILWAY_RUN_UID=0` because Railway mounts volumes as root and the image runs as `node`; [SECURITY.md](../SECURITY.md) records it. The service answers on a public HTTPS address, but `/mcp` and `/metrics` need the token and no API key is stored on it, which limits the harm. *Fix (B and C):* an entrypoint that starts as root only to `chown` the data directory and then drops to `node` (for example with `su-exec`), proved by the image probe in CI, then remove the variable on Railway. Not tried so far.

**PA-10 (Low to Medium, [V] code read). One shared token.** All clients share one bearer token; the rate limit is global; failed logins are not throttled (a 64-hex token makes guessing infeasible, but each attempt costs a log-free 401); and no document describes rotating `AUTH_TOKEN` (the rotation sentence in [DEPLOYMENT.md](../DEPLOYMENT.md) is about the image pull secret). *Fix (A):* write a rotation runbook (Kubernetes: replace the secret, then a rollout restart, because a running pod keeps the old value; Railway: change the variable, which redeploys; Claude Desktop: change the setting). *Fix (B):* count failed attempts and add a small delay or a 429 after a burst; consider per-client tokens only if more than one client appears.

**PA-11 (Low, [R]). Unsigned package, no reporting address.** The `.mcpb` is unsigned (Claude Desktop installs it anyway); [SECURITY.md](../SECURITY.md) names no address because private vulnerability reporting is not switched on. *Fix (C):* switch on GitHub's private vulnerability reporting (repository Settings, Security) and put the path in `SECURITY.md`; sign the package only if it will be given to other people.

### Operations and verification

**PA-12 (Medium, [V] and [R]). Railway's commit is unknown.** On 2026-10-29 the owner's probe returned `status: ok` for `/health` and `/ready`, 401 without the token, and an authenticated `get_api_stats` with the same fields as the code on `main`, the four keyless APIs live and the contact set. That proves the build is newer than `916206f` (it has the 2026-10-13 changes) but not which commit it is; another account's note said `020e6e3`. The commit pin did not hold once when a variable change redeployed `main`'s head. *Fix (A):* add a small, dependency-free command (a remote probe) that does the five checks without writing data and without calling a provider, reads the token from an environment variable and prints a report; the PowerShell probe in [DEPLOYMENT.md](../DEPLOYMENT.md) does this by hand today, and `drive:http` against a deployment with live APIs would call real providers by design. *Fix (C):* read the latest deployment's commit and status in the Railway dashboard, and deploy from a tag or an explicit commit.

**PA-13 (Medium, [R]). Availability and growth.** One replica with `Recreate` (the data file has exactly one writer), so a restart means downtime; the A/B file is never compacted (about 8.9 million measurements per GiB), and backups of the volume were not checked. *Fix (C, design):* a documented backup (a copy or snapshot job and a restore test); a rollup or rotation design for the file; consider a different store only if more than one replica is ever needed.

**PA-14 (Medium, [R]). Never on a real cluster.** The staging manifest ran on a local Docker Desktop cluster; the production manifest, the network policy (needs a CNI that enforces it) and the alert rules in a live Prometheus were not applied anywhere. The latency alert (p95 above 1 s for 10 minutes) is three orders of magnitude above the measured normal, so it would only catch a stall; the server-wide `RATE_LIMIT_PER_MINUTE` is off. *Fix (C):* apply staging to a real cluster with the owner's approval, run the probe there, set the rate limit from [PERFORMANCE.md](../PERFORMANCE.md)'s method, and lower the alert to about 250 ms after re-measuring on the real volume.

### Scope and product

**PA-15 (High for the value claim, [V]). The savings were never measured, and most of the features are not here.** The project started as nine proposed features. Three are written here (routing, A/B, gateway). Six are vendored third-party projects pinned as submodules (OmniRoute, claude-mem, headroom, token-optimizer, gstack, agentacct) that are not integrated or tested; the six `it.todo` tests in `tests/e2e-integration.test.ts` say exactly this, and one of them says "real cost savings must be measured from actual usage logs". The old percentages were targets, not results ([COMPANIONS.md](../COMPANIONS.md) rejected agentacct as the savings instrument). Everything else in this report is engineering quality; this is whether the project delivers what it was for. *Fix (C):* decide which of two paths to take: integrate one companion side by side and measure a real workload before and after (the cost-saving measurement is BLOCKED on a real workload), or state the project as a gateway, A/B and routing server and retire the savings claims and the unused submodules.

**PA-16 (Medium, [V] and [R]). Nothing is gated, and one live API is "not for production".** `get_api_stats` on Railway shows every one of the nine APIs with status `candidate`; no gate (pinned URL, auth class, terms) has a dated sign-off, and a test enforces that none may be `gated` without them. The five key-based APIs have never run live. CoinGecko's keyless API is described as not for production, and NewsAPI's free plan forbids production; CoinGecko is nonetheless one of the four live APIs in the rehearsal. *Fix (C):* the owner signs off, or moves to a keyed plan or another provider, before anything but a rehearsal depends on these calls.

**PA-17 (Low, [R]). Statistical limits.** The A/B results are a fixed-sample snapshot (asking repeatedly and acting on the first significant answer inflates false positives; no sequential testing); the driver scenarios have no experiment whose p-value lies between about 1.9e-16 and 0.96, and the branch for 30 samples per variant is not reached. *Fix (B):* document the peeking caveat in the tool descriptions (partly done), add scenario experiments for those ranges.

### Process and quality

**PA-18 (Medium, [R]). The workflows have never run.** `workflows/drive-gate.js` and `workflows/engineer-loop.js` are tested only with stand-in agents (decision rules, order, prompts; 162 deliberate breakages of `drive-all` and the two workflow scripts); the option names for the `Workflow` tool come from its description and were not tried; the prompts have never been read by a model that acted on them. The rules "never push, never touch production" are instructions, not barriers. *Fix (C):* run `drive-gate` once on a clean checkout and write the verdict, the cost and the evidence paths into [BUILD-HISTORY.md](BUILD-HISTORY.md) and [DRIVERS-WORKFLOW.md](DRIVERS-WORKFLOW.md) section 11, in a session that has the tool, in an environment without credentials the code under test should not have.

**PA-19 (Medium, [V] from the history). Two writers of the records.** The rule in [CLAUDE.md](../CLAUDE.md) is one session at a time, and that session keeps the records. On 2026-10-29 the other account merged pull requests 81 and 82 (Stage 4, release records, ROADMAP, BUILD-HISTORY, the skill) within hours of this account's records pull requests 77 and 80. Nothing conflicted and CI stayed green, but the same lines were edited twice. *Fix (C):* the owner names the record keeper, and the ROADMAP states it in one line with a date; a session that is not the keeper opens pull requests but leaves the record files to the keeper.

**PA-20 (Low, [V]). Guards that can quietly weaken.** `jest.config.js` sets no coverage threshold, so coverage can fall without CI noticing; the whole-code mutation score (90.0% on 2026-10-09) was measured by hand and is not re-measured on a schedule. *Fix (A):* add a global threshold just under today's figures (for example 95% statements, 93% branches and functions, 96% lines) that applies when CI runs with coverage; run the mutation tool on a schedule as a non-blocking job.

**PA-21 (Info, [V]). Majors by hand.** Dependabot never proposes majors, so TypeScript 5.9 to 7.0 and `@types/node` 24 to 26 need a person to look. *Fix (C):* a quarterly review of `npm outdated`, noted in the ROADMAP.

**PA-22 (Low, [R]). Windows signals.** On Windows a child ended with `kill("SIGTERM")` stops at once with `{ code: null, signal: "SIGTERM" }` without running the server's handler, and `drive-http.js` and `drive-probe.js` now accept that as success on that platform, so a graceful stop (draining, releasing the A/B lock) is not tested there. A stale lock is taken over by the next start, which limits the harm. *Fix (C):* decide whether graceful shutdown on Windows matters (Claude Desktop ends stdio servers by closing the pipe); if it does, add a stdin-close shutdown test.

**PA-23 (Info). What the authoring session could not reach.** Gmail was never connected to the session, the Railway connector was not connected, and the sandbox's proxy refuses the Railway domain. Anything those would show (Railway notices, deployment logs) is outside this audit. *Fix (C):* connect the connectors at the start of a session; the owner can run the probe from their PC.

**PA-24 (Low, [V]). A security document that understates a control.** The same "What is not done" table in [SECURITY.md](../SECURITY.md) has the row "The secret scanner image is not pinned: recorded as D-5 in AUDIT.md; owner decision". It has been pinned by digest since pull request 39 (2026-10-09): the `version:` input in `ci-cd.yml` is `3.99.2@sha256:47a84bc1...`, and a test fails if it is unpinned again. A reader, or someone reporting a problem, is told that a control is missing that exists. Nothing tests SECURITY.md against the workflow. *Fix (A):* correct the row (and PA-07's remaining point, that the pin ages); add a test that fails if SECURITY.md says the scanner is unpinned while the workflow pins it.

## 8. Recommended order of work

| Step | What | Items | Class | Effort |
|---|---|---|---|---|
| 1. Now, in the repository, no decision needed | raise the four process-cleanup waits; correct the Windows sentence; correct SECURITY.md (the advisory row and the scanner row); add a coverage threshold; write the `AUTH_TOKEN` rotation runbook; add the remote probe command; record these fixes | PA-01, PA-02 (first half), PA-03, PA-10 (runbook), PA-12 (tool), PA-20, PA-24 | A | small to medium, one pull request |
| 2. The owner's quick actions | read Railway's deployment commit and status; run `npm test` on Windows 11; switch on private vulnerability reporting; name the record keeper | PA-12, PA-02, PA-11, PA-19 | C | minutes |
| 3. Approvals that unlock work | allow the digest and commit lookups and pin the base image, actions and manifest; choose an image scanner; approve the `Origin` check, the protocol fixes and the root-to-node entrypoint | PA-04, PA-05, PA-06, PA-08, PA-09 | B and C | one pull request each |
| 4. Verification that needs the owner's resources | a real cluster rollout; the first real run of the workflows; the backup test | PA-13, PA-14, PA-18 | C | a session each |
| 5. Decisions about what the project is | the savings path; gate sign-offs or a keyed plan for CoinGecko and NewsAPI | PA-15, PA-16 | C | the owner |

**Production authority.** Nothing in this list deploys anything. Agents may research, change code, test and open pull requests; a merge needs CI green on the exact head with the logs read and the owner's GO, and production, live providers, rate limits, signing and the Railway service stay the owner's decisions.

## 9. Status of the fixes (updated as they land)

Step 1 of section 8, the class A fixes, was done on 2026-10-30 in one pull request ([#84](https://github.com/nitro0dust-pixel/Increadible/pull/84), merged as `dbb512a`; its CI runs are in `docs/BUILD-HISTORY.md` and `ROADMAP.md`). Of class B, PA-04 and PA-05 were done the same day, after the owner asked for the next recommended step (rows at the end of the table); nothing else in class B or C was started. A finding is **fixed** only where a run or a test shows it; where the fix has a part that needs the owner, that part stays open and is named.

| ID | Status | What was done | What stays open | Evidence |
|---|---|---|---|---|
| PA-01 | Fixed | the four waits for a process to be gone in `tests/drive.test.ts` ("an interrupted driver leaves nothing behind") end as soon as the process is gone and wait up to 20 s instead of 5 s | nothing | [V] the failure was seen once, under the load of a coverage run, and not reproduced in 12 further runs; a longer wait removes a timing assumption but is not a proof that it cannot recur |
| PA-02 | Partly fixed | `CLAUDE.md` now says the Windows 11 run of 2026-10-29 covered the drivers, not `npm test`, so "not re-run since" | `npm test` on Windows 11 is still to be run by the owner (class C) | [V] the sentence; the Windows result stays [N] |
| PA-03 | Fixed | the development-dependency row of `SECURITY.md` states today's figures: 6 low advisories in one chain (`deepmerge`, GHSA-gcqx-w48m-w2h4, under Jest), production 0, and that `npm audit fix --force` must not be run | the figure ages; re-run `npm audit` at each release | [V] `npm audit`; no test can guard a dated figure |
| PA-07 | Partly fixed | the scanner row of `SECURITY.md` now says what is true: the image is pinned by digest and the pin ages; only verified secrets are reported (`--only-verified`) | whether to report unverified secrets too, and who bumps the digest, are the owner's (class C) | [V] the row |
| PA-10 | Partly fixed | `DEPLOYMENT.md` has a section "Rotating `AUTH_TOKEN`": Kubernetes (replace the secret, then `rollout restart` and `rollout status`), Railway, Docker, Claude Desktop (none), and how to check | the throttle on failed logins and per-client tokens are class B and not started | [V] the section; the Kubernetes commands were not run (no cluster) |
| PA-12 | Partly fixed | `npm run probe:remote` (`scripts/probe-remote.js`): six read-only checks of a running server; it sends only `GET /health`, `GET /ready` and `POST /mcp` (`initialize`, `tools/list`, `get_api_stats`), so it is safe against live APIs, unlike `drive:http --url` | the server does not report its own commit, so **the commit Railway runs is still NOT VERIFIED**; the owner reads it in the Railway dashboard. The tool has not been run against Railway | [V] `tests/probe-remote.test.ts` against the real compiled server and against stand-ins; 26 breakages of its guards, all caught (`docs/DRIVERS.md`, round 11) |
| PA-20 | Partly fixed | `jest.config.js` has a `coverageThreshold` just under the measured figures (statements 95, branches 93, functions 93, lines 96), enforced under `--coverage`, which CI runs | mutation testing stays manual | [V] `npm test -- --coverage` passes with it; a guard test checks that the threshold exists |
| PA-04 | Fixed | a request with an `Origin` header is refused with 403 unless `ALLOWED_ORIGINS` lists it, before the token check and also on a server started without a token; `/health` and `/ready` are exempt; new setting `ALLOWED_ORIGINS` (comma-separated canonical origins; invalid entries are named in the start-up log and ignored) | `Host` is still not validated and `Content-Type` is not checked (the probe records both as `INFO`); a browser-based client must have its origin listed (**behaviour change**, flagged in `CHANGELOG.md`) | [V] `tests/http-origin.test.ts`, `tests/entry-point.test.ts`, `scripts/smoke.sh`, the probe's `http.foreign-origin-is-refused`; 31 breakages of the new guards, all caught (`docs/DRIVERS.md`, round 12) |
| PA-05 | Partly fixed | `GET`/`DELETE /mcp` answer 405 with `Allow: POST`; an unsupported `MCP-Protocol-Version` header gets 400; `initialize` negotiates over `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25` and answers `2025-11-25` otherwise (**behaviour changes**, flagged in `CHANGELOG.md`) | JSON-RPC batches are still refused although revision 2025-03-26, which is listed, asks a server to accept them (from memory, NOT VERIFIED against its text); a newer revision (2026-07-28) has another handshake and is not offered | [V] the same tests; the probe's four former `KNOWN` cases are contracts |
| PA-24 | Fixed | `SECURITY.md` no longer says the scanner image is unpinned | nothing | [V] a test fails while `SECURITY.md` calls the scanner unpinned and the workflow pins its image by digest; broken on purpose and caught |

## Appendix A. Commands and results

| What | Command | Result |
|---|---|---|
| Authors, dates | `git log --first-parent origin/main`; `git shortlog` | 100 commits, 78 pull request merges, 2026-10-05 to 2026-10-29 |
| Lines per language | `git ls-files` with `wc -l` | section 4.1 |
| Link check | a Node script over the tracked `.md` files (not vendored, not the skill's copies, not `features/`) | 23 files, 62 relative links, 0 broken |
| Secret sweep | a regex sweep of tracked, non-vendored files for GitHub, OpenAI-style, AWS, Slack, Google and private-key formats | no match; no `.env` tracked |
| Markers | a sweep for TODO, FIXME, XXX, HACK in source | none (matches were `mktemp` templates) |
| Production tree | `npm ls --omit=dev --all` | `yaml@2.9.1` only |
| Dependency audit | `npm audit --omit=dev`; `npm audit` | 0; 6 low (dev) |
| Stats shape on Railway | the owner's `get_api_stats` output compared with the compiled server's output | the same 20 top-level fields and the same gate-record fields |

## Appendix B. Statements taken from the records and not re-run

Mutation results (whole code base 78.7% to 90.0%; drivers 162 breakages in four rounds); the independent reviews; the Windows 11 results of 2026-10-29 (`drive:all` 13 of 13, `drive:live` 9 of 9 and 4 of 4 live probes on the owner's PC); the installs of versions 1.0.2 to 1.0.5 in Claude Desktop; the Railway checks of 2026-10-10 and 2026-10-29; the release tags `v1.0.2` to `v1.0.5` and their package hashes. They are consistent with everything this audit could check, and are marked as records so that a reader knows they rest on someone else's run.
