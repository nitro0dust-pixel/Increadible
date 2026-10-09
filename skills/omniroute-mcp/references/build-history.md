<!-- Copy of docs/BUILD-HISTORY.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Build history: every step, from the first commit to now

This is the canonical record of how the repository was built, in order. It is kept in step with `ROADMAP.md` (status and evidence),
`CHANGELOG.md` (what changed for an operator) and `AUDIT.md` (the audit in detail), and it is copied into the global skill
(`skills/omniroute-mcp/references/build-history.md`) by `node scripts/skill.js sync`; a test fails when the two differ.
Times are UTC with IST (UTC+5:30) in brackets, from git. A step is DONE only with evidence; `NOT VERIFIED` stays until something was run.

**Naming.** The server built here is called `increadible` (package `increadible`, MCP server name `increadible`). "OmniRoute" is
the vendored third-party project in `features/01-omniroute` (a git submodule, **not integrated or tested here**). The global
skill is called `omniroute-mcp` and covers this whole repository.

## 1. Before the first pull request (5 Oct 2026)

| When | Commit | What happened | Outcome |
|---|---|---|---|
| 2026-10-05 13:34 UTC (19:04 IST) | `d1a88e8` to `b3867ed` | OmniRoute added as Feature #1, then converted to a git submodule | vendored, third-party |
| 2026-10-05 13:38 to 13:46 UTC (19:08 to 19:16 IST) | `280f77e` to `adcfe62` | Features #2 (claude-mem), #3 (Headroom, later replaced by token-optimizer-mcp), #4 (gstack) added as submodules with integration guides | vendored, third-party, not integrated |
| 2026-10-05 14:05 to 14:27 UTC (19:35 to 19:57 IST) | `c877df6` to `8eee649` | Features #3 swapped, #5 to #7 added, the routing plugins and the A/B testing framework (#7, #8) written | first code of ours |
| 2026-10-05 14:59 to 15:04 UTC (20:29 to 20:34 IST) | `67e7498` to `c5cd046` | Feature #9, the API gateway, and the first MCP servers for #7 to #9 | first runnable shape |
| 2026-10-05 15:11 to 15:37 UTC (20:41 to 21:07 IST) | `b8423c0` to `072bc8c` | End-to-end tests, deployment guide, CI/CD and "final" reports | the reports said tests, sign-offs, load tests and scans were done; the tests checked hardcoded fixtures and the rest never ran (`ROADMAP.md`, item 1 of "What has been done") |
| 2026-10-05 15:55 to 16:24 UTC (21:25 to 21:54 IST) | `7fc3728` to `bb3d491` | Local deployment test setup, build and Docker fixes, fabricated documents replaced by verified ones | the bridge into PR #2 |

## 2. Pull requests, in the order they were merged into `main`

