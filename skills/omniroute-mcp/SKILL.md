---
name: omniroute-mcp
description: "Work on, verify, install and deploy the Increadible MCP server (package increadible, called omniroute-mcp here): routing rules, A/B testing and an API gateway served over stdio and HTTP, beside the vendored third-party OmniRoute and other projects under features/. Use when asked to continue the build, add or change a tool, audit or test it, update the roadmap or docs, build or install it in Claude Desktop (claude_desktop_config.json or an .mcpb package), run it in Docker or Kubernetes, or explain what has been done and what is left. Carries the full build history, the working rules, the verified commands, the Claude Desktop install steps and the update protocol to run after every step."
---

# omniroute-mcp: the Increadible MCP server, its history, and how to carry on

## What this is, and a naming warning

| Name | What it is |
|---|---|
| **Increadible** (`increadible`) | The repository `nitro0dust-pixel/Increadible` and the MCP server built in it: **Routing Plugins (#7)**, **A/B Testing (#8)** and an **API Gateway (#9)**, 13 tools in all, over stdio (Claude Desktop) and HTTP (containers). All our code. |
| **OmniRoute** | A **third-party** project vendored as a git submodule at `features/01-omniroute`. **Not integrated or tested here.** It is not what we built. |
| `omniroute-mcp` | The name of this skill, chosen by the owner. It covers the whole repository. |

Features #1 to #6 (`features/01` to `06`) are third-party submodules. They run beside the server, never inside it (`references/roadmap.md`, COMPANIONS in the repository).

## Status at a glance (updated after every step; the date is UTC)

| Item | State |
|---|---|
| Last recorded: 2026-10-14 | `main` includes PR #64 (gated catalog: the registry as data, all nine APIs `candidate`; probes, recorder and contract tests for the four keyless APIs, recorded on the owner's PC on 2026-10-10, replayed in CI and named in their gate records; a per-API rate limit, none set; an egress allowlist, never applied to a cluster; 2,032 seed candidates from the public-apis list, none callable); releases **`v1.0.4`** (tag on `73c5f4d`, 2026-10-14), `v1.0.3` (tag on `916206f`, 2026-10-10) and `v1.0.2`. **First live calls to real providers** (coingecko, hackernews, wikipedia, wikidata, one each, from the owner's Claude Desktop and from Railway). **Option A approved** (2026-10-10). One working session; it keeps the records |
| Last merged PR | #64 |
| Open PR / handover | the records of PR #64 and the tag `v1.0.4` (CHANGELOG `[1.0.4]`), and three dead lint directives removed from a test. Open from the release: whether Contact for providers reaches the server in Claude Desktop (`user_agent_has_contact` read `false`; the server itself reads a valid email address correctly). Still waiting on the owner: sign-offs of URLs, auth and terms (`references/gated-catalog.md` section 11, approved by no one); per-API limits from the official pages (a default of 5 a minute meanwhile); NewsAPI (free plan forbids production) and keyless CoinGecko ("not for production"). Railway still runs `916206f` (merges do not deploy). Handover from `hsharma.gxi@gmail.com` (weekly limit reached on 2026-10-09) to `ashiurvi786@gmail.com`: **complete** |
| Tests | `main` at PR #64: 31 suites, 991 passed, 6 todo; CI green, `main` run 38506367869 (pull-by-digest probe read) |
| Audit | done: `references/audit.md` (7 parts; mutation testing 78.7% to 90.0%, every remaining mutant read) |
| Container image | built, probed, pushed to GHCR (private), pulled back by digest and probed again, in CI |
| Production / cluster | **Railway private rehearsal: stages 1 and 2 done 2026-10-10** (`references/deployment.md`, "Railway"): health, 401 without the token, 13 tools, A/B data survives a restart and a redeploy, the four keyless APIs live from Railway (DNS log: only their hosts); runs as root there; the commit pin did not hold for a variable-triggered redeploy. Stage 3 (a client end to end) needs the owner's approval. No production |
| Installed in the owner's Claude Desktop | **YES: version 1.0.4 installed and answers** (owner, Windows, 2026-10-14: built on the owner's PC from `73c5f4d`, SHA-256 `24ee7a6f...`, equal to CI; `get_api_stats` answered with the 1.0.4 fields; Contact for providers not yet seen by the server). **Version 1.0.3 made the first live calls** (coingecko, hackernews, wikipedia, wikidata, one each, owner, Windows, 2026-10-10); **version 1.0.2 answers** (owner, Windows, 2026-10-09): built locally (SHA-256 `3594d5fd...`), installed, and `get_api_stats` answered in a chat; the app accepted the 1.0.2 tool list. 1.0.0 had installed but never answered. Also working in the app: `discover_apis`, `create_experiment` (duplicate refused), `assign_variant`, `get_experiment_results`, and `record_metric`'s errors; an experiment's definition survives a restart. Not yet verified: a recorded measurement surviving a restart; 7 tools not exercised in the app |
| One-click `.mcpb` package | **merged** (PR #32, fixed by PR #34 as version 1.0.1, SHA-256 `bc24224c...`; schemas added by PR #36 as version 1.0.2, SHA-256 `3594d5fd...`): `npm run mcpb`, or the CI artifact `increadible-mcpb`; manifest accepted by the vendor's validator; started from the unpacked bundle in a test; CI-built bytes equal the sandbox build. **Claude Desktop installs and runs version 1.0.2: verified** by the owner on Windows, 2026-10-09 (`references/install-claude-desktop.md`, section 5.4) |
| Owner decisions open | the gated catalog's sign-offs (pinned URL, auth class and terms of each API; nothing is approved); per-API rate limits from the official pages (a default of 5 a minute is set meanwhile); NewsAPI's place (its free plan forbids production) and keyless CoinGecko ("not for production"); where API keys live (`GATEWAY.md`); code signing; security contact; image scanner; the server-wide rate limit; latency alert threshold; Railway stage 3. **Decided 2026-10-12:** CoinCap deferred; bounded retries with HTTP 429 and Retry-After handled (replaces "no retries"); Wikimedia User-Agent: name/version and a real contact, a warning in development, a refusal in production. **Decided 2026-10-10:** option A, the gated catalog; gate status read-only in `get_api_stats`; the first batch from Cryptocurrency; Railway as the deployment target (stages 1 and 2 done). **Decided 2026-10-09:** license proprietary (`UNLICENSED`) and the secret scanner pinned by digest (PR #39); default branch `main`; release `v1.0.2` |

## Operating rules (non-negotiable)

1. **Evidence over assumption.** Detect, verify, understand, plan, checkpoint, execute, validate, document. Say `NOT VERIFIED`, `NOT AVAILABLE`, `BLOCKED` or `REQUIRES MANUAL VERIFICATION`; never write "works" or "deployed" without a run behind it. Never invent a number (no ROI, savings or benchmark). The old percentages were targets, not results.
2. **Owner approval boundary.** Local work, branches, tests, builds, commits, pushes to the work branch and pull requests are routine. Merging needs CI green on the exact head and the real logs read. **Production deployment, cluster changes, DNS/IAM/billing, rotating credentials, deleting remote branches, a license or any owner decision are never taken without explicit approval** (print `GO / NO-GO REQUIRED` with what, where, why, impact, rollback, risks).
3. **Git safety.** One repository, one trust boundary. Never force-push or rewrite history. After a squash merge: `git fetch origin main && git merge origin/main`, push as a fast-forward. The default branch is `main` (owner, 2026-10-09); pull requests target it.
4. **Secrets: names only, never values**, in code, documents, logs, pull requests and this skill.
5. **No new major dependency, framework, runtime, database, scanner or service without** writing down why, the alternatives, the security, maintenance and operational impact, and getting approval. A tool run in a scratch copy (StrykerJS was) does not touch the repository's dependencies.
6. **Break it on purpose.** For every guard or test added, break exactly what it protects, confirm it fails, restore. Controls can be wrong too.
7. **Read the real logs**, not the green tick (Tests summary, `probe: OK`, `prometheus: OK`, the pull-by-digest job on `main`).
8. **Shell under `pipefail`:** never `cmd | grep -q`; capture into a variable, then match. Sockets in tests: read the response and add a failsafe.
9. **Docs move with code**, and **the skill moves with the docs** (update protocol below).
10. Report in tables with statuses (`PASS`, `DEGRADED`, `FAIL`, `NOT AVAILABLE`, `NOT VERIFIED`, `BLOCKED`); show times in UTC and IST; be direct.

## Commands that exist and were verified

| Command | What it checks |
|---|---|
| `npm ci`, `npm run type-check`, `npm run lint`, `npm test`, `npm run build` | install from the lockfile; `tsc --noEmit`; ESLint 10; Jest over `tests/` (`-- --coverage`); compile to `dist/` |
| `npm run smoke` | `scripts/smoke.sh`: real processes over stdio and HTTP |
| `npm run verify` | all of the above, plus Docker build and `promtool` when present; prints the commit and tree it tested |
| `bash scripts/cleanroom.sh [commit]` | `verify` on a `git archive` of a commit after `npm ci`: only what is committed. Use for any "it passes on commit X" claim |
| `bash scripts/probe-image.sh <image>` | the image as a deployment runs it (needs Docker; only CI has a daemon) |
| `node scripts/skill.js` with `sync`, `check`, `package` or `install` | keep this skill in step with the documents; zip it for upload; install it globally |
| `npm run mcpb` (`node scripts/mcpb.js` with `build`, `inspect FILE` or `problems`) | build the one-click Claude Desktop package `dist/mcpb/increadible-<version>.mcpb` from the committed sources (needs `npm ci` first); check a bundle; check `mcpb/manifest.json` against `package.json` |
| `node scripts/record-contracts.js [--where M] [api ...]` | after `npm run build`, with `GATEWAY_USER_AGENT` set: sends each keyless API's health probe through the gateway and writes the answer to `tests/fixtures/contracts/` (gate 6). Needs a machine that reaches the providers: the owner's PC, not the sandbox |
| `node scripts/seed-candidates.js`, `node scripts/candidate-report.js` | the candidate store from the public-apis list (2,032 entries, read by no server code); the generated report `docs/GATEWAY-CANDIDATES.md` (a test fails while it is stale) |
| `node scripts/make-ab-data.js --file F --measurements N` | a large A/B data file for smoke and capacity checks |

Node 24 in the image and CI; `engines` is `>=22`. The authoring sandbox has no Docker daemon and no cluster, and cannot reach GitHub release pages or Docker Hub. Its web fetcher reached `github.com` but not `coingecko.com` or Wikimedia's sites (2026-10-10); a web search works there, but its answers are summaries, so a provider's terms found that way are leads for the owner to read, never a sign-off.

## Where things are

| Path | Content |
|---|---|
| `src/index.ts`, `src/server.ts` | transports; the JSON-RPC handler and metrics |
| `features/07-routing-plugins`, `08-ab-testing`, `09-api-gateway` | the three components (`src/mcp-server.ts`; the gateway also has `live.ts`) |
| `features/09-api-gateway/src/catalog.ts`, `probes.ts` | the gated catalog: one gate record per API (status, pinned URL, auth, terms, probe, contract test, live evidence) and the probes' success checks |
| `features/09-api-gateway/data/` | the candidate store and the gate proposals: seed material, read by no server code |
| `tests/fixtures/contracts/` | real answers of the keyless four's probes (recorded by the owner, 2026-10-10), replayed in CI |
| `tests/` | Jest suites; `config.test.ts` holds the documents to the code; `tool-contract.test.ts` pins the 13 tool schemas |
| `k8s/`, `monitoring/`, `Dockerfile`, `.github/workflows/ci-cd.yml` | cluster manifests (never applied), alert rules (promtool-tested), image, CI |
| `docs/`, `ROADMAP.md`, `CHANGELOG.md`, `AUDIT.md`, ... | the document set; `docs/README.md` is the index |
| `mcpb/manifest.json`, `scripts/mcpb.js`, `scripts/zip.js` | the Claude Desktop package: its manifest, the build and check script, the zip writer (shared with `scripts/skill.js`) |
| `skills/omniroute-mcp/` | this skill (`references/` are synced copies; never edit them) |

## Deploy to Claude Desktop (short form; the full guide is `references/install-claude-desktop.md`)

1. Prerequisites: Claude Desktop (macOS or Windows), Git, Node 22 or newer.
2. `git clone` the repository, then `npm ci`, `npm run build`, `npm run smoke`.
3. Pick a data folder; **every path in the config must be absolute**.
4. Settings, Developer, Edit Config: add `increadible` under `mcpServers` with `command` = full path of `node`, `args` = the absolute path of `dist/src/index.js`, and `env` with `RULES_FILE` and `AB_DATA_FILE` (and `AB_FSYNC=1` if wanted).
5. Quit Claude Desktop completely, start it, check Settings, Developer shows it running, and that 13 tools are listed.
6. Without `AB_DATA_FILE` all A/B data is lost at every restart. The gateway answers mock data unless `GATEWAY_LIVE_APIS` is set (in the package from 1.0.3: the setting Live APIs; the four keyless APIs answered live from Claude Desktop on 2026-10-10). The one-click route: `npm run mcpb` builds `dist/mcpb/increadible-<version>.mcpb`; double-click it (or drag it into Claude Desktop, or Settings, Extensions, Advanced settings, Install Extension), choose a **Data folder**, leave the durable-writes setting on. It needs no Node on the PATH to run. Details and what was verified: Path A in the install guide.

These steps are Path B (the config file): verified only up to the handshake, **NOT VERIFIED** inside Claude Desktop. Path A (the `.mcpb` package) is verified in the app for version 1.0.2 (owner, Windows, 2026-10-09).

## How to continue the build

0. **Handover (complete):** the work moved from `hsharma.gxi@gmail.com` to `ashiurvi786@gmail.com` on 2026-10-09 (weekly limit of the first account). A new session starts from the committed files, not from a previous conversation: read `references/roadmap.md` ("Open decisions", "Backlog") first.
1. Read `references/roadmap.md` ("Open decisions", "Backlog") and the last rows of `references/build-history.md`.
2. Pick the next step that is **not blocked on the owner** (a blocked step is listed, not started). State the plan in phases before deep work; keep each pull request one reviewable change.
3. Verify the baseline (`git status`, branch, `npm run verify` or a clean room), work on the session's work branch (historically `claude/nice-keller-aoooos`; a cloud session is given its own), commit in logical pieces, open a pull request against `main`, read the real CI logs, merge when green **and the owner has approved**, then sync the branch with `main`.
4. Never present a recommendation as functionality; label projections as projections.

## Update protocol: after every step, without exception

1. Update the documents the step changed (`docs/README.md` lists them) and add a row to `docs/BUILD-HISTORY.md`.
2. Update `ROADMAP.md` (status, with evidence: PR, run id, command) and `CHANGELOG.md` (flag behaviour changes).
3. Update the **Status at a glance** table above (date, last merged PR, tests, what is verified).
4. Run `node scripts/skill.js sync`, then `node scripts/skill.js check`, then `npm test` (it fails when a document and the skill differ).
5. A pull request's own row in `docs/BUILD-HISTORY.md` can only be written after it has merged (merge time, CI run): the first commit of the next step adds it, with the matching `ROADMAP.md` and `CHANGELOG.md` lines and this status table. A pull request that only records the previous one gets no row.
6. Re-install the skill where it is used: `node scripts/skill.js install` (Claude Code, global) or upload the zip from `node scripts/skill.js package` (claude.ai / Claude Desktop).

## Installing this skill

| Where | How |
|---|---|
| Claude Code, every project (global) | `node scripts/skill.js install` copies it to `~/.claude/skills/omniroute-mcp/` (Windows: `%USERPROFILE%\.claude\skills\omniroute-mcp\`), or copy the folder by hand |
| claude.ai and Claude Desktop | `node scripts/skill.js package`, then upload `dist/skill/omniroute-mcp.zip` in the app's settings (the menu is named Features or Capabilities, depending on the version; needs a plan with code execution enabled). Custom skills are per user |

## References: read only what the task needs

| File | Read it when |
|---|---|
| `references/build-history.md` | you need the order of events, or to add a step |
| `references/roadmap.md` | status, sprints, gates, backlog, open decisions (large: read a section, not the whole file) |
| `references/install-claude-desktop.md` | installing or verifying in Claude Desktop |
| `references/troubleshooting.md` | a message, a failure, an empty result |
| `references/architecture.md` | changing how components fit, or judging a change |
| `references/project-rules.md` | the repository's own working rules and environment gotchas (CLAUDE.md) |
| `references/contributing.md` | branches, checks, pull requests |
| `references/deployment.md` | the image, HTTP mode, Kubernetes, monitoring, secrets |
| `references/audit.md` | what was found, fixed and left open; the mutation-testing method |
| `references/security.md` | security posture, gaps, reporting |
| `references/gateway.md` | the universal-gateway decision (option A approved 2026-10-10; built step by step in `references/gated-catalog.md`) |
| `references/releasing.md` | making a release: version bump, the package's SHA-256 from two builds, the owner's tag, the check |
| `references/gated-catalog.md` | building the gated catalog: the gates, the order of work, what is done, the first batch (section 9) and the terms found (section 10) |
| `references/using-the-gateway.md` | calling the gateway from a chat: prompts, mock versus live answers, `get_api_stats` |
