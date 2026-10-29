# Increadible: context for Claude sessions

Read this first, then `ROADMAP.md` (status, plan, open decisions: the source of truth for *what is done*),
`DEPLOYMENT.md` (how it runs), `PERFORMANCE.md` (what has been measured, and what the numbers do not say), `COMPANIONS.md` (third-party tools that run beside this server, never inside it) and `GATEWAY.md` (the decision record for a universal API gateway: researched; option A, the gated catalog, approved by the owner on 2026-10-10; being built step by step, `docs/GATEWAY-GATED-CATALOG.md` says what is done); `AUDIT.md` is the account of the code audit: what was found, fixed and left open). The index of every document is `docs/README.md`; `CONTRIBUTING.md` and `SECURITY.md` cover how to change the code and its security posture; the global skill `skills/omniroute-mcp/` carries all of it into any Claude session. This file holds the stable facts and the working rules; it deliberately holds no test
counts, no commit hashes and no status, because those go stale with every PR.

## What this is

One MCP server (stdio and HTTP) serving three components we wrote: Routing Plugins (#7), A/B Testing (#8) and API
Gateway (#9, **mock data by default**, with opt-in live calls: verified for the four keyless APIs only (coingecko, hackernews, wikipedia, wikidata: one real call each from Claude Desktop on the owner's Windows PC and from the Railway rehearsal, 2026-10-10, version 1.0.3); the key-based APIs have never run live). `features/01-06` are vendored third-party submodules that are **not integrated or
tested here**. Nothing is deployed beyond rehearsals (a local Kubernetes one, and a private one on Railway, `DEPLOYMENT.md`); no cost saving has been measured (the old percentages were
targets, not results).

## Repository and branch workflow

- Repo `nitro0dust-pixel/Increadible` (private). **The default branch is `main`** (owner switched it on 2026-10-09); PRs
  target `main`, and Dependabot reads its configuration from it.
- **One Claude session works on the project at a time, and it keeps the records** (owner, 2026-10-09: a second session ran in parallel
  for PRs #43 and #45, both sessions edited the same status lines, and its record PR #45 was closed as superseded by #46; that session is
  ended). A session that finds another one active asks the owner before touching ROADMAP, BUILD-HISTORY, CHANGELOG or the skill's status.
- Work happens on one work branch at a time (historically `claude/nice-keller-aoooos`; a cloud session is given its own), one PR at a time, squash-merged into `main`. After a squash merge the
  branch and `main` have identical content but different commits: bring `main` in with `git fetch origin main && git merge
  origin/main` and push as a fast-forward. **Never force-push or rewrite history**.
- Nothing is deployed to production without explicit owner approval. Pushing to the work branch and opening PRs is routine;
  merging needs CI green on the exact head and the real logs read (below).

## Commands that exist and were verified

| Command | Checks |
|---|---|
| `npm ci` | install (lockfile is tracked) |
| `npm run type-check`, `npm run lint` | `tsc --noEmit`, ESLint over `src`, features 07-09 and `tests` |
| `npm test` | Jest over `tests/` (add `-- --coverage`; no coverage threshold is configured) |
| `npm run build` | compile to `dist/` (a cleaner script runs first: `scripts/clean.js`, because `rm -rf` is not portable to `cmd.exe`) |
| `npm run smoke` | `scripts/smoke.sh`: real processes over stdio and HTTP (lock, crash safety, refusal to start open, drain, deadline) |
| `npm run mcpb` (`node scripts/mcpb.js build`, `inspect FILE`, `problems`) | build the one-click Claude Desktop package `dist/mcpb/increadible-<version>.mcpb` from the committed sources (`mcpb/manifest.json`; the zip writer is `scripts/zip.js`); check a bundle; check the manifest against `package.json`. Needs `npm ci` first. Claude Desktop accepting and running the file: **verified** for version 1.0.2 on Windows (2026-10-09, `docs/INSTALL-CLAUDE-DESKTOP.md` section 5.4) |
| `node scripts/skill.js sync`, `check`, `package`, `install` | keep the global skill `skills/omniroute-mcp/` in step with the documents; zip it for upload; install it for Claude Code |
| `npm run verify` | type-check, lint, tests (fails if fewer suites ran than `tests/*.test.ts` files), build, smoke, plus Docker build and `promtool` when present; prints the commit and tree it tested and reports `NOT AVAILABLE` for what it cannot run |
| `bash scripts/cleanroom.sh [commit]` | `verify` on a `git archive` of `HEAD` (or the commit given) after `npm ci`: only what is committed, nothing from the working copy. Use it for any claim of the form "it passes on commit X" |
| `bash scripts/probe-image.sh <image>` | the image the way a deployment runs it: needs Docker, curl, jq. **Only CI has a Docker daemon**; locally it can be tried against a stubbed `docker`, which proves the script's logic but not the image |
| `npm run loadtest`, `npm run capacity` | per-tool throughput and latency; A/B data size against restart, memory and query cost (not in CI: shared runners are too noisy; `smoke.sh` only checks they still run). Use an idle machine and read `PERFORMANCE.md` first |
| `node scripts/record-contracts.js [--where M] [api ...]` | after `npm run build`, with `GATEWAY_USER_AGENT` set: sends each keyless API's health probe through the gateway and records the answer to `tests/fixtures/contracts/` for the contract tests (gated catalog, step 1b). Needs a machine that reaches the providers: **not the authoring sandbox** |
| `node scripts/run-probes.js [--history F] [--where M] [api ...]`, `... report [--history F]` | after `npm run build`, with `GATEWAY_CONTACT` set: sends each keyless API's health probe once through the gateway and appends the outcome (passed or not, latency, HTTP status, problems; never the body or the User-Agent) to a probe history, default `probe-history.jsonl`; `report` prints runs, failures, failures in a row and median latency per API. For a scheduler on a machine that reaches the providers: **not the authoring sandbox**; nothing in the server runs it |
| `node scripts/seed-candidates.js <README.md> <LICENSE> --fetched-on D --source-url U` | the gated catalog's seed import (step 4): a snapshot of the public-apis list into `features/09-api-gateway/data/candidates-public-apis.json`, candidates only, read by no server code. The input is fetched by hand (not in CI) |
| `node scripts/candidate-report.js` | after `npm run build`: regenerates `docs/GATEWAY-CANDIDATES.md` from the candidate store and the catalog (a test fails while the document is stale) |
| `node scripts/make-ab-data.js --file <f> --measurements <N>` | writes an A/B data file of N measurements (fast, no server); smoke and the image probe use it to start on a large file |
| `npm run drive:stdio`, `drive:http`, `drive:probe`, `drive:bundle`, `drive:live` | the request drivers (`scripts/drive-stdio.js`, `drive-http.js`, `drive-probe.js`, `drive-bundle.js` and `drive-live.js` on the library `drive-lib.js`; `docs/DRIVERS.md`): start the built server (or the unpacked `.mcpb`, or reach a running one with `--url`, or drive the compiled gateway against a local stub HTTP provider with `drive:live`), send real JSON-RPC, check the answers against a scenario (`scripts/drive-scenarios/`), print a report. Need `npm run build` (bundle: `npm run mcpb`). Exit 0 all passed, 1 a check failed, 2 could not run. Verified on Linux and on Windows 11 (`Nitro-Dust`, 2026-10-29) |
| `npm run drive:all` | all the drivers against every shipped scenario, side by side (`scripts/drive-all.js`, expected step counts in `scripts/drive-expected.json`; `docs/DRIVERS-WORKFLOW.md`): one table, exit 0 all passed, 1 a check failed (or a job left a work directory behind), 2 could not run. Needs `npm run build` first, and `npm run mcpb` for the bundle jobs (the build removes `dist/mcpb`). For JSON use `npm --silent run drive:all -- --json` (npm's own banner lines would break the file). The two multi-agent workflows that put separate agents around it are `workflows/drive-gate.js` and `workflows/engineer-loop.js` (same document); they are told never to push, merge or deploy; a real run of them is NOT VERIFIED (the `Workflow` tool was not offered to the session that built them) |
| `PROMTOOL=<bin> bash scripts/check-prometheus.sh` | `promtool check rules` and `test rules` for `k8s/monitoring.yaml` (`scripts/install-promtool.sh <dir>` builds the pinned promtool) |

CI (`.github/workflows/ci-cd.yml`): `quality`, `test`, `security` (audit, SBOM, secret scan), `prometheus` run in parallel;
`docker` (build, probe, push to GHCR on `main`) needs the first three; `verify-published-image` (main only) pulls the pushed
image by digest and probes it again. The package `ghcr.io/nitro0dust-pixel/increadible` is private.

## Architecture in one screen

- `src/index.ts`: transports. stdio (newline-delimited JSON-RPC) or HTTP (`/health`, `/ready`, `/metrics`, `POST /mcp`, stateless);
  timeouts, optional rate limit, drain and hard-deadline shutdown, refusal to start open beyond loopback.
- `src/server.ts`: the JSON-RPC handler, tool dispatch, metrics (counters, tool-latency histogram). A throwing tool becomes a tool
  error; the handler never throws.
- `features/07..09/src/mcp-server.ts`: the three modules. The gateway's registry is data in `features/09-api-gateway/src/catalog.ts`, one
  gate record per API (option A, `docs/GATEWAY-GATED-CATALOG.md`); no API is `gated` until every gate has a dated sign-off, which a test enforces. A/B data is an append-only JSON-lines file (`AB_DATA_FILE`) with a
  single-writer lock file, crash recovery, optional fsync and a growth warning; it is never compacted. In memory the A/B module keeps
  only counts and a running mean and variance per variant and metric (so memory and the cost of a results call do not grow with the
  data), and replays the file in chunks at startup. `tests/ab-golden.test.ts` holds it to the answers of the earlier array-based version.
- `k8s/` manifests (one replica, `Recreate`, an RWO volume: the data file has exactly one writer), `monitoring/` alert unit tests,
  `Dockerfile` (Node 24, non-root).
- Node: one major (24) across the Dockerfile, CI and `@types/node`, enforced by a test; `engines` is `>=22`.

Configuration (names only; values come from the environment, never commit them): `PORT`, `HOST`, `AUTH_TOKEN`,
`ALLOW_UNAUTHENTICATED`, `RULES_FILE`, `EXPERIMENTS_FILE`, `AB_DATA_FILE`, `AB_FSYNC`, `AB_LAZY_OPEN`, `AB_DATA_WARN_BYTES`,
`HTTP_HEADERS_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `RATE_LIMIT_PER_MINUTE`, `SHUTDOWN_DRAIN_MS`, `SHUTDOWN_TIMEOUT_MS`,
`GATEWAY_LIVE_APIS`, `GATEWAY_TIMEOUT_MS`, `GATEWAY_MAX_RESPONSE_BYTES`, `GATEWAY_USER_AGENT`, `GATEWAY_CONTACT`, `GATEWAY_RATE_LIMITS`, `GATEWAY_DEFAULT_RATE_LIMIT`, `GATEWAY_RETRIES`, `GATEWAY_RETRY_MAX_WAIT_MS`, `NODE_ENV` (production refuses Wikimedia calls without a contact) (and one `GATEWAY_KEY_<API>` per key-based API, named in `DEPLOYMENT.md`).
Details and defaults: `README.md` and `DEPLOYMENT.md`.

## Working rules that have paid for themselves

1. **Evidence over assumption.** Say `NOT VERIFIED` / `NOT AVAILABLE` / `BLOCKED`; never write "works" without a run behind it. Do not
   invent numbers (no ROI, savings, benchmarks). A default that nobody measured is not set (the rate limit; `AB_FSYNC` was measured, then decided by the owner and is on in the manifests): it is an owner decision, and `PERFORMANCE.md` holds the measurements to decide with. Measure before believing a limit: the A/B module's memory use was estimated nowhere and turned out to cross the manifests' memory limit at a file size far below the warning threshold.
2. **Break it on purpose.** For every guard, test or check you add, break exactly the thing it protects and confirm the check fails, then restore.
   Controls can be wrong too: one mutation turned out to be behaviourally identical, another left a second passing case in place.
3. **Read the real logs**, not the green tick. The first CI run of a probe change failed in the probe script itself.
4. **Shell scripts under `pipefail`:** never `cmd | grep -q`. `grep -q` exits on the first match, `cmd` gets SIGPIPE (141) while still writing and the
   pipeline fails although the match was found. Capture into a variable, then match it (a config test forbids the pattern).
5. **Tests that open sockets:** read the response (`resume()`), or the socket never emits `close` and Jest hangs. Give every such test a failsafe.
6. **Docs move with code.** Every env var the code reads is documented and tested; ROADMAP rows cite evidence (run id, command).
7. **Secrets:** never print, commit or log values (variable names only).
8. **After every step, update the record**: the documents the step changed (`docs/README.md` is the index), a row in `docs/BUILD-HISTORY.md`, `ROADMAP.md`, `CHANGELOG.md`, the status table in `skills/omniroute-mcp/SKILL.md`, then `node scripts/skill.js sync` (the global skill carries copies of the documents; `npm test` fails when they differ). Install guide for Claude Desktop: `docs/INSTALL-CLAUDE-DESKTOP.md`.

## Environment gotchas (authoring sandbox)

- Reachable: npm, PyPI, the Go module proxy. **Not reachable:** GitHub release pages, Docker Hub's registry, other repositories, and the gateway's providers (`ENOTFOUND`). The web fetcher reached `github.com` but not `coingecko.com` or Wikimedia's sites (2026-10-10); web search works, but its answers are summaries: terms found that way are leads for the owner, never a sign-off. No Docker daemon,
  no cluster. So scanners or images cannot be looked up and pinned from there: that needs the owner's approval to look them up.
- `go install pkg@version` does not work for Prometheus (`replace` directives); `scripts/install-promtool.sh` documents the workaround.
- GitHub-hosted runners were starved on 2026-10-05 (queued jobs cancelled after 15 minutes, no step run); retry once, do not change the workflow for it. On 2026-10-14 the `prometheus` job failed once downloading the Go toolchain from `proxy.golang.org` (a stream error, before any rule was checked) and passed on one re-run: the same rule.
- Windows: `type-check`, `lint`, `build` work in PowerShell; `test` runs, but 8 tests in four suites (`ab-boundaries`, `entry-point`, `mcpb`, `scripts`: signals, file modes, directory fsync, promtool) fail on Windows, on unchanged `main` too (reported from the owner's machine on 2026-10-09 by the session that made PR #43; not reproduced here, no Windows), so CI on Linux is the test run that counts; the `*.sh` scripts need Git Bash or WSL; LF line endings are forced by `.gitattributes`.

## Resume point

`ROADMAP.md` lists what is done, what is blocked on the owner (cluster, image scanner choice, rate limit, security contact) and the
unscheduled backlog. Start from its "Open decisions" and "Backlog".

Account handover (2026-10-09): the first Claude Pro account reached its weekly limit and the work continued under the second; the handover is complete (`ROADMAP.md`, "Session continuity"; the full account in `docs/BUILD-HISTORY.md`, section 4).
