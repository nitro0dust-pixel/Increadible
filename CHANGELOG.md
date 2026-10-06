# Changelog

All notable changes to this repository, newest first. Format after [Keep a Changelog](https://keepachangelog.com/).
Entries cite the pull request; evidence (CI runs, commands) is in each PR and in `ROADMAP.md`.

**No release has been cut.** The local `v1.0.0` tag points at an old commit and was never pushed; the first release
is an owner decision after the first verified deployment (see `ROADMAP.md`). Until then everything is under *Unreleased*.
Entries marked **behaviour change** can affect an existing deployment.

## [Unreleased]

### Added
- Tool-call latency histogram `increadible_tool_call_duration_seconds{tool}`, a counter of refused requests
  `increadible_http_rejected_total{reason}` (`unauthorized`, `rate_limited`, `payload_too_large`) and an `IncreadibleSlowToolCalls`
  alert (p95 above 1 s; **provisional threshold**). ([#12](https://github.com/nitro0dust-pixel/Increadible/pull/12), [#11](https://github.com/nitro0dust-pixel/Increadible/pull/11))
- `promtool check rules` and `promtool test rules` for the alert rules (`monitoring/alerts.test.yaml`, `scripts/check-prometheus.sh`) and a CI job
  that builds promtool from a pinned, checksum-verified Prometheus release. ([#12](https://github.com/nitro0dust-pixel/Increadible/pull/12))
- Optional global rate limit on `POST /mcp` (`RATE_LIMIT_PER_MINUTE`, off by default); `SHUTDOWN_DRAIN_MS`, `SHUTDOWN_TIMEOUT_MS`,
  `HTTP_HEADERS_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `ALLOW_UNAUTHENTICATED`. ([#11](https://github.com/nitro0dust-pixel/Increadible/pull/11))
- A/B data file safety: a lock file makes the file single-writer, `AB_FSYNC=1` flushes every append, `AB_DATA_WARN_BYTES` warns on growth.
  ([#10](https://github.com/nitro0dust-pixel/Increadible/pull/10))
- SBOM of the production npm tree (CycloneDX, validated in CI), an SBOM attestation on the published image, and a Dependabot config
  (inactive until the default branch is `main`). ([#9](https://github.com/nitro0dust-pixel/Increadible/pull/9))
- A/B experiments and measurements persist to an append-only file (`AB_DATA_FILE`) with crash recovery, and to a volume in Kubernetes.
  ([#3](https://github.com/nitro0dust-pixel/Increadible/pull/3))
- CI pulls the image it pushed to GHCR back by digest and probes that copy; optional `ghcr-pull` secret and a private-image runbook.
  ([#4](https://github.com/nitro0dust-pixel/Increadible/pull/4), [#5](https://github.com/nitro0dust-pixel/Increadible/pull/5))
- `CLAUDE.md` (context for Claude sessions) and this changelog. ([#13](https://github.com/nitro0dust-pixel/Increadible/pull/13))
- `ROADMAP.md`: status, plan, quality gates and open decisions, with evidence for every status. ([#6](https://github.com/nitro0dust-pixel/Increadible/pull/6))

### Changed
- **Behaviour change:** an HTTP server on a non-loopback `HOST` (the image binds `0.0.0.0`) without a non-blank `AUTH_TOKEN` refuses to start
  (exit 1); before, an empty token silently turned authentication off. `ALLOW_UNAUTHENTICATED=1` overrides it. ([#11](https://github.com/nitro0dust-pixel/Increadible/pull/11))
- **Behaviour change:** receiving a request now has a 10 s (headers) and 30 s (whole request) limit instead of Node's 60 s and 300 s.
  ([#11](https://github.com/nitro0dust-pixel/Increadible/pull/11))
- **Behaviour change:** a second process opening the same A/B data file is refused at startup (`in use by pid ...`), and a replacement
  container with another hostname can wait up to about 17 s for a dead holder's lock. ([#10](https://github.com/nitro0dust-pixel/Increadible/pull/10))
- Shutdown drains (`/ready` answers 503), closes, and cuts remaining connections after a deadline; `stdio` mode handles SIGTERM/SIGINT so the
  lock is released. ([#11](https://github.com/nitro0dust-pixel/Increadible/pull/11), [#10](https://github.com/nitro0dust-pixel/Increadible/pull/10))
- Runtime: Node 20 (end-of-life) to Node 24 LTS in the Dockerfile and CI; `engines` is `>=22`; a test keeps one Node major everywhere.
  ([#8](https://github.com/nitro0dust-pixel/Increadible/pull/8))
- `build` is portable to Windows (a cleaner script instead of `rm -rf`), line endings are forced to LF, and one POSIX-permission test assertion is
  skipped on Windows. ([#7](https://github.com/nitro0dust-pixel/Increadible/pull/7))
- Kubernetes manifests: drain settings and an explicit 30 s termination grace period. ([#11](https://github.com/nitro0dust-pixel/Increadible/pull/11))

### Fixed
- One request could kill the whole server: `discover_apis` with a non-string `query` threw out of the tool (HTTP and stdio). A throwing tool is now a
  tool error; both transports have a last-resort catch. ([#11](https://github.com/nitro0dust-pixel/Increadible/pull/11))
- The image probe reported a wrong reason when `docker logs | grep -q` hit SIGPIPE under `pipefail`; output is captured before matching, and a test forbids
  the pattern. ([#10](https://github.com/nitro0dust-pixel/Increadible/pull/10))
- Working build and a runnable server (stdio and HTTP with health, metrics and auth); a real Welch t-test replaced hardcoded A/B statistics;
  routing and gateway bugs; Dockerfile, manifests and CI rewritten to match the code. ([#2](https://github.com/nitro0dust-pixel/Increadible/pull/2))

### Removed
- Fabricated sign-offs, load-test and savings reports ("production-ready", "99.98% cost reduction"): none of it had been run. Figures that remain in
  upstream projects' documents are targets, not measurements. ([#2](https://github.com/nitro0dust-pixel/Increadible/pull/2))

### Not done (see `ROADMAP.md`)
Deployment to a cluster, image vulnerability scan, image signing, a load test, real gateway API calls, and integration of the vendored features #1-#6.
