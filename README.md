# Increadible

A bundle of cost- and workflow-oriented components for Claude Desktop / MCP clients.
This repository contains **three components we wrote** (Features #7-#9, served by one
MCP server) and **vendors five third-party projects as git submodules** (Features #1-#6).

> **Status honesty:** nothing in this repo has been deployed to a cluster, security-scanned or
> independently reviewed, and it has been load-tested only on one machine ([PERFORMANCE.md](PERFORMANCE.md)). Cost and quality figures quoted by upstream
> projects are *not* verified here. See [Limitations](#limitations).

Project status, the plan and open decisions are tracked in [ROADMAP.md](ROADMAP.md); what changed and when in
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
| 9 | API Gateway | `features/09-api-gateway/src/mcp-server.ts` | yes (mock data only) |

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
| `GET /health`, `GET /ready` | none | liveness / readiness (`/ready` answers 503 while the server drains for shutdown) |
| `GET /metrics` | bearer token if `AUTH_TOKEN` set | Prometheus text format |
| `POST /mcp` | bearer token if `AUTH_TOKEN` set | one JSON-RPC message per request (stateless) |

`HOST` defaults to `127.0.0.1`. If you bind to `0.0.0.0` (or any non-loopback address) you must set `AUTH_TOKEN`: the server
refuses to start otherwise, unless `ALLOW_UNAUTHENTICATED=1` says something in front authenticates. Other HTTP settings:
`HTTP_HEADERS_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `RATE_LIMIT_PER_MINUTE` (off by default), `SHUTDOWN_DRAIN_MS` and
`SHUTDOWN_TIMEOUT_MS`; see "HTTP hardening" in `DEPLOYMENT.md`.
Emitted metrics: `increadible_uptime_seconds`, `increadible_tool_calls_total{tool}`,
`increadible_tool_errors_total{tool}`, `increadible_tool_call_duration_seconds{tool}` (histogram),
`increadible_rpc_errors_total`, `increadible_http_rejected_total{reason}`.

## Tools (13)

| Tool | Component | Purpose |
|------|-----------|---------|
| `apply_routing_rules` | #7 | Pick a provider for a request from YAML rules |
| `get_rule_stats` | #7 | Rule hit counts and provider breakdown |
| `update_rules` | #7 | Replace the rule set (validated, persisted to `RULES_FILE`) |
| `suggest_rules` | #7 | Suggestion based on observed provider share |
| `create_experiment` | #8 | Define a 2-variant experiment |
| `assign_variant` | #8 | Assign a variant (sticky per `user_id` if given) |
| `record_metric` | #8 | Record numeric metrics for a variant |
| `get_experiment_results` | #8 | Per-variant stats and significance test |
| `recommend_winner` | #8 | Winner only if statistically significant |
| `discover_apis` | #9 | Search the API registry |
| `call_api` | #9 | Call a registered API (cached 5 min) |
| `aggregate_apis` | #9 | Several calls in parallel |
| `get_api_stats` | #9 | Call counts and cache hit rate |

## Behavior reference

**Routing rules** (`RULES_FILE`, default `./rules.yaml`; built-in defaults if the file is missing or invalid):

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
- Exactly 2 variants; `traffic_split` is the share sent to the first variant (default 0.5).
- Results stay `incomplete` until there are >= 100 measurements and >= 30 per variant.
- Significance: Welch's t-test (normal approximation of t), two-sided, alpha = 0.05, on the
  **first** metric; higher mean is treated as better. `confidence = 1 - p`. A winner is named
  only if p < 0.05. Per-metric Cohen's d and a 95% CI of the mean are reported.
- **Persistence:** set `AB_DATA_FILE` to keep experiments and measurements across restarts. Every
  `create_experiment` and `record_metric` is appended to that JSONL file *before* it takes effect (if the write
  fails, the call returns an error and nothing is recorded), and the file is replayed on startup.
  Unset, data lives in memory only (the Docker image and `k8s/` manifests set it to `/data/ab-data.jsonl`).
  Details: the file is created `0600`; unreadable or torn lines are skipped with a note on stderr; creating an
  experiment with an existing id is rejected; definitions in `EXPERIMENTS_FILE` win over a logged experiment with the
  same id; the file grows by about 120 bytes per measurement (measured) and is never compacted. **Memory does not grow with it**: the module
  keeps only counts and a running mean and variance per variant and metric (the raw values stay in the file), so a results call takes the same time at any size, and
  startup replays the file in chunks (about 1.1 microseconds per measurement: 9 s for 8 million, measured). A warning is logged once the file passes
  `AB_DATA_WARN_BYTES` (default 100 MB, which the `k8s/` manifests also set: 10% of their 1Gi volume). Numbers and limits: [PERFORMANCE.md](PERFORMANCE.md).
  - **One writer:** a second process on the same file is refused at startup, naming the process that holds it
    (`<file>.lock`, refreshed every 3 s, removed on clean exit and on SIGTERM/SIGINT; the lock of a crashed process is
    taken over; every write re-checks it and fails if it was lost). Details and limits: `DEPLOYMENT.md`.
  - **Durability:** by default an append is handed to the OS, which survives a process crash but not an OS crash or power
    loss. Set `AB_FSYNC=1` to flush each append to disk first (slower: one flush per write, about 0.2 ms on a local disk; see [PERFORMANCE.md](PERFORMANCE.md)).

**API gateway:** the registry has 9 APIs (weather, finance, news, reference, sports). `call_api`
currently returns **generated mock data**; it makes no network calls. Results are cached for 5 minutes.

## Development

| Command | What it does |
|---------|--------------|
| `npm run type-check` | `tsc --noEmit` over our code and tests |
| `npm run lint` | ESLint over our code and tests |
| `npm test` | Jest (real-code tests for #7-#9 and both transports) |
| `npm run build` | Compile to `dist/` (tests excluded) |
| `npm run verify` | Type-check, lint, tests, build, and a stdio smoke test |

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
- `call_api` is mock-only. A/B persistence needs `AB_DATA_FILE`, is single-writer (enforced with a lock file), flushes to disk only with `AB_FSYNC=1`, and is never compacted (memory and query time do not grow with the data: it keeps running aggregates; see [PERFORMANCE.md](PERFORMANCE.md)).
