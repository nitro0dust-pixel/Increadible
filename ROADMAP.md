# Roadmap and project status

Last updated: 2026-10-06 01:40 UTC (6 Oct 2026, 07:10 IST), measured at `main` = `2acb01b` (PR #12 merged) plus the handoff file and changelog in PR #13.

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
| CI on `main` | **green: all six jobs passed on the first attempt** on `2acb01b` (the PR #12 merge, [run 37399617929](https://github.com/nitro0dust-pixel/Increadible/actions/runs/37399617929)): type-check/lint/build/smoke, tests, dependency audit and secret scan (including the SBOM steps), the `prometheus` job (promtool built in 2 min 33 s), Docker build and probe, the push of the image with an SBOM attestation, and pull-by-digest verification of the pushed image (its probe of the copy pulled from GHCR passed in 39 s). Finished 2026-10-06 01:35 UTC, 3 min 48 s after the push. The merges before it (`4758195`, run 37397478683; `00fdefe`, run 37393158999; `2db2bb0`, run 37390833938) were green too. On 2026-10-05 GitHub cancelled queued jobs after 15 minutes without a runner (12 jobs between 19:42 and 21:10 UTC, none of which ran a step); runners have been quick since 21:34 UTC | `main` run 37399617929 |
| Runtime | Node 24 LTS in the Dockerfile, CI and `@types/node`; `engines` is `>=22`. Node 20 reached end-of-life on 2026-04-30. Tested locally on Node 24.21.0 and 22.22.0; **built, probed, pushed to GHCR, pulled back by digest and probed again** in CI on `685227b` (non-root, auth, restart persistence, HEALTHCHECK) | nodejs/Release `schedule.json` fetched 2026-10-05; `main` run 37376758416 |
| Tests | 164 pass, 6 todo | `npm test` |
| A/B data file: one writer, optional fsync, growth warning | **verified locally**: 19 unit tests (live holder refused at once, crashed holder taken over, abandoned or unverifiable locks, writes refused once the lock is lost, fsync on and off, growth warning); `scripts/smoke.sh` with real processes (clean exit releases the lock, a second process is refused, SIGTERM releases it, a SIGKILLed holder is taken over with its data intact); `scripts/probe-image.sh` run against a stubbed `docker`, and it fails when the lock is disabled. **Real-container probe: first CI run (`aee583f`) failed in the probe script, not the server.** The hard-killed container with `AB_FSYNC=1` was recovered and the second container was refused with the right message after waiting about 17 s, but `docker logs | grep -q` under `pipefail` returned SIGPIPE (141) and reported a wrong reason. Fixed by capturing output before matching; a config test now forbids `| grep -q` in pipefail scripts. **Re-run on `ce5d7d9` ([run 37392529986](https://github.com/nitro0dust-pixel/Increadible/actions/runs/37392529986)): all five jobs green; the real-daemon probe ran every section and printed `probe: OK`, with the `[lock]` section taking 17.3 s (the designed wait before a second container on another hostname is refused).** The replacement-pod-after-a-hard-kill path is therefore now exercised on a real daemon too (the `[persistence]` section took about 14 s, waiting out the dead container's lock). The foreign-hostname path (a replacement pod after a hard kill waits up to about 15 s) is covered by planted-lock unit tests and by the real-container probe | PR #10, merged as `00fdefe`; its real-container probe also passed on `main` run 37393158999 |
| HTTP hardening: crash on a bad tool input, shutdown, timeouts, open-server refusal, optional rate limit | **verified locally** (PR #11): a `discover_apis` call with a non-string `query` killed the whole server in HTTP and stdio mode (reproduced, exit 1); a stalled client held the process through SIGTERM (still running 8 s later; Node's default request timeout is 300 s) and `/ready` refused connections instead of answering 503; Node's header and request timeouts were 60 s and 300 s; an empty `AUTH_TOKEN` on `HOST=0.0.0.0` silently turned authentication off. Fixed at the root and with last-resort catches in both transports, a drain then deadline shutdown, explicit 10 s and 30 s receive timeouts, a refusal to start open beyond loopback (`ALLOW_UNAUTHENTICATED=1` to override) and an optional global token-bucket limit (`RATE_LIMIT_PER_MINUTE`, off). Unit tests for each (every one fails when its fix is removed), `scripts/smoke.sh` with real processes and `scripts/probe-image.sh` extended for the real image (stub run passes, each new check fails when its fix is removed). **Real-image probe on a real Docker daemon: passed on the first CI run** ([run 37396176911](https://github.com/nitro0dust-pixel/Increadible/actions/runs/37396176911), head `5def8d4`, all five jobs green). Its log shows every section ran, including `[exposure]` (the image without a token refuses to start) and `[shutdown]` (`docker stop` exited 0 and left no lock file), ending in `probe: OK`. **NOT VERIFIED:** any real cluster (drain time against a real load balancer, keep-alive against its idle timeout). The rate-limit number is unmeasured | PR #11, merged as `4758195` |
| Latency metrics, 401 counter, alert-rule validation | **verified locally** (PR #12): `increadible_tool_call_duration_seconds{tool}` histogram (1 ms to 10 s buckets, failed calls included, labels bounded by the 13 real tools) and `increadible_http_rejected_total{reason="unauthorized"}`; a new `IncreadibleSlowToolCalls` alert; unit tests for the histogram (boundaries, cumulative buckets, failures, unknown tool names), smoke and stub probe checks, each failing when its piece is broken. `promtool` built from source from a pinned, checksummed Prometheus module (the full build took 192 s on four cores; without the cloud service-discovery code, 71 s from a cold cache). **The latency alert threshold (p95 above 1 s) is provisional: there is no baseline.** Both the real-daemon probe (which checks the histogram inside the container) and the new CI job **passed on the first CI run** (run 37398999560; the probe log read, every section ending in `probe: OK`) | PR #12, merged as `2acb01b` |
| Coverage | 92.3% statements, 82.2% branches (the process entry block of `src/index.ts` is exercised by `scripts/smoke.sh`, not by Jest) | `npx jest --coverage` |
| Lint, type-check | clean | `npm run lint`, `npm run type-check` |
| Dependency audit (prod deps) | 0 vulnerabilities | `npm audit --omit=dev` |
| Published image | pushed to GHCR (Node 24), pulled by digest and probed in CI on `685227b`; package is private | `verify-published-image` job, run 37376758416 |
| Staging manifest (`k8s/staging-deployment.yaml`) | **verified on a local Docker Desktop cluster** (kind-based, Kubernetes v1.36.1), 2026-10-05 ~20:20 UTC: all six objects applied, PVC bound, pod Ready, `/health` and `/ready` ok, `/metrics` and `/mcp` 401 without the token, 13 tools, ConfigMap rules loaded, A/B data survived `kubectl rollout restart` (file on the PVC unchanged in the new pod) | run with the locally built image (`increadible:local`, `imagePullPolicy: IfNotPresent`) because the GHCR package is private; the GHCR pull path was **not** exercised |
| Production manifest (`k8s/production-deployment.yaml`) | **NOT VERIFIED** (not applied) | differs from staging only in namespace and `imagePullPolicy: IfNotPresent` (`git diff --no-index`); structurally covered by the staging run, but never applied |
| Prometheus rules (`k8s/monitoring.yaml`) | **syntax-checked and unit-tested with promtool** (PR #12): 11 cases over 5 alerts, each alert with a case that must fire and one that must stay quiet; 7 deliberate breakages of the rules were each caught. **NOT VERIFIED against a live Prometheus**: needs Prometheus Operator CRDs and kube-state-metrics; none installed. The CI `prometheus` job **passed on its first run** ([run 37398999560](https://github.com/nitro0dust-pixel/Increadible/actions/runs/37398999560), head `e524ec1`): 5 rules found, rule tests pass; building promtool took 2 min 37 s on the runner | `scripts/check-prometheus.sh` |
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
10. **[PR #10](https://github.com/nitro0dust-pixel/Increadible/pull/10), A/B data file safety:** a lock file makes the data file single-writer (second process refused, crashed holder's lock taken over, writes fail closed if the lock is lost), `AB_FSYNC=1` flushes every append, a warning at `AB_DATA_WARN_BYTES` (default 100 MB), SIGTERM/SIGINT handling in stdio mode so the lock is released. Compaction was **not** built: nothing can be deleted today, so it would only drop corrupt lines; real size control needs a rollup design (open decision). Merged as `00fdefe`; the real-container probe passed on a real Docker daemon, first failing on a bug in the probe script itself (`grep -q` under `pipefail` returned SIGPIPE), which is fixed and guarded by a test.
11. **[PR #11](https://github.com/nitro0dust-pixel/Increadible/pull/11), HTTP hardening (roadmap step 5):** a tool or handler that throws can no longer end the process (one `discover_apis` call could); graceful shutdown (`/ready` 503 while draining, a hard deadline so a stalled client cannot hold the process); explicit receive timeouts; the server refuses to start on a non-loopback `HOST` without `AUTH_TOKEN`; an optional global rate limit, **off by default** because no load test has measured a safe number. Merged as `4758195`; the real-daemon probe passed (the new exposure and shutdown sections ran), and so did the `main` run, including the copy pulled back from GHCR.
12. **[PR #12](https://github.com/nitro0dust-pixel/Increadible/pull/12), latency metrics and alert-rule validation (roadmap step 6):** a tool-call latency histogram, a counter for refused (401) requests, a latency alert (provisional threshold), `promtool check rules` and `promtool test rules` over every alert (`scripts/check-prometheus.sh`, `monitoring/alerts.test.yaml`) and a CI job that builds promtool from a pinned, checksum-verified Prometheus release (`scripts/install-promtool.sh`). Merged as `2acb01b`; its CI run passed, including the new `prometheus` job (promtool built in 2 min 14 s to 2 min 37 s on the runner) and the real-daemon probe.
13. **[PR #13](https://github.com/nitro0dust-pixel/Increadible/pull/13), handoff file and changelog (roadmap step 7):** `CLAUDE.md` (stable context and working rules for future sessions) and `CHANGELOG.md` (everything under *Unreleased*, behaviour changes flagged), with tests that fail when the handoff file names an environment variable, script, file or CI job that does not exist, when the code reads a variable it does not name, or when the changelog misses a pull request listed here.

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
| Prometheus alert rules (`promtool check rules` and `promtool test rules`) | **passes locally** (11 cases, 5 alerts); **passes in CI** as the `prometheus` job added in PR #12 (run 37398999560). Not run against a live Prometheus | `scripts/check-prometheus.sh` |
| Container image vulnerability scan | NOT DONE: needs a tool choice and approval (open decisions) |
| Load and performance test | NOT DONE |
| SOC2 / GDPR scans | NOT STARTED (no claim of compliance is made anywhere) |
| Production deployment | NOT DONE; requires explicit owner approval |

## Backlog (unscheduled)

- **Release process:** a CHANGELOG exists (`CHANGELOG.md`, everything under *Unreleased*); the local `v1.0.0` tag still points at an old commit and was never pushed; the first release is an owner decision.
- **Handoff:** `CLAUDE.md` holds the stable context and working rules for future sessions; the status stays here.
- **A/B module:** one metric decides the winner; two variants only; the log is never compacted (it only warns at 100 MB), so a rollup or rotation design is still needed.
- **Observability:** a tool-call latency histogram exists but there is no baseline, so the latency alert threshold is provisional; no cost metrics; no dashboard; the rules are unit-tested with promtool but never run against a live Prometheus; no HTTP-level (end-to-end) latency metric, no request log.
- **HTTP:** no TLS, per-client rate limit or request logging; the rate limit is global and off by default; keep-alive timeout is Node's 5 s default, unchecked against a real load balancer's idle timeout.
- **Container hardening:** no image signing; the image SBOM attestation is unverified; no vulnerability scan; GitHub Actions are pinned by version tag, not by commit SHA.

## Open decisions (owner)

- [ ] Confirm or change the current stage above.
- [ ] Target cluster for the first deployment (suggested rehearsal: local Kubernetes in Docker Desktop, then a managed cluster).
- [ ] GHCR package visibility: keep private (pull secret) or make public.
- [ ] Feature priority: real gateway APIs, wiring in a vendored feature (which one), or measuring real savings first.
- [ ] Release: delete the stale local `v1.0.0` tag and retag after the first verified deploy.
- [ ] A/B storage growth: keep raw measurements (exact, about 150 bytes each, never compacted) or store count, sum and sum of squares per variant and metric (a data-model change that loses per-measurement history). Not urgent until volume is known.
- [ ] Rate limit: choose `RATE_LIMIT_PER_MINUTE` for the deployment (off today, no default is justified until the load test, step 13). Also confirm the new rule that a non-loopback `HOST` needs `AUTH_TOKEN` (`ALLOW_UNAUTHENTICATED=1` overrides it): `docker run` without a token now exits instead of serving openly.
- [ ] Latency alert: confirm or replace the provisional threshold (p95 above 1 s for 10 minutes) once the load test gives a baseline. The `prometheus` CI job builds promtool from source (about 70 seconds from a cold cache on four cores, 2 min 37 s on the GitHub runner, where it is now the longest job); alternatives are a prebuilt image pinned by digest (needs approval to look the digest up) or a build cache (needs a verified `actions/cache` version).
- [ ] `AB_FSYNC` default: off until the cost of a flush per write is measured (load test, step 13); decide whether the image and manifests should turn it on.
- [ ] Default branch: the repository's default branch is `claude/nice-keller-aoooos`, not `main`. Set it to `main` (Dependabot reads its config from the default branch).
- [ ] Image vulnerability scanner: choose a tool (Trivy, Grype or Docker Scout) and approve looking up its upstream release and commit SHA so it can be pinned. Not added blind: the authoring sandbox cannot reach Docker Hub or other repositories to verify a version.
- [ ] CI runners: GitHub-hosted jobs were cancelled after 15 minutes in the queue (12 jobs between 19:42 and 21:10 UTC on 2026-10-05, none of which ran a step). Keep retrying, merge several jobs into one, or register a self-hosted runner.

## How to keep this file honest

- Every status change cites evidence; "NOT VERIFIED" stays until something has actually been run.
- Projected numbers are never recorded as results.
- Production deployment needs explicit owner approval, recorded here with the date.
