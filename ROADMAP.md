# Roadmap and project status

Last updated: 2026-10-05 18:50 UTC (6 Oct 2026, 00:20 IST), at `main` = `b786ef7`.

**Bottom line:** the in-repo code (Features #7-#9 and the server around them) is built, tested, containerised, and the
image published to GHCR passes its probe. **Nothing is deployed anywhere**, the Kubernetes manifests have never been
applied to a cluster, and no cost saving has ever been measured.

## Current stage

> **Proposed, not yet confirmed by the owner:** end of Sprint 2, entering a deployment rehearsal.

Update this line when the owner confirms or changes it.

## Snapshot (measured)

| Item | Result | Evidence |
|---|---|---|
| CI on `main` | green, including the pull-by-digest check | run 37358545891 |
| Tests | 87 pass, 6 todo | `npm test` |
| Coverage | 92% statements, 81% branches | `npx jest --coverage` |
| Lint, type-check | clean | `npm run lint`, `npm run type-check` |
| Dependency audit (prod deps) | 0 vulnerabilities | `npm audit --omit=dev` |
| Published image | pushed to GHCR, pulled by digest and probed in CI; package is private | `verify-published-image` job |
| Kubernetes manifests, Prometheus rules | **NOT VERIFIED** (no cluster available) | parsed and consistency-tested only |
| Cost savings and quality figures | **never measured** | the old headline percentages were removed |
| Release tag `v1.0.0` | exists locally only, on an old commit; never pushed | `git ls-remote --tags origin` is empty |

## What has been done

1. **Starting point:** three MCP modules, five vendored third-party submodules and a lot of documentation. The earlier
   "production-ready, verified savings, approved" reports were not true: the tests only checked hardcoded fixtures and the
   sign-offs, load tests and scans never happened.
2. **[PR #2](https://github.com/nitro0dust-pixel/Increadible/pull/2), audit and critical fixes:** working build; a runnable server (stdio and HTTP with
   health, metrics and auth); a real Welch t-test replacing hardcoded A/B statistics; routing and gateway bug fixes; real
   tests for the three modules; Dockerfile, Kubernetes manifests and CI rewritten to match the code; fabricated documents
   removed; the missing Headroom submodule added.
3. **[PR #3](https://github.com/nitro0dust-pixel/Increadible/pull/3), A/B persistence:** append-only log (`AB_DATA_FILE`) with crash recovery, a persistent volume in Kubernetes.
4. **[PR #4](https://github.com/nitro0dust-pixel/Increadible/pull/4), image verification:** CI pulls the pushed image back by digest and probes that copy.
5. **[PR #5](https://github.com/nitro0dust-pixel/Increadible/pull/5), private-image deployment:** optional `ghcr-pull` secret and a deployment runbook.

## Roadmap by sprint

Statuses: DONE, PARTIAL, NOT STARTED, BLOCKED, N/A. A DONE needs evidence (PR, commit, CI run or command).

| Sprint | Status | Done | Remaining |
|---|---|---|---|
| 0, Discovery and audit | DONE | repo-wide audit of code, infrastructure, docs and guides | none |
| 1, Critical fixes | DONE | [PR #2](https://github.com/nitro0dust-pixel/Increadible/pull/2) | none |
| 2, Architecture and scalability | PARTIAL | persistence ([#3](https://github.com/nitro0dust-pixel/Increadible/pull/3)), CI gates and image verification ([#4](https://github.com/nitro0dust-pixel/Increadible/pull/4)), pull secret and runbook ([#5](https://github.com/nitro0dust-pixel/Increadible/pull/5)) | real cluster deploy (BLOCKED: needs a cluster and the owner's go-ahead); TLS, ingress and NetworkPolicy; scaling beyond one replica (the data file has a single writer); runtime upgrade (see backlog) |
| 3, UX/UI | N/A | there is no UI | none |
| 4, Feature additions | PARTIAL | A/B persistence | real HTTP calls in the API gateway (it returns mock data today); multi-variant and multi-metric A/B; wiring in the vendored features #1-#4 and #6 (none are integrated or tested here); persistence for rule stats |
| 5, Optimisation and conversion | NOT STARTED | none | measure real savings with agentacct against a baseline; latency and cost metrics; load test |

## Quality and security gates

| Gate | Status |
|---|---|
| Unit and integration tests, lint, type-check | PASS |
| Dependency audit (production dependencies) | PASS |
| Secret scan (verified secrets only) | PASS |
| Container image vulnerability scan | NOT DONE |
| Load and performance test | NOT DONE |
| SOC2 / GDPR scans | NOT STARTED (no claim of compliance is made anywhere) |
| Production deployment | NOT DONE; requires explicit owner approval |

## Backlog (unscheduled)

- **Runtime:** the Dockerfile and CI use Node 20, whose scheduled end-of-life was April 2026; move to the current LTS.
- **Release process:** no CHANGELOG; the local `v1.0.0` tag points at an old commit and was never pushed.
- **Handoff:** no `CLAUDE.md` or equivalent context file for future sessions.
- **A/B module:** one metric decides the winner; two variants only; the log is never compacted and not fsynced.
- **Observability:** no latency or cost metrics; no dashboard; Prometheus rules are untested against a live Prometheus.
- **Container hardening:** no image signing or SBOM.

## Open decisions (owner)

- [ ] Confirm or change the current stage above.
- [ ] Target cluster for the first deployment (suggested rehearsal: local Kubernetes in Docker Desktop, then a managed cluster).
- [ ] GHCR package visibility: keep private (pull secret) or make public.
- [ ] Feature priority: real gateway APIs, wiring in a vendored feature (which one), or measuring real savings first.
- [ ] Release: delete the stale local `v1.0.0` tag and retag after the first verified deploy.

## How to keep this file honest

- Every status change cites evidence; "NOT VERIFIED" stays until something has actually been run.
- Projected numbers are never recorded as results.
- Production deployment needs explicit owner approval, recorded here with the date.
