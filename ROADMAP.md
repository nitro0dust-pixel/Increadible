# Roadmap and project status

Last updated: 2026-10-06 00:02 UTC (6 Oct 2026, 05:32 IST), measured at `main` = `2db2bb0` (PR #9 merged) plus the A/B data file change in PR #10.

**Bottom line:** the in-repo code (Features #7-#9 and the server around them) is built, tested, containerised, and the
image published to GHCR passes its probe. **Nothing is deployed anywhere beyond a local rehearsal**: the staging
manifest has been applied to a local Docker Desktop cluster (see the snapshot), the production manifest and monitoring have
not been applied to anything, and no cost saving has ever been measured.

## Current stage

> **Proposed, not yet confirmed by the owner:** end of Sprint 2, entering a deployment rehearsal.

Update this line when the owner confirms or changes it.

## Snapshot (measured)

| Item | Result | Evidence |
|---|---|---|
| CI on `main` | **green: all five jobs passed** on `2db2bb0` (the PR #9 merge): type-check/lint/build/smoke, tests, dependency audit and secret scan (including the SBOM steps), Docker build and probe, the push of the image with an SBOM attestation, and pull-by-digest verification of the pushed image. Finished 2026-10-05 23:53 UTC, about two minutes after the push. Earlier that evening GitHub cancelled queued jobs after 15 minutes without a runner (12 jobs between 19:42 and 21:10 UTC, none of which ran a step); runners have been quick since 21:34 UTC | `main` run 37390833938 |
| Runtime | Node 24 LTS in the Dockerfile, CI and `@types/node`; `engines` is `>=22`. Node 20 reached end-of-life on 2026-04-30. Tested locally on Node 24.21.0 and 22.22.0; **built, probed, pushed to GHCR, pulled back by digest and probed again** in CI on `685227b` (non-root, auth, restart persistence, HEALTHCHECK) | nodejs/Release `schedule.json` fetched 2026-10-05; `main` run 37376758416 |
| Tests | 116 pass, 6 todo | `npm test` |
| A/B data file: one writer, optional fsync, growth warning | **verified locally**: 19 unit tests (live holder refused at once, crashed holder taken over, abandoned or unverifiable locks, writes refused once the lock is lost, fsync on and off, growth warning); `scripts/smoke.sh` with real processes (clean exit releases the lock, a second process is refused, SIGTERM releases it, a SIGKILLed holder is taken over with its data intact); `scripts/probe-image.sh` run against a stubbed `docker`, and it fails when the lock is disabled. **The real-container probe is pending its first CI run** (hard-killed container with `AB_FSYNC=1`, second container refused). The foreign-hostname path (a replacement pod after a hard kill waits up to about 15 s) is covered only by planted-lock unit tests | PR #10 |
| Coverage | 92% statements, 81% branches | `npx jest --coverage` |
| Lint, type-check | clean | `npm run lint`, `npm run type-check` |
| Dependency audit (prod deps) | 0 vulnerabilities | `npm audit --omit=dev` |
| Published image | pushed to GHCR (Node 24), pulled by digest and probed in CI on `685227b`; package is private | `verify-published-image` job, run 37376758416 |
| Staging manifest (`k8s/staging-deployment.yaml`) | **verified on a local Docker Desktop cluster** (kind-based, Kubernetes v1.36.1), 2026-10-05 ~20:20 UTC: all six objects applied, PVC bound, pod Ready, `/health` and `/ready` ok, `/metrics` and `/mcp` 401 without the token, 13 tools, ConfigMap rules loaded, A/B data survived `kubectl rollout restart` (file on the PVC unchanged in the new pod) | run with the locally built image (`increadible:local`, `imagePullPolicy: IfNotPresent`) because the GHCR package is private; the GHCR pull path was **not** exercised |
| Production manifest (`k8s/production-deployment.yaml`) | **NOT VERIFIED** (not applied) | differs from staging only in namespace and `imagePullPolicy: IfNotPresent` (`git diff --no-index`); structurally covered by the staging run, but never applied |
| Prometheus rules (`k8s/monitoring.yaml`) | **NOT VERIFIED** | needs Prometheus Operator CRDs and kube-state-metrics; none installed |
| Local run on the owner's Windows PC | **verified** (Windows 11, Node v24.14, npm 11.9), 2026-10-05: `npm ci`, type-check, lint, `npm test` (90 passed, 6 todo), build; server health/auth/tools/routing; A/B data survived a restart; Docker image built, healthy, and started with a volume | the Docker-container restart check did not record a metric, so it does not prove volume persistence (the file-persistence check was done natively and on Kubernetes) |
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
6. **[PR #6](https://github.com/nitro0dust-pixel/Increadible/pull/6), this roadmap.**
7. **[PR #7](https://github.com/nitro0dust-pixel/Increadible/pull/7), Windows-friendly local verification:** a cross-platform `build` clean step (`rm -rf` does not exist in `cmd.exe`), `.gitattributes` forcing LF line endings (CRLF breaks the shell scripts and some config tests), and one POSIX-permission test assertion skipped on Windows. Not yet run on a real Windows machine.
8. **[PR #8](https://github.com/nitro0dust-pixel/Increadible/pull/8), runtime upgrade:** Node 20 (end-of-life) to Node 24 LTS in the Dockerfile and CI, `@types/node` 24, `engines` `>=22`, and a test that keeps one Node major across the image stages, every CI step and `@types/node`.

9. **[PR #9](https://github.com/nitro0dust-pixel/Increadible/pull/9), SBOM and dependency updates:** CycloneDX SBOM of the production npm tree generated and validated in CI, an SBOM attestation attached to the pushed image, and a Dependabot config for npm, GitHub Actions and Docker.
10. **[PR #10](https://github.com/nitro0dust-pixel/Increadible/pull/10), A/B data file safety:** a lock file makes the data file single-writer (second process refused, crashed holder's lock taken over, writes fail closed if the lock is lost), `AB_FSYNC=1` flushes every append, a warning at `AB_DATA_WARN_BYTES` (default 100 MB), SIGTERM/SIGINT handling in stdio mode so the lock is released. Compaction was **not** built: nothing can be deleted today, so it would only drop corrupt lines; real size control needs a rollup design (open decision).

## Roadmap by sprint

Statuses: DONE, PARTIAL, NOT STARTED, BLOCKED, N/A. A DONE needs evidence (PR, commit, CI run or command).

| Sprint | Status | Done | Remaining |
|---|---|---|---|
| 0, Discovery and audit | DONE | repo-wide audit of code, infrastructure, docs and guides | none |
| 1, Critical fixes | DONE | [PR #2](https://github.com/nitro0dust-pixel/Increadible/pull/2) | none |
| 2, Architecture and scalability | PARTIAL | persistence ([#3](https://github.com/nitro0dust-pixel/Increadible/pull/3)), CI gates and image verification ([#4](https://github.com/nitro0dust-pixel/Increadible/pull/4)), pull secret and runbook ([#5](https://github.com/nitro0dust-pixel/Increadible/pull/5)), runtime upgrade to Node 24 LTS ([#8](https://github.com/nitro0dust-pixel/Increadible/pull/8)) | real cluster deploy (BLOCKED: needs a cluster and the owner's go-ahead); TLS, ingress and NetworkPolicy; scaling beyond one replica (the data file has a single writer) |
| 3, UX/UI | N/A | there is no UI | none |
| 4, Feature additions | PARTIAL | A/B persistence ([#3](https://github.com/nitro0dust-pixel/Increadible/pull/3)), single-writer lock, optional fsync and growth warning ([#10](https://github.com/nitro0dust-pixel/Increadible/pull/10)) | real HTTP calls in the API gateway (it returns mock data today); multi-variant and multi-metric A/B; wiring in the vendored features #1-#4 and #6 (none are integrated or tested here); persistence for rule stats |
| 5, Optimisation and conversion | NOT STARTED | none | measure real savings with agentacct against a baseline; latency and cost metrics; load test |

## Quality and security gates

| Gate | Status |
|---|---|
| Unit and integration tests, lint, type-check | PASS |
| Dependency audit (production dependencies) | PASS |
| Secret scan (verified secrets only) | PASS |
| SBOM of the production npm tree (CycloneDX) | generated and validated by the `security` job and kept as the `sbom-npm` artifact; **passed in CI** (PR run 37377374004, `main` run 37390833938). One component today (`yaml@2.9.1`) | CI runs above |
| SBOM attestation on the published image (OS packages, Node runtime) | the push step with `sbom: true` **succeeded** on `main` and the image was still pulled by digest and probed. **Reading the attestation back is NOT VERIFIED** (see `DEPLOYMENT.md`) | `main` run 37390833938 |
| Dependency update automation (Dependabot) | config added (`.github/dependabot.yml`: npm, GitHub Actions, Docker, majors excluded for npm and Node); **inactive until the default branch is `main`**, which it is not today |
| Container image vulnerability scan | NOT DONE: needs a tool choice and approval (open decisions) |
| Load and performance test | NOT DONE |
| SOC2 / GDPR scans | NOT STARTED (no claim of compliance is made anywhere) |
| Production deployment | NOT DONE; requires explicit owner approval |

## Backlog (unscheduled)

- **Release process:** no CHANGELOG; the local `v1.0.0` tag points at an old commit and was never pushed.
- **Handoff:** no `CLAUDE.md` or equivalent context file for future sessions.
- **A/B module:** one metric decides the winner; two variants only; the log is never compacted (it only warns at 100 MB), so a rollup or rotation design is still needed.
- **Observability:** no latency or cost metrics; no dashboard; Prometheus rules are untested against a live Prometheus.
- **Container hardening:** no image signing; the image SBOM attestation is unverified; no vulnerability scan; GitHub Actions are pinned by version tag, not by commit SHA.

## Open decisions (owner)

- [ ] Confirm or change the current stage above.
- [ ] Target cluster for the first deployment (suggested rehearsal: local Kubernetes in Docker Desktop, then a managed cluster).
- [ ] GHCR package visibility: keep private (pull secret) or make public.
- [ ] Feature priority: real gateway APIs, wiring in a vendored feature (which one), or measuring real savings first.
- [ ] Release: delete the stale local `v1.0.0` tag and retag after the first verified deploy.
- [ ] A/B storage growth: keep raw measurements (exact, about 150 bytes each, never compacted) or store count, sum and sum of squares per variant and metric (a data-model change that loses per-measurement history). Not urgent until volume is known.
- [ ] `AB_FSYNC` default: off until the cost of a flush per write is measured (load test, step 13); decide whether the image and manifests should turn it on.
- [ ] Default branch: the repository's default branch is `claude/nice-keller-aoooos`, not `main`. Set it to `main` (Dependabot reads its config from the default branch).
- [ ] Image vulnerability scanner: choose a tool (Trivy, Grype or Docker Scout) and approve looking up its upstream release and commit SHA so it can be pinned. Not added blind: the authoring sandbox cannot reach Docker Hub or other repositories to verify a version.
- [ ] CI runners: GitHub-hosted jobs were cancelled after 15 minutes in the queue (12 jobs between 19:42 and 21:10 UTC on 2026-10-05, none of which ran a step). Keep retrying, merge several jobs into one, or register a self-hosted runner.

## How to keep this file honest

- Every status change cites evidence; "NOT VERIFIED" stays until something has actually been run.
- Projected numbers are never recorded as results.
- Production deployment needs explicit owner approval, recorded here with the date.