| # | Merged (UTC, IST) | PR | What | Evidence / outcome |
|---|---|---|---|---|
| 1 | 2026-10-05 16:31 UTC (22:01 IST) | [#2](https://github.com/nitro0dust-pixel/Increadible/pull/2) | Repo-wide debug: a working build, a runnable MCP server (stdio and HTTP with health, metrics and auth), a real Welch t-test instead of hardcoded A/B numbers, routing and gateway bug fixes, real tests, Dockerfile / Kubernetes / CI rewritten to match the code, fabricated documents removed | Build, tests and CI green; the earlier "production-ready" reports were not true and were replaced |
| 2 | 2026-10-05 17:21 UTC (22:51 IST) | [#3](https://github.com/nitro0dust-pixel/Increadible/pull/3) | A/B persistence: an append-only log (`AB_DATA_FILE`) with crash recovery; a persistent volume in Kubernetes | Tests; crash-recovery cases |
| 3 | 2026-10-05 18:20 UTC (23:50 IST) | [#4](https://github.com/nitro0dust-pixel/Increadible/pull/4) | CI pulls the image it pushed to GHCR back by digest and probes that copy | `main` run, pull-by-digest job |
| 4 | 2026-10-05 18:46 UTC (00:16 IST) | [#5](https://github.com/nitro0dust-pixel/Increadible/pull/5) | Optional `ghcr-pull` image-pull secret and a private-image deployment runbook | Config tests |
| 5 | 2026-10-05 19:03 UTC (00:33 IST) | [#6](https://github.com/nitro0dust-pixel/Increadible/pull/6) | `ROADMAP.md`: status, sprints, gates, backlog and open decisions | Doc guard tests |
| 6 | 2026-10-05 20:07 UTC (01:37 IST) | [#7](https://github.com/nitro0dust-pixel/Increadible/pull/7) | Windows-friendly local verification: cross-platform build clean step, LF line endings forced by `.gitattributes` | Not yet run on a real Windows machine (NOT VERIFIED) |
| 7 | 2026-10-05 21:34 UTC (03:04 IST) | [#8](https://github.com/nitro0dust-pixel/Increadible/pull/8) | Runtime upgrade from Node 20 (end of life) to Node 24 LTS; one Node major across image, CI and `@types/node`, enforced by a test | CI and image probe |
| 8 | 2026-10-05 23:51 UTC (05:21 IST) | [#9](https://github.com/nitro0dust-pixel/Increadible/pull/9) | CycloneDX SBOM of the production npm tree, SBOM attestation on the image, Dependabot config | `security` job; Dependabot inactive until the default branch is `main` |
| 9 | 2026-10-06 00:16 UTC (05:46 IST) | [#10](https://github.com/nitro0dust-pixel/Increadible/pull/10) | A/B data file safety: single-writer lock file, optional fsync (`AB_FSYNC`), growth warning (`AB_DATA_WARN_BYTES`), signal handling in stdio mode | Real-container probe passed after a probe-script bug (`grep -q` under `pipefail`) was found and fixed |
| 10 | 2026-10-06 01:06 UTC (06:36 IST) | [#11](https://github.com/nitro0dust-pixel/Increadible/pull/11) | HTTP hardening: a throwing tool can no longer end the process; graceful shutdown; receive timeouts; refusal to start open beyond loopback; optional global rate limit (off) | Real-daemon probe and `main` run passed |
| 11 | 2026-10-06 01:31 UTC (07:01 IST) | [#12](https://github.com/nitro0dust-pixel/Increadible/pull/12) | Tool-call latency histogram, 401 counter, alert rules validated with `promtool` (built from a pinned, checksummed release) | New `prometheus` CI job passed |
| 12 | 2026-10-06 01:44 UTC (07:14 IST) | [#13](https://github.com/nitro0dust-pixel/Increadible/pull/13) | `CLAUDE.md` (handoff) and `CHANGELOG.md`, with tests that fail when they name something that does not exist | Doc guard tests |
| 13 | 2026-10-06 02:02 UTC (07:32 IST) | [#14](https://github.com/nitro0dust-pixel/Increadible/pull/14) | Measured baselines: `scripts/loadtest.js`, `scripts/capacity.js`, `PERFORMANCE.md` | One safe manifest correction found by the measurements |
| 14 | 2026-10-06 05:23 UTC (10:53 IST) | [#15](https://github.com/nitro0dust-pixel/Increadible/pull/15) | A/B module keeps running aggregates instead of every measurement; chunked replay; the file is unchanged | Golden master of 120 datasets, 5 020 differential experiments, 3 000 damaged data files |
| 15 | 2026-10-06 06:15 UTC (11:45 IST) | [#16](https://github.com/nitro0dust-pixel/Increadible/pull/16) | `startupProbe` in both manifests, tied by a test to the volume size and CPU limit; replay time measured | 5 of 5 mutations caught; not applied to a cluster |
| 16 | 2026-10-06 06:29 UTC (11:59 IST) | [#17](https://github.com/nitro0dust-pixel/Increadible/pull/17) | Event-loop delay histogram and `IncreadibleEventLoopBlocked` alert | Smoke and container probe freeze the process and see it |
| 17 | 2026-10-07 19:03 UTC (00:33 IST) | [#18](https://github.com/nitro0dust-pixel/Increadible/pull/18) | `AB_FSYNC=1` in both manifests (owner decision) | Value checked against the code's own parser; cluster storage cost NOT VERIFIED |
| 18 | 2026-10-07 19:18 UTC (00:48 IST) | [#19](https://github.com/nitro0dust-pixel/Increadible/pull/19) | A/B metric semantics: `direction`, `primary_metric`, `guardrail` (a cheaper variant used to be reported as the loser) | 24 tests, 12 of 12 breakages caught |
| 19 | 2026-10-07 19:25 UTC (00:55 IST) | [#20](https://github.com/nitro0dust-pixel/Increadible/pull/20) | A/B with two to ten variants, equal or weighted traffic, Holm correction over all pairs | Two-variant answers unchanged (golden master); 20 of 20 breakages caught |
| 20 | 2026-10-07 19:45 UTC (01:15 IST) | [#21](https://github.com/nitro0dust-pixel/Increadible/pull/21) | API gateway live mode, opt-in per API (`GATEWAY_LIVE_APIS`): SSRF-safe URL building, credential never in a result, redirects refused, JSON only, time and size caps | Real local HTTP server and a 60 000-endpoint property test; never run against a real provider (NOT VERIFIED) |
| 21 | 2026-10-07 20:50 UTC (02:20 IST) | [#22](https://github.com/nitro0dust-pixel/Increadible/pull/22) | `COMPANIONS.md`: third-party tools run side by side, never inside this server; `agentacct` rejected as the savings instrument | Owner decisions of 2026-10-07 |
| 22 | 2026-10-08 00:30 UTC (06:00 IST) | [#23](https://github.com/nitro0dust-pixel/Increadible/pull/23) | Audit part 1: gateway resource bounds (cache, aggregate fan-out, partial results) | 17 tests, 21 breakages caught |
| 23 | 2026-10-08 00:42 UTC (06:12 IST) | [#24](https://github.com/nitro0dust-pixel/Increadible/pull/24) | Audit part 2: A/B inputs, permanent poisoning by one huge value, the interval for few values | 13 tests; 58 `ci_95` figures changed deliberately and independently checked |
| 24 | 2026-10-08 00:53 UTC (06:23 IST) | [#25](https://github.com/nitro0dust-pixel/Increadible/pull/25) | Audit part 3: routing state integrity and JSON-RPC / HTTP conformance | 64 tests; 29 breakages caught |
| 25 | 2026-10-08 01:14 UTC (06:44 IST) | [#26](https://github.com/nitro0dust-pixel/Increadible/pull/26) | Audit part 4: scripts, alerts and CI (`IncreadibleDown` could not fire for a vanished target; `verify.sh` passed a partial run) | 15 tests; 20 breakages caught |
| 26 | 2026-10-08 01:37 UTC (07:07 IST) | [#27](https://github.com/nitro0dust-pixel/Increadible/pull/27) | Audit part 5: tests for behaviour that never ran, documents, `LICENSE`, `GATEWAY.md` | 35 tests; two real defects found (`.nan` split, empty experiments file) |
| 27 | 2026-10-08 01:46 UTC (07:16 IST) | [#28](https://github.com/nitro0dust-pixel/Increadible/pull/28) | Audit part 6: development toolchain (Jest 30, ESLint 10, typescript-eslint 8); 42 advisories to 20, none high | Same 490 tests before and after; clean rooms on Node 22 and 24 |
| 28 | 2026-10-09 00:48 UTC (06:18 IST) | [#30](https://github.com/nitro0dust-pixel/Increadible/pull/30) | Audit part 7: mutation testing (78.7% to 90.0%), six new test files, the process entry point tested as a real process, `AUDIT.md` | 718 tests; `main` run 37866668125, pull-by-digest log read |
| 29 | 2026-10-09 01:19 UTC (06:49 IST) | [#31](https://github.com/nitro0dust-pixel/Increadible/pull/31) | The global skill `omniroute-mcp` and `scripts/skill.js`; the documentation set (`docs/`, `CONTRIBUTING.md`, `SECURITY.md`, the pull request template); working rule 8 | 735 tests; 27 guard breakages caught (4 survived at first and got stronger tests); PR run 37868919376, `main` run 37869228542 (pull-by-digest log read, `probe: OK`) |

## 3. The audit in one table

The audit (PRs #23 to #28 and #30) is reported step by step, finding by finding, in `AUDIT.md`. In short: every finding was
reproduced before it was fixed, every fix got a test, and every new guard was broken on purpose to confirm it fails.

| Part | Subject | Findings |
|---|---|---|
| 1 | Gateway resource bounds | GW-1, GW-3, GW-4 |
| 2 | A/B inputs and the interval for few values | AB-2 to AB-7 |
| 3 | Routing state and protocol conformance | RT-1 to RT-5, P-1 to P-6 |
| 4 | Scripts, alerts and CI | D-1 to D-4 fixed; D-5, D-6 recorded |
| 5 | Tests that never ran, documents, license | AB-8, AB-9, C-1 to C-4, E-1 to E-4, F-02, F-07 |
| 6 | Development toolchain | F-03 |
| 7 | Mutation testing, the process entry point, the report | C-5, I-1 |

## 4. After the audit (9 Oct 2026 onward)

| Step | What | State |
|---|---|---|
| A | Global skill `omniroute-mcp` (`skills/omniroute-mcp/`), with `scripts/skill.js` to sync, check, package and install it | done: [#31](https://github.com/nitro0dust-pixel/Increadible/pull/31), row 29 in section 2 |
| B | The documentation set from scratch to Claude Desktop: `docs/`, `CONTRIBUTING.md`, `SECURITY.md`, the pull request template | done: the same pull request as step A |
| C | One-click Claude Desktop package (`.mcpb`) | built and tested on branch `claude/nice-keller-aoooos` (pull request open or about to be): `mcpb/manifest.json`, `scripts/mcpb.js`, `scripts/zip.js`, `tests/mcpb.test.ts`, a CI artifact, Path A of the install guide. 30 deliberate breakages caught (2 survived at first). **Claude Desktop installing the file is `NOT VERIFIED`**. Its row in section 2 is added after it has merged |

Guards for A and B: 27 deliberate breakages of the new tests and of `scripts/skill.js`; four survived at first (the checksum test
compared the function with itself, `sync` was never run on a stale state, the stored-or-deflated switch and the UTF-8 flag were never
exercised), each got a stronger test, and all 27 are now caught. **Installation in the owner's Claude Desktop is `NOT VERIFIED`**:
only the owner can do and confirm it.

## 5. How to add a step

After every step: add a row here, update `ROADMAP.md` (status with evidence) and `CHANGELOG.md`, run `node scripts/skill.js sync`
so the skill carries the same text, and run `npm test` (the guards fail when a document and the skill drift apart).

A pull request's own row in section 2 (its merge time and the CI run) can only be written once it has merged, so the first commit of
the next step adds it, with the matching lines in `ROADMAP.md` ("What has been done"), `CHANGELOG.md` and the skill's status table.
