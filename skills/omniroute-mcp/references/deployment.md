<!-- Copy of DEPLOYMENT.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Deployment

> **Verification status:** the server is tested locally (`npm run verify`) and CI builds and probes the
> Docker image. **Nothing has been deployed to a real environment.** `k8s/staging-deployment.yaml` has been applied once
> to a local Docker Desktop cluster with a locally built image (rollout, auth, ConfigMap rules and A/B persistence across
> `rollout restart` all checked). The production and monitoring manifests have only been parsed and checked for internal
> consistency by `tests/config.test.ts`, and the GHCR pull path is untested. Treat them as a starting point.

## Run locally

```bash
npm ci && npm run build
node dist/src/index.js                      # stdio (Claude Desktop)
PORT=3000 AUTH_TOKEN=change-me node dist/src/index.js   # HTTP
npm run verify                              # type-check, lint, tests, build, smoke, docker build and alert rules if available
bash scripts/cleanroom.sh                   # the same on a clean export of HEAD (only what is committed)
```

## Docker

```bash
docker build -t increadible .
docker run --rm -p 3000:3000 -e AUTH_TOKEN="$(openssl rand -hex 32)" increadible
curl localhost:3000/health
```

Config via env: `PORT` (3000), `HOST` (0.0.0.0 in the image, 127.0.0.1 otherwise), `AUTH_TOKEN`,
`RULES_FILE` (/data/rules.yaml), `EXPERIMENTS_FILE` (/data/experiments.yaml), `AB_DATA_FILE`
(/data/ab-data.jsonl), and optionally `AB_FSYNC` (`1` flushes every A/B append to disk; off in the image, on in the manifests) and `AB_DATA_WARN_BYTES`
(growth warning, default 104857600). The HTTP hardening settings are in "HTTP hardening" below. Mount a volume at `/data` to keep edited rules and A/B data across container restarts
(`docker run -v increadible-data:/data ...`). Without a volume, A/B data is lost when the container is removed.

CI (`.github/workflows/ci-cd.yml`) builds the image, starts it, probes `/health`, `/metrics` (must be 401
without the token) and `/mcp`, and pushes `ghcr.io/nitro0dust-pixel/increadible:{latest,sha-<commit>}` on
pushes to `main`. The GHCR package is private by default; the cluster needs an image pull secret or the
package must be made public.

After each push to `main`, a second job (`verify-published-image`) logs in to GHCR, checks that `:latest` and
`:sha-<commit>` both resolve to the digest that was just pushed, pulls the image **by that digest**, and runs
the same probe (`scripts/probe-image.sh`) against the pulled copy: non-root user, command, architecture, HTTP and
auth behavior, A/B data surviving a container restart on a volume, and Docker's `HEALTHCHECK` reporting healthy.
You can run the probe yourself against any image with `bash scripts/probe-image.sh <image-ref>` (needs Docker, curl and jq).

### HTTP hardening

What the HTTP server does when things go wrong, and the settings that control it. Defaults are chosen so that nothing
changes for a correctly configured deployment, except where a table row says otherwise.

