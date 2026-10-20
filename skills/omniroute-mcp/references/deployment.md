<!-- Copy of DEPLOYMENT.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Deployment

> **Verification status:** the server is tested locally (`npm run verify`) and CI builds and probes the
> Docker image. **One private rehearsal runs on Railway** (stage 1, 2026-10-10, section "Railway"); nothing else runs in a real
> environment. `k8s/staging-deployment.yaml` has been applied once
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
npm run mcpb                                # the one-click Claude Desktop package, dist/mcpb/increadible-<version>.mcpb (docs/INSTALL-CLAUDE-DESKTOP.md, Path A)
```

## Docker

```bash
docker build -t increadible .
docker run --rm -p 3000:3000 -e AUTH_TOKEN="$(openssl rand -hex 32)" increadible
curl localhost:3000/health
```

Config via env: `PORT` (3000), `HOST` (0.0.0.0 in the image, 127.0.0.1 otherwise), `AUTH_TOKEN`,
`RULES_FILE` (/data/rules.yaml), `EXPERIMENTS_FILE` (/data/experiments.yaml), `AB_DATA_FILE`
(/data/ab-data.jsonl), and optionally `AB_FSYNC` (`1` flushes every A/B append to disk; off in the image, on in the manifests), `AB_LAZY_OPEN` (`1` opens the A/B data on the first A/B tool call instead of at start-up: for desktop clients, **off in the image and the manifests**, where a second copy on the volume must be refused at once) and `AB_DATA_WARN_BYTES`
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
- **A client that starts several copies (Claude Desktop).** A copy that cannot take the lock at start-up exits at once (a live holder) or waits up to 17 s without answering (a lock it cannot check), and the client's first request then times out. With `AB_LAZY_OPEN=1` nothing is opened until an A/B tool is called: the handshake and the routing and gateway tools always answer, and a held or unusable data file is the error of that one A/B call (the next call tries again; the lock is never waited for inside a call). Do not set it for a container: there a second copy on the volume should not start. On Windows the data folder itself is not flushed (it cannot be; the file is).
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
| `GATEWAY_CONTACT` | empty: no contact | an email address or an http(s) URL where a provider can reach the operator; the User-Agent becomes `increadible-gateway/<version> (<contact>)`. Wikimedia's User-Agent policy requires a contact: without one, live `wikipedia` and `wikidata` calls get a start-up warning, and in production (`NODE_ENV=production`, as the image sets) they are **refused before anything is sent**. A value that is neither is noted on stderr and not used; nothing is ever made up |
| `GATEWAY_USER_AGENT` | `increadible-gateway/<version>` (with `GATEWAY_CONTACT` when set) | the whole User-Agent header, for existing deployments; when set it wins over `GATEWAY_CONTACT`, and its contact (an email address or URL anywhere in it) is what the Wikimedia rule checks |
| `GATEWAY_RATE_LIMITS` | empty: no API has a limit of its own | per-API limit of live calls in any rolling minute, e.g. `coingecko=30,wikipedia=60` (1 to 100000 each); it wins over the default below. A call over the limit is refused before it reaches the provider (`rate limit reached ... try again in N s`) and counted in `get_api_stats` as `rate_limited`; cache hits and sample answers do not count; a call the provider answered with an error does, and so does each retry. One process, one count: replicas would each count their own (the manifests run one). An entry that cannot be read, or names an unknown API, is noted on stderr and limits nothing. **No per-API value is set anywhere**: only HN's limit was read on its own page ("no rate limit"); the rest are unverified (`docs/GATEWAY-GATED-CATALOG.md`, section 11) |
| `GATEWAY_DEFAULT_RATE_LIMIT` | 5 | live calls per rolling minute for every API without its own `GATEWAY_RATE_LIMITS` entry; 0 turns it off; 0 to 100000. **The project's own conservative choice, not a provider's number**: it is the lowest figure any source gave for any live API (CoinGecko's keyless API, 5 to 15 a minute, from third parties) |
| `GATEWAY_RETRIES` | 1 | retries of one live call after an HTTP 429, 502, 503 or 504, or a dropped connection (`ECONNRESET`, `EPIPE`, `EAI_AGAIN`); never after a timeout or any other error; 0 to 3. A call therefore takes at most (1 + retries) times `GATEWAY_TIMEOUT_MS` plus the waits (25 s with the defaults). Counted in `get_api_stats` as `retries` |
| `GATEWAY_RETRY_MAX_WAIT_MS` | 5000 | the longest wait before a retry, 0 to 60000. The wait is the provider's `Retry-After` (seconds or an HTTP date) when it sent one, else 1 s, 2 s, 4 s; a longer `Retry-After` is not waited for and the error goes back. After a 429 (or a 503 with `Retry-After`) the API **cools down**: no live call is sent to it until the `Retry-After` has passed, or for a minute when there was none (`cooldown_refused`, `cooldowns` and `throttled` in `get_api_stats`) |

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
terms of service and rate limits (2026-10-12: only HN's README was read on the provider's page; the rest come from search summaries, `docs/GATEWAY-GATED-CATALOG.md` section 11. The default limit of 5 calls a minute per API is the project's own choice; `RATE_LIMIT_PER_MINUTE` is global and off).

**Egress (outbound connections)**, in two layers; both are **NOT VERIFIED on a cluster** (none is available to this project), only checked by `tests/egress-policy.test.ts`:

| Layer | File | What it allows | Where it works |
|---|---|---|---|
| Always | the NetworkPolicy `increadible-egress` in `k8s/staging-deployment.yaml` and `k8s/production-deployment.yaml` | DNS (port 53, UDP and TCP) and nothing else. Live calls are off in these manifests, so the server needs no outbound connection; one that is tried anyway is refused by the cluster. Ingress is not restricted by it | any network plugin that enforces NetworkPolicy (some, such as plain flannel, ignore it silently) |
| With live calls | `k8s/egress-live-cilium.yaml`, a `CiliumNetworkPolicy` applied with `kubectl -n <namespace> apply -f`, together with setting `GATEWAY_LIVE_APIS` | HTTPS (443) to exactly the four keyless providers: api.coingecko.com, hacker-news.firebaseio.com, en.wikipedia.org, www.wikidata.org | **Cilium only.** Standard NetworkPolicy matches IP addresses, not host names, and these providers sit behind CDNs whose addresses change. On another plugin, use an egress proxy or that plugin's name-based policy |

Without the second layer, the first one refuses every live call, so turning live calls on in a cluster is a deliberate two-part change. The DNS rule is open to any destination (not only the
cluster's resolver) so that NodeLocal DNSCache and differently labelled resolvers keep working; DNS itself remains a channel a compromised process could misuse, which no policy here closes.
Switching a key-based API to live needs its host added to the Cilium policy (a test holds the list to the catalog's keyless APIs, so that change is deliberate too). The other registered hosts
are api.openweathermap.org, api.weatherapi.com, finnhub.io, newsapi.org and www.thesportsdb.com.
Beyond the tests, both kinds were decoded once (2026-10-10, in a scratch Go program, not in CI) with the projects' own types, rejecting unknown fields: the NetworkPolicies with `k8s.io/api` v0.31.0 (`networking/v1`), the Cilium policy with `github.com/cilium/cilium` v1.16.5 (`cilium.io/v2`) and its rule parser; all passed, and a misspelt field and an invalid host name were each refused. That checks the shape, not a cluster's behaviour.
**Railway** has no egress policy: there the evidence is its DNS log, which showed only the four keyless providers' hosts (section "Railway").

### Software bill of materials

- The `security` job runs `npm sbom --omit=dev --sbom-format cyclonedx`, fails if the result is not CycloneDX or lists no
  component, and keeps it as the `sbom-npm` artifact of the run. It covers the production npm tree only (today: `yaml`).
- The push step also asks BuildKit for an SBOM attestation (`sbom: true`), which covers the operating-system packages and
  the Node runtime in the image as well. **NOT VERIFIED yet:** nothing has read it back. After the first push to `main`
  with this change, from a machine logged in to GHCR, run
  `docker buildx imagetools inspect ghcr.io/nitro0dust-pixel/increadible:latest --format '{{ json .SBOM }}'`
  (command from Docker's attestation documentation) and check that it lists packages.
- Dependabot (`.github/dependabot.yml`) proposes npm, GitHub Actions and Docker updates weekly, never npm or Node
  major bumps. It reads that file from the repository's default branch, which is `main` since 2026-10-09, so it is active.

## Railway (stages 1 and 2: private rehearsal, then live data; both verified 2026-10-10)

The owner chose Railway for the first hosted run and approved it in stages. **Stages 1 (private rehearsal) and 2 (the four keyless
APIs live) are done**; stage 3 (a client connected end to end) needs the owner's approval.

**Current state, 2026-10-17 (recorded after the change, not a sign-off):** the service is pinned to commit `020e6e3` (`main` after PR #72, not a tag: `v1.0.5` is not on GitHub yet), built from the `Dockerfile` (it had been on RAILPACK), with `GATEWAY_CONTACT` and `GATEWAY_USER_AGENT` set to the owner's contact address (the address is not written here). Deployment `fdcf4c58` is `SUCCESS` (created 00:09 UTC). Its startup log shows `User-Agent contact: set`, the four keyless APIs live, and `listening on http://0.0.0.0:3000`. The owner confirmed `/health` and `/ready` answer `{"status":"ok"}`. `/mcp` answers `Unauthorized` without the token, as designed. **Stage 3 is not verified:** no client has been connected through the token, and the Claude Desktop connection path is unconfirmed.

