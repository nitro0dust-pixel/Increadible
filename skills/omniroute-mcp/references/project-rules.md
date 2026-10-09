<!-- Copy of CLAUDE.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Increadible: context for Claude sessions

Read this first, then `ROADMAP.md` (status, plan, open decisions: the source of truth for *what is done*),
`DEPLOYMENT.md` (how it runs), `PERFORMANCE.md` (what has been measured, and what the numbers do not say), `COMPANIONS.md` (third-party tools that run beside this server, never inside it) and `GATEWAY.md` (the decision record for a universal API gateway: researched, proposed, not built, waiting on the owner); `AUDIT.md` is the account of the code audit: what was found, fixed and left open). The index of every document is `docs/README.md`; `CONTRIBUTING.md` and `SECURITY.md` cover how to change the code and its security posture; the global skill `skills/omniroute-mcp/` carries all of it into any Claude session. This file holds the stable facts and the working rules; it deliberately holds no test
counts, no commit hashes and no status, because those go stale with every PR.

## What this is

One MCP server (stdio and HTTP) serving three components we wrote: Routing Plugins (#7), A/B Testing (#8) and API
Gateway (#9, **mock data by default**, with opt-in live calls that have never run against a real provider). `features/01-06` are vendored third-party submodules that are **not integrated or
tested here**. Nothing is deployed beyond a local rehearsal; no cost saving has been measured (the old percentages were
targets, not results).

## Repository and branch workflow

- Repo `nitro0dust-pixel/Increadible` (private). **PRs target `main`, but the repository's default branch is
  `claude/nice-keller-aoooos`** (owner decision pending, see `ROADMAP.md`; Dependabot is inactive until it is `main`).
- Work happens on `claude/nice-keller-aoooos`, one PR at a time, squash-merged into `main`. After a squash merge the
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
| `npm run mcpb` (`node scripts/mcpb.js build`, `inspect FILE`, `problems`) | build the one-click Claude Desktop package `dist/mcpb/increadible-<version>.mcpb` from the committed sources (`mcpb/manifest.json`; the zip writer is `scripts/zip.js`); check a bundle; check the manifest against `package.json`. Needs `npm ci` first. Claude Desktop accepting the file is NOT VERIFIED |
| `node scripts/skill.js sync`, `check`, `package`, `install` | keep the global skill `skills/omniroute-mcp/` in step with the documents; zip it for upload; install it for Claude Code |
| `npm run verify` | type-check, lint, tests (fails if fewer suites ran than `tests/*.test.ts` files), build, smoke, plus Docker build and `promtool` when present; prints the commit and tree it tested and reports `NOT AVAILABLE` for what it cannot run |
| `bash scripts/cleanroom.sh [commit]` | `verify` on a `git archive` of `HEAD` (or the commit given) after `npm ci`: only what is committed, nothing from the working copy. Use it for any claim of the form "it passes on commit X" |
| `bash scripts/probe-image.sh <image>` | the image the way a deployment runs it: needs Docker, curl, jq. **Only CI has a Docker daemon**; locally it can be tried against a stubbed `docker`, which proves the script's logic but not the image |
| `npm run loadtest`, `npm run capacity` | per-tool throughput and latency; A/B data size against restart, memory and query cost (not in CI: shared runners are too noisy; `smoke.sh` only checks they still run). Use an idle machine and read `PERFORMANCE.md` first |
| `node scripts/make-ab-data.js --file <f> --measurements <N>` | writes an A/B data file of N measurements (fast, no server); smoke and the image probe use it to start on a large file |
| `PROMTOOL=<bin> bash scripts/check-prometheus.sh` | `promtool check rules` and `test rules` for `k8s/monitoring.yaml` (`scripts/install-promtool.sh <dir>` builds the pinned promtool) |

CI (`.github/workflows/ci-cd.yml`): `quality`, `test`, `security` (audit, SBOM, secret scan), `prometheus` run in parallel;
`docker` (build, probe, push to GHCR on `main`) needs the first three; `verify-published-image` (main only) pulls the pushed
image by digest and probes it again. The package `ghcr.io/nitro0dust-pixel/increadible` is private.

## Architecture in one screen

- `src/index.ts`: transports. stdio (newline-delimited JSON-RPC) or HTTP (`/health`, `/ready`, `/metrics`, `POST /mcp`, stateless);
  timeouts, optional rate limit, drain and hard-deadline shutdown, refusal to start open beyond loopback.
- `src/server.ts`: the JSON-RPC handler, tool dispatch, metrics (counters, tool-latency histogram). A throwing tool becomes a tool
  error; the handler never throws.
- `features/07..09/src/mcp-server.ts`: the three modules. A/B data is an append-only JSON-lines file (`AB_DATA_FILE`) with a
  single-writer lock file, crash recovery, optional fsync and a growth warning; it is never compacted. In memory the A/B module keeps
  only counts and a running mean and variance per variant and metric (so memory and the cost of a results call do not grow with the
  data), and replays the file in chunks at startup. `tests/ab-golden.test.ts` holds it to the answers of the earlier array-based version.
- `k8s/` manifests (one replica, `Recreate`, an RWO volume: the data file has exactly one writer), `monitoring/` alert unit tests,
  `Dockerfile` (Node 24, non-root).
- Node: one major (24) across the Dockerfile, CI and `@types/node`, enforced by a test; `engines` is `>=22`.

Configuration (names only; values come from the environment, never commit them): `PORT`, `HOST`, `AUTH_TOKEN`,
`ALLOW_UNAUTHENTICATED`, `RULES_FILE`, `EXPERIMENTS_FILE`, `AB_DATA_FILE`, `AB_FSYNC`, `AB_LAZY_OPEN`, `AB_DATA_WARN_BYTES`,
`HTTP_HEADERS_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `RATE_LIMIT_PER_MINUTE`, `SHUTDOWN_DRAIN_MS`, `SHUTDOWN_TIMEOUT_MS`,
`GATEWAY_LIVE_APIS`, `GATEWAY_TIMEOUT_MS`, `GATEWAY_MAX_RESPONSE_BYTES`, `GATEWAY_USER_AGENT` (and one `GATEWAY_KEY_<API>` per key-based API, named in `DEPLOYMENT.md`).
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

- Reachable: npm, PyPI, the Go module proxy. **Not reachable:** GitHub release pages, Docker Hub's registry, other repositories. No Docker daemon,
  no cluster. So scanners or images cannot be looked up and pinned from there: that needs the owner's approval to look them up.
- `go install pkg@version` does not work for Prometheus (`replace` directives); `scripts/install-promtool.sh` documents the workaround.
- GitHub-hosted runners were starved on 2026-10-05 (queued jobs cancelled after 15 minutes, no step run); retry once, do not change the workflow for it.
- Windows: `type-check`, `lint`, `test`, `build` work in PowerShell; the `*.sh` scripts need Git Bash or WSL; LF line endings are forced by `.gitattributes`.

## Resume point

`ROADMAP.md` lists what is done, what is blocked on the owner (cluster, scanner choice, default branch, rate limit, release tag) and the
unscheduled backlog. Start from its "Open decisions" and "Backlog".