| Setting | Default | Effect |
|---|---|---|
| `AUTH_TOKEN` | none | Bearer token for `/mcp` and `/metrics` (`/health` and `/ready` stay open). **A non-loopback `HOST` (the image uses `0.0.0.0`) without a token, or with an empty or whitespace-only one, now makes the server refuse to start** (exit 1, `Refusing to listen ...`). Before, an empty token silently turned authentication off |
| `ALLOW_UNAUTHENTICATED` | unset | `1`/`true`/`yes` lets a non-loopback `HOST` start without a token, for a deployment where something in front authenticates. A warning is logged. Anything else (including `0`) is not consent |
| `HTTP_HEADERS_TIMEOUT_MS` | `10000` | Time a client gets to send complete request headers (Node's own default is 60000). A slower client gets a 408 and is closed |
| `HTTP_REQUEST_TIMEOUT_MS` | `30000` | Time a client gets to send the whole request (Node's default is 300000). It does not limit how long a tool call may take. `0` disables a timeout |
| `RATE_LIMIT_PER_MINUTE` | `0` (off) | Global token bucket on `POST /mcp`: a burst of this many requests, refilled evenly over a minute. Over the limit: `429` with `Retry-After`, counted in `increadible_http_rejected_total{reason="rate_limited"}`. Global because the bearer token is shared, so there is no per-client key. `/health`, `/ready` and `/metrics` are never limited. **Off by default: no load test has measured a safe number yet** |
| `SHUTDOWN_DRAIN_MS` | `0` | On SIGTERM/SIGINT, keep serving this long with `/ready` answering `503` before closing, so a load balancer can stop sending traffic. `/health` stays `200` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | After closing starts, how long in-flight requests get. Then the remaining connections are cut and the process exits 1 (a clean shutdown exits 0). Without it, one stalled client held the process until the orchestrator's SIGKILL, which leaves the A/B data file lock behind |

The Kubernetes manifests set `SHUTDOWN_DRAIN_MS=5000` and `SHUTDOWN_TIMEOUT_MS=10000` with `terminationGracePeriodSeconds: 30`
(a test keeps drain plus timeout below the grace period).

A tool call that throws is now returned as a tool error (`isError: true`), and a failure outside the tools becomes a
JSON-RPC `-32603 Internal error` (HTTP `500`, cause logged to stderr only). Before, `discover_apis` with a non-string
`query` ended the whole process, in HTTP and stdio mode alike.

Verification and limits:
- Verified locally and in CI: unit tests for each behaviour above (each fails when its fix is removed), `scripts/smoke.sh` with
  real processes (bad tool input over HTTP and stdio, refusal to start open, `/ready` 503 while draining, a stalled client cut at the deadline),
  and `scripts/probe-image.sh` against the real image (bad tool input, refusal without `AUTH_TOKEN`, `docker stop` exits 0 and removes the lock).
- **NOT VERIFIED:** behaviour in a real cluster (none is available here): whether five seconds covers endpoint-removal propagation for your
  load balancer, and the keep-alive timeout against a load balancer's idle timeout (Node's default 5 s is unchanged).
- There is no TLS, per-client limit, request logging or HTTP-level request-latency metric here. Tool-call latency and event-loop delay are exported (see the metrics table under Monitoring).

### The A/B data file: one writer, flushing, growth

- **One writer, enforced.** The server keeps `<AB_DATA_FILE>.lock` next to the data file and refreshes it every 3 seconds.
  A second process on the same file fails at startup with `... is in use by pid N on HOST ...` (same machine, holder alive) or,
  when the holder is on another machine and cannot be checked, after about 17 seconds with `... could not be checked from here`.
  The lock is removed on clean exit and on SIGTERM/SIGINT. After a **crash** it stays; the next start takes it over at once
  when it names a dead process on the same machine (or the same pid, as after a container restart), and otherwise after
  it has gone 15 seconds without a refresh, so a replacement pod that follows a hard kill can wait up to about 15 seconds
  before it listens (the probes allow for it). If a lock is stuck for another reason, delete the `.lock` file.
- **Limits of the lock.** It guards against accidental double starts (two Claude Desktop windows, a second replica on a
  shared volume), not against a hostile or clock-skewed environment. If two processes race for the same stale lock at the same
  instant both can win; each write re-checks the lock and fails with `lock was lost` if it was taken, which keeps the data
  from interleaving. Keep one replica (`strategy: Recreate`, `ReadWriteOnce`), as the manifests do.
- **Flushing.** Without `AB_FSYNC` an acknowledged write survives a process crash but may be lost in an OS crash or power
  loss. `AB_FSYNC=1` flushes every append before the call returns (and the new file's directory entry), at the cost of one
  disk flush per write: **measured at about 0.2 ms per write on a local disk**, which cuts the write ceiling from about 22 000 to about
  3 500 per second (`PERFORMANCE.md`; a network volume will cost more, not measured). It is off by default in the image and **on in both
  manifests** (the owner's decision, from these measurements). Before relying on the ceiling, measure the flush on the deployed volume with
  `scripts/loadtest.js` (scenario `ab-fsync`). If a flush fails the call returns an error, but the line may already be in the file and then shows up after a restart.
- **Growth and memory.** The log is never compacted (about 120 bytes per measurement on disk). Memory does not grow with it: the module keeps
  counts and a running mean and variance per variant and metric, so the server idled at 67 MiB with 8 000 000 measurements, as it does with 50 000
  (measured, Node 24), and `get_experiment_results` takes about 0.05 ms at any size. Startup replays the file in chunks at about 1.1 microseconds
  per measurement at a full core (about 2.6 at half a core, the manifests' limit: 10 s and 20 s for 8 million) **before the HTTP port opens**. The manifests' 1Gi
  volume holds about 8.9 million measurements, which is about 23 s of replay at 0.5 CPU, and a liveness probe alone restarts a pod that has not answered `/health` about
  35 s after it starts. The manifests therefore carry a `startupProbe` (180 s, held in a test at 4 times the full-volume replay at the CPU limit): **widen it if you grow the
  volume or lower the CPU limit**. A network volume was not measured. A warning goes to stderr once the file passes
  `AB_DATA_WARN_BYTES` (code default and manifests: 100 MiB). Rolling up or rotating the file is still an open decision in `ROADMAP.md`; numbers in
  `PERFORMANCE.md`. (Before step 9 every measurement was also held in memory, about 440 to 500 bytes each, which reached the 256Mi limit at roughly
  400 000 to 460 000 measurements.)
- `scripts/smoke.sh` checks all of this with real processes (clean exit, second writer refused, SIGTERM, SIGKILL takeover), and
  `scripts/probe-image.sh` checks it in a real container with `AB_FSYNC=1` (hard-killed container, second container refused), and that a data file of
  500 000 measurements starts and answers inside the 256 MiB memory limit (smoke does the same with a capped Node heap).

### API gateway: live calls (off unless enabled)

`call_api` answers with generated mock data unless an API is listed in `GATEWAY_LIVE_APIS`. Nothing changes for a deployment that does not set it, and the
manifests do not (a config test keeps it that way until the owner decides).

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_LIVE_APIS` | empty: every API answers with mock data | comma-separated API ids, or `*`; an unknown id is noted on stderr and ignored |
| `GATEWAY_TIMEOUT_MS` | 10000 | per call, 100 to 120000 |
| `GATEWAY_MAX_RESPONSE_BYTES` | 1048576 | larger responses are refused; 1024 to 33554432 |
| `GATEWAY_USER_AGENT` | `increadible-gateway` | sent to the provider; Wikimedia asks clients to identify themselves with contact details, so set one before enabling `wikipedia` or `wikidata` |

Credentials come from the environment at call time (names only here; the values are never logged, returned or cached). Provide them from a Secret (`secretKeyRef`), not a
ConfigMap and not the image. An API that is live and whose key is missing fails with the variable's name.

| API | Variable | Sent as |
|---|---|---|
| `openweathermap` | `GATEWAY_KEY_OPENWEATHERMAP` | query parameter `appid` |
| `weatherapi` | `GATEWAY_KEY_WEATHERAPI` | query parameter `key` |
| `finnhub` | `GATEWAY_KEY_FINNHUB` | header `X-Finnhub-Token` |
| `newsapi` | `GATEWAY_KEY_NEWSAPI` | header `X-Api-Key` |
| `coingecko`, `hackernews`, `wikipedia`, `wikidata` | none | none |
| `thesportsdb` | none | the registered URL carries the provider's public test key (`1`) |

`endpoint` and `params` of a `call_api` come from a model, so they are treated as hostile. What the gateway does with them (each point is tested against a real local HTTP
server, and the URL rule also against 60 000 random hostile endpoints):

- only `GET`, only to the API's registered URL: `endpoint` is a path under it (a URL, `//`, `..`, encoded dots or slashes, `?`, `#`, backslashes, spaces and control characters are
  refused); `params` are strings, finite numbers or booleans, at most 30, and cannot set the credential parameter;
- a redirect is never followed (it could carry the request to another host); only JSON is accepted; the time and the size are capped;
- a credential never appears in a result, an error message (an error body that repeats it is scrubbed), a log line or a cache key; failures are not cached;
- what one caller can make the gateway hold or start is bounded: the result cache keeps at most 500 entries and about 16 MiB (the oldest go first; before this, every distinct call added an entry for good, and 2 000 calls with 200 KB of params held 385 MB of heap against the manifests' 256Mi limit), at most 10 live calls run at once and 100 more may wait (a call beyond that is refused with `the gateway is busy`), and one `aggregate_apis` request takes at most 100 calls and runs five of them at a time (it used to start every call it was given at once: 5 000 requested, 5 000 started together).

**NOT VERIFIED:** any real provider (the authoring sandbox cannot reach them; the tests use a local server, and for the built-in registry a mocked `fetch`); each provider's
terms of service and rate limits (there is no per-API limiter; `RATE_LIMIT_PER_MINUTE` is global and off); **egress**: no NetworkPolicy exists, so a pod can reach any host.
Before enabling live calls in a cluster, add an egress policy that allows DNS and only the registered hosts: api.openweathermap.org, api.weatherapi.com, api.coingecko.com,
finnhub.io, newsapi.org, hacker-news.firebaseio.com, en.wikipedia.org, www.wikidata.org, www.thesportsdb.com.

### Software bill of materials

- The `security` job runs `npm sbom --omit=dev --sbom-format cyclonedx`, fails if the result is not CycloneDX or lists no
  component, and keeps it as the `sbom-npm` artifact of the run. It covers the production npm tree only (today: `yaml`).
- The push step also asks BuildKit for an SBOM attestation (`sbom: true`), which covers the operating-system packages and
  the Node runtime in the image as well. **NOT VERIFIED yet:** nothing has read it back. After the first push to `main`
  with this change, from a machine logged in to GHCR, run
  `docker buildx imagetools inspect ghcr.io/nitro0dust-pixel/increadible:latest --format '{{ json .SBOM }}'`
  (command from Docker's attestation documentation) and check that it lists packages.
- Dependabot (`.github/dependabot.yml`) proposes npm, GitHub Actions and Docker updates weekly, never npm or Node
  major bumps. It reads that file from the repository's default branch, so it does nothing until the default branch is `main`.

## Kubernetes (staging verified locally only)

Run this from a machine whose `kubectl` points at the cluster you intend (check `kubectl config current-context`).
Do it in staging first.

```bash
NS=increadible-staging
kubectl create namespace "$NS"
kubectl -n "$NS" create secret generic increadible-secrets --from-literal=auth-token="$(openssl rand -hex 32)"
# Only while the GHCR package is private (see "Pulling a private image" below):
kubectl -n "$NS" create secret docker-registry ghcr-pull --docker-server=ghcr.io \
  --docker-username=<github-user> --docker-password=<token-with-read:packages>
kubectl apply -f k8s/staging-deployment.yaml
# Pin the exact image CI verified instead of the moving :latest tag:
kubectl -n "$NS" set image deploy/increadible increadible=ghcr.io/nitro0dust-pixel/increadible@sha256:<digest>
kubectl -n "$NS" rollout status deploy/increadible
kubectl -n "$NS" port-forward svc/increadible 8080:80   # then: curl localhost:8080/health
```

Take `<digest>` from the `verify-published-image` job log (`DIGEST`), or from
`docker buildx imagetools inspect ghcr.io/nitro0dust-pixel/increadible:sha-<commit> --format '{{json .Manifest}}' | jq -r .digest`.
Pinning by digest matters: production uses `imagePullPolicy: IfNotPresent`, so a rollout that still says `:latest` would
never pick up a newer image.

To check that A/B data really persists on the cluster, call `create_experiment` and `record_metric` through
`POST /mcp` (bearer token = the `auth-token` secret), run `kubectl -n "$NS" rollout restart deploy/increadible`, and
confirm `get_experiment_results` still returns the data.

### Pulling a private image

The manifests list an optional `imagePullSecrets: [{name: ghcr-pull}]`. While the GHCR package is private, the cluster
needs that secret or the pod stays in `ImagePullBackOff`:

- Create it as shown above, with a GitHub token that can read packages (`read:packages`; check GitHub's current
  documentation for which token types GHCR accepts) and your GitHub username. Use a dedicated token with nothing else
  enabled, and set an expiry.
- `ghcr-pull` is namespaced, so create it in every namespace you deploy to (`increadible-staging`, `increadible`).
- If the secret does not exist, Kubernetes still starts the pod and attempts an anonymous pull (a warning event is
  recorded), so the same manifests work unchanged once the package is made public. Making it public is the alternative to
  keeping a pull secret: GitHub package settings, "Change visibility". That is a deliberate decision, since anyone could
  then pull the image.
- Rotate the token by deleting and recreating the secret; running pods are not affected until they next pull.
- Check the result with `kubectl -n "$NS" describe pod -l app=increadible` (look at the Events for pull errors).

Production is the same with `k8s/production-deployment.yaml` and namespace `increadible`, pinned to a digest the same
way. Design choices to be aware of:

- **One replica**, `Recreate` strategy: A/B data is appended to a file on a 1Gi `ReadWriteOnce` PersistentVolumeClaim
  (`increadible-data`, mounted at `/data`), which has a single writer. Do not add an HPA or more replicas.
  Rule hit counts are still in memory. The cluster needs a default StorageClass (or set `storageClassName` in the PVC).
- **Rules are read-only** (ConfigMap mount): edit `increadible-config`, then `kubectl rollout restart`. The
  `update_rules` tool returns an error in this setup, and the live rules are left as they were (the write happens first; before PR #25 the error was returned after the live rules had already changed, and the change was lost at the next restart).
- **ClusterIP only**, protected by `AUTH_TOKEN`. There is no TLS or ingress; add one before exposing it.
- Health endpoints (`/health`, `/ready`) are unauthenticated for the kubelet; `/metrics` and `/mcp` need the token.

### Monitoring (optional, partly verified)

`k8s/monitoring.yaml` needs the Prometheus Operator CRDs and kube-state-metrics, and applies to the `increadible`
namespace. Alerts use only metrics the server emits plus kube-state-metrics restarts (a test enforces that).

| Metric | Type | Meaning |
|---|---|---|
| `increadible_tool_calls_total{tool}` | counter | tool calls by tool |
| `increadible_tool_errors_total{tool}` | counter | tool calls that returned an error |
| `increadible_tool_call_duration_seconds{tool}` | histogram | time to handle a tool call, 1 ms to 10 s buckets; includes calls that failed. One series set per real tool (13), never per request input |
| `increadible_event_loop_delay_seconds` | histogram | how much later than due the event loop ran a 10 ms timer, same buckets (HTTP mode only). While a synchronous task holds the loop, nothing is read and no probe is answered, and no timer inside a handler can see it: this is where it shows. An idle server is almost entirely in the first bucket |
| `increadible_rpc_errors_total` | counter | JSON-RPC protocol errors |
| `increadible_http_rejected_total{reason}` | counter | requests refused before the handler: `unauthorized` (401), `rate_limited` (429), `payload_too_large` (413) |
| `increadible_uptime_seconds` | gauge | seconds since start |

| Alert | Fires when | Status |
|---|---|---|
| `IncreadibleDown` | the target is not up, or has no `up` series at all (Deployment gone, ServiceMonitor not matching), for 2 minutes | critical |
| `IncreadibleToolErrorRate` | more than 5% of tool calls return errors for 10 minutes | warning |
| `IncreadibleProtocolErrors` | more than 0.1 protocol errors per second for 10 minutes | warning |
| `IncreadibleSlowToolCalls` | the 95th percentile tool call latency is above 1 s for 10 minutes | warning, **provisional threshold**: no baseline exists (tool calls take well under a millisecond today); revisit with the load test and when the gateway makes real external calls |
| `IncreadibleEventLoopBlocked` | at least one tick of the event loop ran more than 1 s late in the last 5 minutes (probes fail while it is blocked) | warning. 1 s is the kubelet's default probe timeout, so the threshold is not arbitrary |
| `IncreadiblePodRestarting` | more than 2 container restarts in 30 minutes | warning |

**What is verified.** `scripts/check-prometheus.sh` extracts the rules from the `PrometheusRule` and runs `promtool check rules` and
`promtool test rules` against `monitoring/alerts.test.yaml`: every alert has a case that must fire and one that must stay quiet
(for example 6% errors fires and 4% does not), and each of seven deliberate breakages of the rules is caught (four more for `IncreadibleEventLoopBlocked`: a wrong bucket, a wrong threshold, a missing `ignoring(le)` and a flipped sign; and the two `IncreadibleDown` cases for a vanished target fail against the earlier `up == 0` rule). CI runs it as the
`prometheus` job. `scripts/install-promtool.sh <dir>` builds the promtool for it from one pinned Prometheus release (module
`v0.315.0`), checked against the Go checksum database and an `h1:` hash pinned in the script; it needs Go and `jq` (both on the
GitHub runner image) and takes about 70 seconds from a cold build cache on four cores and 2 minutes 37 seconds on the GitHub-hosted runner (first CI run), which makes this job the longest of the run. It leaves out the cloud service-discovery code (`-tags remove_all_sd`), which the two checks do not use, so `promtool check config` is not available from that build.

**What is not.** The rules have not run against a live Prometheus (none is available here), the `ServiceMonitor` has not scraped
anything, and there is no dashboard and no cost metric.

## Rollback

`kubectl -n increadible rollout undo deploy/increadible`, or `kubectl set image` back to the previous `sha-` tag.