| Setting | Value | Why |
|---|---|---|
| Project, service | `increadible-rehearsal`, service `increadible` (its own project, apart from the owner's others) | nothing else shares it |
| Source | this repository, set to commit `916206f` (`v1.0.3`), built from the `Dockerfile` | **the pin does not hold for every redeploy**: on 2026-10-10 a redeploy caused by changing variables built the head of `main` (`aa0d616`) although the service still showed the pin; its build inputs (`src`, `features/07-09/src`, `Dockerfile`, `package*.json`, `tsconfig*.json`, `scripts/clean.js`, `LICENSE`, `.dockerignore`) were identical to `916206f`'s, and the service was then redeployed from `916206f` explicitly. A merge into `main` did not start a deploy: after the merges of PR #49 (01:13 UTC) and PR #50 (01:25 UTC) the latest deployment was still `77145da4`, from `916206f` (Railway's deployment list, read 2026-10-10). **Since PR #50, `main` changes the build inputs** (`features/09-api-gateway/src`), so a redeploy that takes `main` again would now run different code from `v1.0.3`. Check the commit of the running deployment after any change |
| Replicas | 1 | the A/B data file has one writer |
| Volume | `increadible-data` at `/data` | `RULES_FILE`, `EXPERIMENTS_FILE`, `AB_DATA_FILE` already point there (`Dockerfile`) |
| Variables | `AUTH_TOKEN` (64 random hex characters, set on the service, never printed or committed), `PORT=3000`, `AB_FSYNC=1`, `RAILWAY_RUN_UID=0` | the server refuses to start on `0.0.0.0` without a token; durable writes as in the manifests |
| Live gateway | stage 1: off. Stage 2: `GATEWAY_LIVE_APIS=coingecko,hackernews,wikipedia,wikidata` and `GATEWAY_USER_AGENT` set to the owner's contact | the four keyless APIs only; no API key is stored on Railway. The image runs with `NODE_ENV=production`, so from the next deploy Wikimedia calls are refused if that contact is ever removed; `GATEWAY_CONTACT` is the newer way to give it |
| Address | `https://increadible-production.up.railway.app` (Railway's domain, HTTPS) | `/health` and `/ready` are open; `/mcp` and `/metrics` need the token |

**`RAILWAY_RUN_UID=0` runs the container as root.** Railway mounts volumes as root (its documentation, "Volumes", *Permissions*
and *Caveats*), and the image runs as the non-root user `node`, which could not write `/data` otherwise. This undoes one hardening
of the image on Railway only (`SECURITY.md`). Not tried: preparing the volume's ownership another way.

**Checked on 2026-10-10** (from the owner's PC, because the authoring sandbox's network policy refuses the Railway domain; Railway's
own build, deploy and request logs read from here):

| Check | Result |
|---|---|
| Build | from `916206f` with the `Dockerfile`, image `sha256:36d22c5a...`; deployment `SUCCESS` |
| `GET /health` | 200, `{"status":"ok"}` |
| `POST /mcp` without the token | 401 |
| `tools/list` with the token | 13 tools |
| `create_experiment`, then `record_metric` (variant A, `score` 8) | `success`, `recorded` |
| `get_api_stats` | `live_apis: []` (sample data only) |
| Restart (`restart-service`), then `get_experiment_results` | the old process logged `SIGTERM`, the new one `Restored 1 experiments and 1 measurements from /data/ab-data.jsonl`, and the call answered `current_samples: 1`: **A/B data survives a restart on the Railway volume** |
| Railway's request log | the six probe calls and the one after the restart, with the status codes above |

**Stage 2, checked on 2026-10-10:** the variables above made Railway redeploy (and redeploy again from `916206f` explicitly, see
*Source*); the new process logged `Live API calls enabled for: coingecko, hackernews, wikipedia, wikidata` and again restored the
experiment and its measurement, so **the A/B data also survives a redeploy from a fresh build**. From the owner's PC, one `call_api` each
answered `source: "live"` with no error: coingecko `/simple/price`, hackernews `/maxitem.json`, a wikipedia search, a wikidata
`wbsearchentities`; `get_api_stats` then 4 calls, 4 successful, 4 live, 0 failed. Railway's DNS log shows that the container looked up
exactly these four providers' hosts (`api.coingecko.com`, `hacker-news.firebaseio.com`, `en.wikipedia.org`, `www.wikidata.org`) and no
other, so the calls left from Railway (region `sfo`) and only to the registered hosts.

**Not checked:** the volume's backups, load, the price of the plan, and whether
Claude Desktop or claude.ai can use this server remotely (it takes a static bearer token; claude.ai's remote connectors use OAuth).

To repeat the probe, from PowerShell (the token is read from the Railway dashboard, service *Variables*, and never pasted into a
chat or a file):

```powershell
$u = "https://increadible-production.up.railway.app"
Invoke-RestMethod "$u/health"
$s = Read-Host "AUTH_TOKEN" -AsSecureString
$t = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$h = @{ Authorization = "Bearer $t" }
(Invoke-RestMethod -Method Post "$u/mcp" -Headers $h -ContentType application/json -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}').result.tools.Count
```

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
