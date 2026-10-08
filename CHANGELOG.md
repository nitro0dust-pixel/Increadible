# Changelog

All notable changes to this repository, newest first. Format after [Keep a Changelog](https://keepachangelog.com/).
Entries cite the pull request; evidence (CI runs, commands) is in each PR and in `ROADMAP.md`.

**No release has been cut.** The local `v1.0.0` tag points at an old commit and was never pushed; the first release
is an owner decision after the first verified deployment (see `ROADMAP.md`). Until then everything is under *Unreleased*.
Entries marked **behaviour change** can affect an existing deployment.

## [Unreleased]

### Added
- `COMPANIONS.md`: how third-party tools run beside this server (decided: side by side), starting with `token-optimizer-mcp` with the cautions found in its pinned source (its installer edits the global Claude settings; telemetry is opt-in), and the evidence on `agentacct` against the owner's condition (proven, in the market, one of its kind): it is an early-alpha project about ten weeks old and not unique, so it is not used. Real savings are to be measured with this server's A/B module (cost primary, quality guardrail) on a real workload. Documentation and one test only; no code change. ([#22](https://github.com/nitro0dust-pixel/Increadible/pull/22))
- API gateway **live mode** (opt-in per API with `GATEWAY_LIVE_APIS`; the default is unchanged: mock data, no network): real GET requests to each API's registered URL, with the model-supplied `endpoint` and `params` treated as hostile
  (no other host or path, no redirects, JSON only, time and size capped, the credential added by the gateway only and never present in a result, error, log or cache key). Results now say `source: "mock"` or `"live"`, and
  `get_api_stats` gains `live_calls` and `live_apis`. Tested against a real local HTTP server (88 tests, 29 of 30 deliberate breakages caught, the 30th shown redundant) and a 60 000-endpoint property test. **Not tried against any real provider.** ([#21](https://github.com/nitro0dust-pixel/Increadible/pull/21))
- A/B experiments with **two to ten variants**: traffic is shared equally, or by `weights`; a variant wins only if it is significantly better than every other one, with Holm's correction over all pairs, and the result lists every
  pair (`comparisons`). An experiment with two variants behaves exactly as before: the same sticky assignments (checked against a fixture recorded from the previous implementation) and byte-identical results (the 120-dataset golden
  master is unchanged). New fields are checked only where they are new, so no existing experiment becomes invalid. ([#20](https://github.com/nitro0dust-pixel/Increadible/pull/20))
- A/B metric semantics: a metric can set `direction` (`higher_is_better`, the default, or `lower_is_better`), an experiment can name the `primary_metric` that decides the winner (default: the first metric), and a metric with `guardrail: true`
  can withhold a winner (it is significantly worse for it, or has no data) but never picks one. Before this the first metric always decided and the higher mean always won, which reported a significantly cheaper variant as the loser.
  Experiments that use none of the new fields answer exactly as before (the golden-master test of 120 datasets is unchanged); results gain `guardrails` and `winner_withheld_by` only for experiments that declare a guardrail. The new fields
  are checked only when present, so no existing experiment becomes invalid. ([#19](https://github.com/nitro0dust-pixel/Increadible/pull/19))
- `increadible_event_loop_delay_seconds` (histogram of how late the event loop ran a 10 ms timer, HTTP mode) and an `IncreadibleEventLoopBlocked` alert (a tick more than 1 s late in 5 minutes; 1 s is
  the kubelet's default probe timeout). A synchronous task that blocks the loop delays every probe and shows in no per-call timer, so this is the signal for the failure the capacity test found. Smoke and the container
  probe freeze the process for 1.3 s and require the late tick; the alert has a firing and a quiet promtool case. No measurable overhead. ([#17](https://github.com/nitro0dust-pixel/Increadible/pull/17))
- `startupProbe` in both Kubernetes manifests (`/health`, every 5 s, 36 failures = 180 s), because startup replays the whole A/B data file before the port opens and a full 1Gi volume takes
  about 23 s at the 0.5 CPU limit, against a roughly 35 s liveness window; a config test ties the window to the volume size and the CPU limit. Replay time was measured at one core and at about
  half a core (`PERFORMANCE.md`). **Behaviour change:** liveness and readiness probes now start only after the startup probe succeeds. Not applied to a cluster. ([#16](https://github.com/nitro0dust-pixel/Increadible/pull/16))
- Regression checks for the A/B memory fix: a golden-master test (120 datasets whose answers were produced by the previous implementation, replayed at several read
  sizes), `scripts/make-ab-data.js` (writes a large data file in seconds), a `[memory]` section in `scripts/smoke.sh` (400 000 measurements replayed under a 48 MiB
  heap, which the previous code could not do even with 96 MiB) and a `[capacity]` section in `scripts/probe-image.sh` (500 000 measurements inside a 256 MiB container).
  ([#15](https://github.com/nitro0dust-pixel/Increadible/pull/15))
- Measured baselines: `scripts/loadtest.js` (per-tool throughput and latency, closed and open loop, server-side means) and `scripts/capacity.js`
  (A/B data size against restart time, memory and query cost), with results and recommendations in `PERFORMANCE.md`. Finding: the A/B module kept every
  measurement in memory (about 440 to 500 bytes each), so the manifests' 256Mi limit was reached at roughly 400 000 to 460 000 measurements (this entry first said
  360 000: that came from mistaking the 85 MiB reading at 50 000 measurements for the empty server, which idles at 62 MiB), and `get_experiment_results`
  cost time proportional to the samples. ([#14](https://github.com/nitro0dust-pixel/Increadible/pull/14), fixed in [#15](https://github.com/nitro0dust-pixel/Increadible/pull/15))
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
- **Behaviour change (audit):** the server accepts only JSON-RPC 2.0 requests: `jsonrpc` must be `"2.0"` (it used to accept `"1.0"` or nothing) and `id` a string, a number or null (an object or a boolean used to be echoed back; now it is `Invalid Request` with `id: null`); `initialize` answers with a `protocolVersion` only if the client sent a date such as `2025-03-26` and otherwise with its own default (it used to echo anything, including text of any length); a request without an `id` is carried out but never answered (it used to be answered, with `id: null`, for every method except an unknown one). `HEAD` is accepted on `/health` and `/ready`, a query string is ignored on every route, and the `Bearer` scheme name is case-insensitive. A rules file that parses but holds a rule `update_rules` would refuse (no `match`, `enabled: "no"`, duplicate ids and the like) now falls back to the built-in rules with a message, instead of loading and then failing every routing call. `update_rules` refuses a non-finite `priority`, a `match` that is a list, a `fallback` that is not a list of provider names, duplicate or empty ids, more than 500 rules and more than 1 MB. ([#25](https://github.com/nitro0dust-pixel/Increadible/pull/25))
- **Behaviour change (audit):** the A/B tools check what they are given. `create_experiment` rejects an empty, duplicate or `__proto__` id for the experiment, a variant or a metric (also for two variants: it used to accept `[A, A]` and variants without ids, and `assign_variant` then returned no variant), keeps only the fields the module uses and refuses a definition over 64 KB; `record_metric` rejects a metric the experiment does not define (it used to be stored and silently ignored), a value outside -1e15..1e15, and `metrics` that is not an object; `assign_variant` rejects a `user_id` that is not a string or a number; `get_experiment_results` and `recommend_winner` answer an unknown experiment with an error (the first used to answer the text `null`). **Stored data is not affected:** replaying a data file or loading the YAML does not use the new rules. ([#24](https://github.com/nitro0dust-pixel/Increadible/pull/24))
- **Behaviour change (audit):** `aggregate_apis` no longer fails the whole request when one call fails. The failed call holds `{error}` in its own place, the reply adds `failed: n`, and only when every call failed is the reply an error (`all n calls failed`, with `data` still attached). A request takes at most 100 calls (more is a plain error) and runs five at a time; a wrong type is a plain message instead of an internal one (`apis.map is not a function`). `call_api` checks the type of `api_id`, `endpoint` and `params` the same way. ([#23](https://github.com/nitro0dust-pixel/Increadible/pull/23))
- **Behaviour change (an error message):** creating an experiment with the wrong number of variants now says `Experiment must have between 2 and 10 variants` instead of `... exactly 2 variants`. ([#20](https://github.com/nitro0dust-pixel/Increadible/pull/20))
- **Behaviour change (writes are slower, safer):** both Kubernetes manifests set `AB_FSYNC=1`, the owner's decision: every A/B append is flushed to disk before the call returns, so an acknowledged
  write survives a node crash or power loss and not only a process crash. Measured on a local disk at about 0.2 ms per write (ceiling about 3 500 writes per second against about 22 000 without);
  the cost on the cluster's storage class is not measured. The image and the code still default to off. A config test checks the manifest value against the code's own parser, because a value such
  as `on` would be silently read as off. ([#18](https://github.com/nitro0dust-pixel/Increadible/pull/18))
- The A/B module no longer holds every measurement in memory: it keeps counts and a running mean and variance per variant and metric, and replays the data file in
  1 MiB chunks. The data file is unchanged and still holds every measurement. Memory is 67 MiB at 8 000 000 measurements and at 50 000 (before: 85 MiB at 50 000 and
  397 MiB at 800 000), `get_experiment_results` takes 0.04 to 0.07 ms at any size (before: 9 ms to 177 ms), and `/health` is no longer delayed by queries. Results are
  identical to the previous implementation on 120 stored datasets and in a differential run of 5 020 random experiments (recorded live and replayed from a file), with one
  exception: in 1 of the 5 020 a rounded last digit differed, on data near 1 000 000 000, where the exact value sat on a rounding boundary. ([#15](https://github.com/nitro0dust-pixel/Increadible/pull/15))
- **Behaviour change (a log line comes later):** the manifests set `AB_DATA_WARN_BYTES` back to 100 MiB (the code default), undoing the 16 MiB of #14: that value protected
  the memory limit, which the data no longer reaches; a test now keeps the warning below a quarter of the volume. ([#15](https://github.com/nitro0dust-pixel/Increadible/pull/15), [#14](https://github.com/nitro0dust-pixel/Increadible/pull/14))
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
- **Routing state and protocol conformance (audit findings RT-1 to RT-5, P-1 to P-6):** `update_rules` replaced the live rules *before* writing the file, so a failed write (the read-only ConfigMap in the manifests, a full disk) reported an error while routing had already changed (`rules_count` 3 to 1, and the change lost at the next restart); it now writes first, through a temporary file renamed over the target (a crash can no longer leave a truncated rules file, which the next start would have discarded for the built-in rules). A rule called `constructor`, `toString` or `__proto__` corrupted the hit statistics (the count became the text of Object's function and the provider share printed `NaN%`); counts are kept in a Map. A lower-case `bearer`, a `HEAD /health` and `/health?x=1` were refused with 401 when a token was set (a load balancer's probe could mark the pod unhealthy). 64 new tests; 29 deliberate breakages caught; one redundant check found and removed. ([#25](https://github.com/nitro0dust-pixel/Increadible/pull/25))
- **A/B statistics and poisoning (audit findings AB-3, AB-7):** one finite but huge value (`1.7e308`) permanently spoiled an experiment (mean 2.8e306; deviation, interval, p-value and confidence `null`), and nothing can undo a measurement in an append-only log, so new values are limited to -1e15..1e15. The 95% interval of a metric with few values was too narrow (df 1: 4.33 against the exact 12.71; df 5: 2.43 against 2.57; df 10: 2.20 against 2.23) because of a shortcut for the t critical value; it is now exact up to 30 values. This is the **only** change to the numbers the previous implementation produced: 58 `ci_95` figures in 13 of the 120 golden datasets (every one checked against an independent computation, worst disagreement 0.000155), and nothing else differs (winners, p-values, effect sizes, confidences and means are byte-identical). The p-value approximation was checked against the exact t distribution and found conservative below 25 degrees of freedom (never a false winner), so it is unchanged. 21 deliberate breakages of the new code are caught. ([#24](https://github.com/nitro0dust-pixel/Increadible/pull/24))
- **API gateway resource bounds (audit findings GW-1, GW-3):** the result cache grew with every distinct call and never shrank (2 000 calls with 200 KB of params held 385 MB of heap, against a 256Mi pod limit), and one `aggregate_apis` request started every call at once (5 000 requested, 5 000 started together, which in live mode means 5 000 simultaneous calls to a provider with the gateway's own key). The cache now holds at most 500 entries and about 16 MiB (expired, then oldest, dropped first; `cache_evictions` in `get_api_stats`), keys long params by a hash and does not keep a result over 4 MiB; live calls are limited to 10 at once across the gateway with 100 allowed to wait. Measured before and after in the PR. 21 deliberate breakages of the new code are caught. ([#23](https://github.com/nitro0dust-pixel/Increadible/pull/23))
- A measurement recorded without a `metrics` object made every later `get_experiment_results` call for that experiment fail with a TypeError; it now counts as a sample.
  ([#15](https://github.com/nitro0dust-pixel/Increadible/pull/15))
- Two series of identical values (for example a metric that is always 0.1) with different sample sizes were reported as different (p about 0.41 and an effect size of 0.15 from
  floating-point noise in the old two-pass variance). They now compare as equal: p = 1, effect size 0, no winner. ([#15](https://github.com/nitro0dust-pixel/Increadible/pull/15))
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
Deployment to a cluster, image vulnerability scan, image signing, load tests on target hardware, real gateway API calls, and integration of the vendored features #1-#6.
