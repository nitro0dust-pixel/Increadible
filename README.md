# Increadible

A bundle of cost- and workflow-oriented components for Claude Desktop / MCP clients.
This repository contains **three components we wrote** (Features #7-#9, served by one
MCP server) and **vendors six third-party projects as git submodules** (Features #1-#6; #3 has two, Token Optimizer and Headroom).

> **Status honesty:** nothing in this repo has been deployed to a cluster, security-scanned or
> independently reviewed, and it has been load-tested only on one machine ([PERFORMANCE.md](PERFORMANCE.md)). Cost and quality figures quoted by upstream
> projects are *not* verified here. See [Limitations](#limitations).

To drive the server with real requests (over stdio the way Claude Desktop does, over HTTP, as a protocol probe, or from the unpacked Desktop package) see [docs/DRIVERS.md](docs/DRIVERS.md); all of them at once, and the multi-agent workflows around them, are in [docs/DRIVERS-WORKFLOW.md](docs/DRIVERS-WORKFLOW.md). Tools that run *beside* this server (and why `agentacct` is not the savings instrument) are in [COMPANIONS.md](COMPANIONS.md); the research and recommendation for a universal API gateway (option A approved on 2026-10-10; being built step by step in [docs/GATEWAY-GATED-CATALOG.md](docs/GATEWAY-GATED-CATALOG.md)) are in [GATEWAY.md](GATEWAY.md). The index of every document is [docs/README.md](docs/README.md); how to change the code is [CONTRIBUTING.md](CONTRIBUTING.md), the security posture [SECURITY.md](SECURITY.md), and the global Claude skill that carries all of it is [skills/omniroute-mcp/SKILL.md](skills/omniroute-mcp/SKILL.md). The full account of the code audit (every finding, fix and observation, in order, and what was not verified) is [AUDIT.md](AUDIT.md). Project status, the plan and open decisions are tracked in [ROADMAP.md](ROADMAP.md); what changed and when in
[CHANGELOG.md](CHANGELOG.md); working rules and context for Claude sessions in [CLAUDE.md](CLAUDE.md).

## Components

| # | Component | Source | Tested in this repo |
|---|-----------|--------|---------------------|
| 1 | OmniRoute (multi-provider routing) | submodule `features/01-omniroute/OmniRoute` ([upstream](https://github.com/diegosouzapw/OmniRoute)) | no |
| 2 | Claude-Mem (persistent memory) | submodule `features/02-claude-mem/claude-mem` ([upstream](https://github.com/thedotmack/claude-mem)) | no |
| 3 | Token Optimizer MCP | submodule `features/03-token-optimizer/token-optimizer-mcp` ([upstream](https://github.com/ooples/token-optimizer-mcp)) | no |
| 3b | Headroom (context trimming) | submodule `features/03-headroom/headroom` ([upstream](https://github.com/lea-blum/headroom-mini-token-optimizer)) | no |
| 4 | gstack (workflow automation) | submodule `features/04-gstack/gstack` ([upstream](https://github.com/garrytan/gstack)) | no |
| 6 | agentacct (cost tracking) | submodule `features/06-agentacct/agentacct` ([upstream](https://github.com/mikehasa/agentacct)) | no |
| 7 | Routing Plugins | `features/07-routing-plugins/src/mcp-server.ts` | yes |
| 8 | A/B Testing | `features/08-ab-testing/src/mcp-server.ts` | yes |
| 9 | API Gateway | `features/09-api-gateway/src/mcp-server.ts` | yes (mock data by default; opt-in live calls, verified for the four keyless APIs only (coingecko, hackernews, wikipedia, wikidata: one real call each from Claude Desktop on the owner's Windows PC, 2026-10-10, package 1.0.3); the key-based APIs have never run live) |

Each feature has an `INTEGRATION_GUIDE.md` next to its code or submodule. Features #1-#6 are
documented by their upstream READMEs; the guides here only describe how they fit together.

## Quick start

```bash
git clone --recurse-submodules https://github.com/nitro0dust-pixel/Increadible.git
cd Increadible
npm install
npm run build
```

### Claude Desktop (stdio)

The complete guide from nothing to a running server (prerequisites, where to keep your data, verification, upkeep) is [docs/INSTALL-CLAUDE-DESKTOP.md](docs/INSTALL-CLAUDE-DESKTOP.md); if something fails, [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Every path in the config must be **absolute**, and without `AB_DATA_FILE` all A/B data is lost when Claude Desktop quits. For a one-click install build the `.mcpb` package with `npm run mcpb` (details in the guide, Path A); it asks for a data folder and sets these variables itself.

```json
{
  "mcpServers": {
    "increadible": {
      "command": "node",
      "args": ["/absolute/path/to/Increadible/dist/src/index.js"],
      "env": {
        "RULES_FILE": "/absolute/path/to/rules.yaml",
        "EXPERIMENTS_FILE": "/absolute/path/to/experiments.yaml",
        "AB_DATA_FILE": "/absolute/path/to/ab-data.jsonl"
      }
    }
  }
}
```

### HTTP mode (containers)

```bash
PORT=3000 HOST=0.0.0.0 AUTH_TOKEN=change-me node dist/src/index.js
```

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET`/`HEAD` `/health`, `/ready` | none | liveness / readiness (`/ready` answers 503 while the server drains for shutdown). A query string is ignored |
| `GET /metrics` | bearer token if `AUTH_TOKEN` set | Prometheus text format |
| `POST /mcp` | bearer token if `AUTH_TOKEN` set | one JSON-RPC 2.0 message per request (stateless). `jsonrpc` must be `"2.0"` and `id` a string, a number or null; a request without an `id` is a notification: it is carried out and gets no reply (HTTP 202). The `Bearer` scheme name is case-insensitive |

`HOST` defaults to `127.0.0.1`. If you bind to `0.0.0.0` (or any non-loopback address) you must set `AUTH_TOKEN`: the server
refuses to start otherwise, unless `ALLOW_UNAUTHENTICATED=1` says something in front authenticates. Other HTTP settings:
`ALLOWED_ORIGINS`, `HTTP_HEADERS_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `RATE_LIMIT_PER_MINUTE` (off by default), `SHUTDOWN_DRAIN_MS` and
`SHUTDOWN_TIMEOUT_MS`; see "HTTP hardening" in `DEPLOYMENT.md`.

**Web pages and protocol versions.** A request that carries an `Origin` header (only a web page sends one; Claude Desktop, scripts and servers do not) is refused with `403` unless its origin is listed in `ALLOWED_ORIGINS` (comma-separated, for example `https://app.example.com`; nothing is listed by default). The check comes before the token check and also protects a server started without a token. `GET` and `DELETE` on `/mcp` answer `405` with `Allow: POST` (no event stream, no sessions). An `MCP-Protocol-Version` header naming a revision the server does not speak is refused with `400`; the server speaks `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25`, and `initialize` answers the revision the client names if it is one of them and `2025-11-25` otherwise.
Emitted metrics: `increadible_uptime_seconds`, `increadible_tool_calls_total{tool}`,
`increadible_tool_errors_total{tool}`, `increadible_tool_call_duration_seconds{tool}` (histogram),
`increadible_event_loop_delay_seconds` (histogram: how late the event loop ran a 10 ms timer; HTTP mode),
`increadible_rpc_errors_total`, `increadible_http_rejected_total{reason}`.

## Tools (13)

| Tool | Component | Purpose |
|------|-----------|---------|
| `apply_routing_rules` | #7 | Pick a provider for a request from YAML rules |
| `get_rule_stats` | #7 | Rule hit counts and provider breakdown |
| `update_rules` | #7 | Replace the rule set (validated, written to `RULES_FILE` first and only then made live, so a failed write changes nothing) |
| `suggest_rules` | #7 | Suggestion based on observed provider share |
| `create_experiment` | #8 | Define an experiment with two to ten variants |
| `assign_variant` | #8 | Assign a variant (sticky per `user_id` if given) |
| `record_metric` | #8 | Record numeric metrics for a variant |
| `get_experiment_results` | #8 | Per-variant stats and significance test |
| `recommend_winner` | #8 | Winner only if statistically significant |
| `discover_apis` | #9 | Search the API registry |
| `call_api` | #9 | Call a registered API (cached 5 min) |
| `aggregate_apis` | #9 | Up to 100 calls, five at a time; each item names the API with `id` (not `api_id`); a call that fails does not discard the others |
| `get_api_stats` | #9 | Call counts and cache hit rate |

## Behavior reference

**Routing rules** (`RULES_FILE`, default `./rules.yaml`; built-in defaults if the file is missing, unparseable, or holds any rule that `update_rules` would refuse: a rule needs a unique non-empty string `id`, a string `provider`, a finite number `priority`, a boolean `enabled` and an object `match` (not a list), and `fallback`, if present, is a list of provider names; at most 500 rules and 1 MB):

```yaml
metadata: { team: Engineering, version: "1.0", last_updated: "2026-01-01T00:00:00Z" }
rules:
  - id: simple-tasks            # required
    name: Simple questions
    enabled: true               # required
    priority: 10                # required; lower number is evaluated first
    match:                      # required; every key must be present in the request and equal
      task_complexity: low      #   (a list value means "any of")
      task_type: [qa, summary]
    provider: claude-haiku      # required
    fallback: [claude-sonnet]
    reason: Haiku is enough for low-complexity tasks
```

First enabled rule whose `match` fits wins; an empty `match` matches everything.

**A/B testing** (`EXPERIMENTS_FILE`, optional):
- Two to ten variants. With two, `traffic_split` is the share sent to the first (default 0.5); with more, traffic is shared
  equally, or by `weights` (relative numbers, one per variant, which override `traffic_split`). Assignment by user id is sticky.
- Results stay `incomplete` until there are >= 100 measurements and >= 30 per variant.
- Significance: Welch's t-test (normal approximation of t), two-sided, alpha = 0.05, on the
  **primary** metric: the first metric unless the experiment sets `primary_metric`. The higher mean is better unless the
  metric sets `direction: lower_is_better` (cost, latency, error rate). `confidence = 1 - p`. A winner is named
  only if p < 0.05. Per-metric Cohen's d and a 95% CI of the mean are reported (the interval uses the exact Student-t critical value up to 30 values and a formula within 0.2% of it above). The p-value uses an approximation of the t distribution that was checked against the exact one: from 25 degrees of freedom up it calls a result significant only if its true p is below 0.0497 or so (0.0482 at 10, 0.0417 at 5), so below that it errs towards not declaring a winner and never towards a false one. **With more than two variants** every pair is
  tested and a variant wins only if it is significantly better than **every** other one after Holm's correction over all
  pairs (so comparing many variants does not make a lucky difference look significant); `confidence` is then that of the
  leader's weakest comparison, and the result lists each pair in `comparisons`.
- **What a write may carry:** a new experiment needs non-empty, unique ids (at most 200 characters, never `__proto__`) for itself, every variant and every metric, keeps only the fields the module uses, and its definition may be at most 64 KB. `record_metric` takes an object whose keys are metrics the experiment defines (an unknown key is an error that names the valid ones; it used to be stored and ignored, so a misspelt id lost its data silently) and whose values are finite numbers between -1e15 and 1e15 (one `1.7e308` used to make the mean, deviation, interval, p-value and confidence of the experiment `null` for good, because the log is append-only). `user_id` is a string or a number. Every tool answers an unknown experiment with an error. A data file or YAML written before these rules still loads: they apply to new writes only.
- **Guardrails:** a metric with `guardrail: true` never picks a winner but can withhold one: if the leading variant is
  significantly worse on it, or it has too little data to judge, the result names no winner and says which guardrail held
  it back (`winner_withheld_by`). "Not significantly worse" is weaker than "not worse" on small samples; read the p-value.
- **Persistence:** set `AB_DATA_FILE` to keep experiments and measurements across restarts. Every
  `create_experiment` and `record_metric` is appended to that JSONL file *before* it takes effect (if the write
  fails, the call returns an error and nothing is recorded), and the file is replayed on startup.
  Unset, data lives in memory only (the Docker image and `k8s/` manifests set it to `/data/ab-data.jsonl`).
  Details: the file is created `0600`; unreadable or torn lines are skipped with a note on stderr; creating an
  experiment with an existing id is rejected; definitions in `EXPERIMENTS_FILE` win over a logged experiment with the
  same id; the file grows by about 120 bytes per measurement (measured) and is never compacted. **Memory does not grow with it**: the module
  keeps only counts and a running mean and variance per variant and metric (the raw values stay in the file), so a results call takes the same time at any size, and
  startup replays the file in chunks (about 1.1 microseconds per measurement at a full core, 2.6 at half a core: 10 s and 20 s for 8 million, measured). A warning is logged once the file passes
  `AB_DATA_WARN_BYTES` (default 100 MB, which the `k8s/` manifests also set: 10% of their 1Gi volume). Numbers and limits: [PERFORMANCE.md](PERFORMANCE.md).
  - **One writer:** a second process on the same file is refused at startup, naming the process that holds it
    (`<file>.lock`, refreshed every 3 s, removed on clean exit and on SIGTERM/SIGINT; the lock of a crashed process is
    taken over; every write re-checks it and fails if it was lost). Details and limits: `DEPLOYMENT.md`.
  - **Desktop clients:** Claude Desktop starts several copies of one server with the same data folder and kills them at will, and a
    server that opens its data file at start-up crashes or freezes before it has answered. `AB_LAZY_OPEN=1` (the `.mcpb` package sets it) opens
    the data on the first A/B tool call instead: the handshake and the other tools never depend on the file, a held or unusable file is the
    error of that one call, and the next call tries again. The default stays to open at start-up and refuse at once, which a container wants.
  - **Durability:** by default an append is handed to the OS, which survives a process crash but not an OS crash or power
    loss. Set `AB_FSYNC=1` to flush each append to disk first (slower: one flush per write, about 0.2 ms on a local disk; see [PERFORMANCE.md](PERFORMANCE.md)). The Kubernetes manifests set it; the image does not.

**API gateway:** the registry has 9 APIs (weather, finance, news, reference, sports). By default `call_api`
returns **generated mock data** and makes no network calls (every `call_api` result and every successful `aggregate_apis` item says `"source": "mock"`). Real HTTP calls are **opt-in per
API**: set `GATEWAY_LIVE_APIS` to a comma-separated list of API ids (or `*`); `GATEWAY_TIMEOUT_MS`, `GATEWAY_MAX_RESPONSE_BYTES` and
`GATEWAY_CONTACT` (your email address or a URL, sent as `increadible-gateway/<version> (<contact>)`; Wikimedia requires one, and in production, `NODE_ENV=production`, live Wikipedia and Wikidata calls are refused without it; `GATEWAY_USER_AGENT` still sets the whole header for existing deployments) tune them, `GATEWAY_RATE_LIMITS` (e.g. `coingecko=30`) caps the live calls per API per rolling minute and `GATEWAY_DEFAULT_RATE_LIMIT` (default 5, the project's own conservative choice) caps every API without its own entry, `GATEWAY_RETRIES` (default 1) and `GATEWAY_RETRY_MAX_WAIT_MS` (default 5000) bound the retries after an HTTP 429, 502, 503, 504 or a dropped connection, a 429 starts a cooldown for that API (its Retry-After, or a minute), and the four key-based APIs read their key from `GATEWAY_KEY_<API>` (names and the security rules in
`DEPLOYMENT.md`). In the Claude Desktop package (1.0.3 and later) the same switch is the setting **Live APIs (real calls)**, empty by default
(`docs/INSTALL-CLAUDE-DESKTOP.md`, section 5.3). Live mode was tested against a local HTTP server, and against the real providers only for the four keyless APIs (one call each from Claude Desktop, 2026-10-10); the key-based APIs have **never run live**. Results are cached for 5 minutes, at most 500 results and about 16 MiB (the oldest go first). At most 10 live calls run at once across the gateway, up to 100 more wait for a slot and anything beyond that is refused at once; an `aggregate_apis` request takes up to 100 calls and a call that fails holds its own `{error}` in the result instead of failing the request.

## Development

| Command | What it does |
|---------|--------------|
| `npm run type-check` | `tsc --noEmit` over our code and tests |
| `npm run lint` | ESLint over our code and tests |
| `npm test` | Jest (real-code tests for #7-#9 and both transports) |
| `npm run build` | Compile to `dist/` (tests excluded) |
| `npm run verify` | Type-check, lint, tests (a run that skipped a suite fails), build and smoke test; also the Docker build and the alert-rule check when Docker and `promtool` exist, otherwise those lines say `NOT AVAILABLE`. The first line names the commit and whether the tree was clean |
| `bash scripts/cleanroom.sh [commit]` | `verify` on exactly what git has committed: exports `HEAD` (or the commit given) with `git archive` into an empty directory, runs `npm ci`, then `verify`. Files in your working copy cannot change the result |

**Node for development:** the server runs on Node 22 or later (24 in the image and CI); `npm run lint` uses ESLint 10, which needs 22.13 or later (or 20.19 / 24).

**Windows:** `type-check`, `lint`, `test` and `build` work from PowerShell. `npm run smoke`, `npm run verify` and the `scripts/*.sh`
probes are bash scripts: run them from Git Bash or WSL (not yet verified on Windows). The repo forces LF line endings
(`.gitattributes`); if you cloned before that landed, re-clone or run `git add --renormalize .`.

Layout: `src/` (server + transports), `features/07..09/*/src/` (our modules), `tests/`,
`k8s/` (example manifests), `Dockerfile`.

## Limitations

- Cost-savings and quality percentages (e.g. "99.98%") are **targets, not measurements**. To
  measure real savings, run agentacct (#6) against real usage and compare to a baseline.
- Only `k8s/staging-deployment.yaml` has been applied to a cluster (a local Docker Desktop one, with a locally built image).
  The production and monitoring manifests have not been applied, and the GHCR pull path has not been exercised on a cluster.
- Features #1-#6 are not exercised by this repo's tests (see the `todo` list in `tests/e2e-integration.test.ts`).
- `call_api` returns mock data unless live calls are enabled (`GATEWAY_LIVE_APIS`), and live calls have not been tried against the real providers. A/B persistence needs `AB_DATA_FILE`, is single-writer (enforced with a lock file), flushes to disk only with `AB_FSYNC=1`, and is never compacted (memory and query time do not grow with the data: it keeps running aggregates; see [PERFORMANCE.md](PERFORMANCE.md)).
