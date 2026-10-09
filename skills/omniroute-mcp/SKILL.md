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
| Last recorded: 2026-10-09 | `main` includes PR #32 (the one-click Claude Desktop package) after PR #31 (this skill and the documentation set). Nothing is in flight; the install on the owner's machine is the next thing to settle |
| Last merged PR | #32 |
| Tests | `main` at PR #32: 21 suites, 773 passed, 6 todo; CI green, run 37870809491 (all six jobs, pull-by-digest probe read) |
| Audit | done: `references/audit.md` (7 parts; mutation testing 78.7% to 90.0%, every remaining mutant read) |
| Container image | built, probed, pushed to GHCR (private), pulled back by digest and probed again, in CI |
| Production / cluster | **NOT DONE**: needs the owner's explicit approval and a cluster target |
| Installed in the owner's Claude Desktop | **NOT VERIFIED**: only the owner can do it on their machine; steps in `references/install-claude-desktop.md` |
| One-click `.mcpb` package | **merged** (PR #32): `npm run mcpb`, or the CI artifact `increadible-mcpb`; manifest accepted by the vendor's validator; started from the unpacked bundle in a test; CI-built bytes equal the sandbox build. **Claude Desktop installing it: NOT VERIFIED** (step C in `references/build-history.md`) |
| Owner decisions open | install the package in Claude Desktop and report back; code signing; license and holder; gateway direction; scanner pin policy; security contact; cluster target; image scanner; default branch to `main`; rate limit; latency alert threshold; release tag |

## Operating rules (non-negotiable)

1. **Evidence over assumption.** Detect, verify, understand, plan, checkpoint, execute, validate, document. Say `NOT VERIFIED`, `NOT AVAILABLE`, `BLOCKED` or `REQUIRES MANUAL VERIFICATION`; never write "works" or "deployed" without a run behind it. Never invent a number (no ROI, savings or benchmark). The old percentages were targets, not results.
2. **Owner approval boundary.** Local work, branches, tests, builds, commits, pushes to the work branch and pull requests are routine. Merging needs CI green on the exact head and the real logs read. **Production deployment, cluster changes, DNS/IAM/billing, rotating credentials, deleting remote branches, a license or any owner decision are never taken without explicit approval** (print `GO / NO-GO REQUIRED` with what, where, why, impact, rollback, risks).
3. **Git safety.** One repository, one trust boundary. Never force-push or rewrite history. After a squash merge: `git fetch origin main && git merge origin/main`, push as a fast-forward. The default branch is currently `claude/nice-keller-aoooos`, not `main` (owner decision pending).
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

Node 24 in the image and CI; `engines` is `>=22`. The authoring sandbox has no Docker daemon and no cluster, and cannot reach GitHub release pages or Docker Hub.

## Where things are

| Path | Content |
|---|---|
| `src/index.ts`, `src/server.ts` | transports; the JSON-RPC handler and metrics |
| `features/07-routing-plugins`, `08-ab-testing`, `09-api-gateway` | the three components (`src/mcp-server.ts`; the gateway also has `live.ts`) |
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
6. Without `AB_DATA_FILE` all A/B data is lost at every restart. The gateway answers mock data unless `GATEWAY_LIVE_APIS` is set. The one-click route: `npm run mcpb` builds `dist/mcpb/increadible-<version>.mcpb`; double-click it (or drag it into Claude Desktop, or Settings, Extensions, Advanced settings, Install Extension), choose a **Data folder**, leave the durable-writes setting on. It needs no Node on the PATH to run. Details and what was verified: Path A in the install guide.

Only the owner can do and confirm steps 4 and 5. Until they report back, installation is `NOT VERIFIED`.

## How to continue the build

1. Read `references/roadmap.md` ("Open decisions", "Backlog") and the last rows of `references/build-history.md`.
2. Pick the next step that is **not blocked on the owner** (a blocked step is listed, not started). State the plan in phases before deep work; keep each pull request one reviewable change.
3. Verify the baseline (`git status`, branch, `npm run verify` or a clean room), work on `claude/nice-keller-aoooos`, commit in logical pieces, open a ready pull request against `main`, read the real CI logs, merge when green, then sync the branch with `main`.
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
| `references/gateway.md` | the proposed universal-gateway decision (waiting on the owner) |
