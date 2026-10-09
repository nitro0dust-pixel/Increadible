# API gateway: gated catalog architecture (proposal, option A)

**Status: PROPOSED. Not built. Needs the owner's approval** (`GATEWAY.md`, "Decisions requested from the owner").

This expands recommendation "A, with a gated catalog" in [`GATEWAY.md`](../GATEWAY.md) into components and an order of work.
It was drafted in a separate Claude session on 2026-10-10 from the owner's local copy, then checked line by line against
`main` at `64cdefb` (PR #38). Four statements of the draft were wrong and are corrected here (section 8). Nothing in this
document is built, installed or run.

## 1. Proven in the repository today

| Fact | Source |
|---|---|
| The gateway has four tools: `discover_apis`, `call_api`, `aggregate_apis`, `get_api_stats` | `features/09-api-gateway/src/mcp-server.ts`, `mcpb/manifest.json` |
| Nine registered APIs: openweathermap, weatherapi, coingecko, finnhub, newsapi, hackernews, wikipedia, wikidata, thesportsdb. `call_api` answers sample data unless an API is switched to live | `mcp-server.ts`, [`USING-THE-GATEWAY.md`](USING-THE-GATEWAY.md) |
| Live calls have never run against a real provider | `GATEWAY.md` (requirement 2), `mcpb/manifest.json` |
| The live layer refuses other hosts and paths, `..` and encoded dots or slashes, full URLs, redirects, non-JSON, oversize and slow responses; GET only; the gateway adds the credential from an environment variable and redacts it from errors and logs | `features/09-api-gateway/src/live.ts` |
| **The registry is hard-coded**: `initializeAPIRegistry()`, called from the constructor, builds the nine `APIDefinition` entries (`id`, `name`, `category`, `endpoint`, `methods`, `auth`, `free`, `description`, `docs_url`); the `apis` option replaces them only in tests. Credential sources are in `DEFAULT_CREDENTIALS` | `mcp-server.ts` |
| Bounds: cache 500 entries and 16 MiB, at most 100 calls per `aggregate_apis`, 10 live calls in flight, 100 waiting | `mcp-server.ts`, `MAX_CACHE_ENTRIES`, `MAX_CACHE_BYTES`, `MAX_AGGREGATE_CALLS`, `MAX_LIVE_IN_FLIGHT`, `MAX_LIVE_WAITING` |
| Known gaps: the rate limit is global and off by default; no per-API limiter; no retry or backoff; no egress policy (no NetworkPolicy exists, so a pod can reach any host) | `ROADMAP.md`, Backlog, "Gateway live mode"; `DEPLOYMENT.md`, live-mode section |

## 2. Verified by the research (`GATEWAY.md`)

- APIs.guru's data last changed on 2024-03-01: stale seed material only.
- agentgateway has two advisories on MCP-to-OpenAPI parameter sanitisation, so a converter is not used as the call path.
- Composio's May 2026 credential incident is reported by more than one source; the scale differs between them.

Every other figure in `GATEWAY.md` is marked NOT VERIFIED. This design depends on none of them.

## 3. Components

```
seed sources (offline) -> candidate store -> gate pipeline -> registry (gated only) -> call layer (existing)
                                                 ^                                      |
                                    health probe (scheduled)                  evidence record (read-only)
```

1. **Candidate store.** Records `{source, source_id, spec_url, status: candidate}`. Seed data is never trusted and nothing in it is callable.
2. **Gate pipeline.** Each step records who approved it and when; a failed step keeps the candidate out of the registry.
   1. *Pin the base URL* at registration, set by a person. A spec's `servers` field is ignored (`GATEWAY.md`, requirement 3).
   2. *Classify auth* as `none`, `api_key`, `oauth` or `basic` (the values `APIDefinition.auth` already allows), from the spec's security schemes, confirmed by a person. Keys come from environment variables or a cluster Secret, as the code does today.
   3. *Record terms*: licence and usage limits, with the source URL and the date read. A person signs off.
   4. *Health probe*: one fixed, keyless request to a documented endpoint, with written success criteria per API.
   5. *Description*: says what the API does and what its parameters are, checked by the existing schema tests.
   6. *Contract test*: at least one recorded-response test per API, run in CI.
   7. *Promotion* to `gated`. Only gated APIs are returned by `discover_apis`.
3. **Registry.** Gated APIs only. The advertised count is the number of gated APIs, never the number of candidates (`GATEWAY.md`, recommendation 3).
4. **Live switch.** Unchanged: `GATEWAY_LIVE_APIS` opts an API in; a gated API answers sample data until then.
5. **Call layer.** Unchanged. The host allowlist becomes each API's pinned base URL.
6. **Evidence record.** Per API: gate status, auth class, terms, probe history (latency, error rate), date of last change. Read-only, through `get_api_stats` or a new read-only tool (an owner decision).
7. **Retirement.** A probe that keeps failing moves the API to `degraded`: hidden from `discover_apis`, kept in the store. The number of failures is a design choice, not a measured value.

## 4. Order of work

1. **Gate the nine APIs already registered**, proving the pipeline without a new external source. Because the registry is code
   today (section 1), this step first turns the built-in list into data that carries a gate status, with tests that the nine
   answers do not change. Output: nine gated records, each with a pinned URL, an auth class, terms and a probe history.
2. **Per-API rate limit and a retry policy** (both open in `ROADMAP.md`), before more APIs are switched to live.
3. **Egress allowlist at deploy time**: a NetworkPolicy limited to the pinned hosts. None exists today (`DEPLOYMENT.md`); it is a prerequisite for live mode in a cluster.
4. **Seed import** from the catalogues, as candidates only.
5. **Promote keyless APIs first** (coingecko, hackernews, wikipedia, wikidata), probed from a machine that can reach the providers, before any cluster.
6. **A/B measurement** of cost (primary) and quality (guardrail) on a real workload. Blocked until a real workload exists.

## 5. Out of scope

- An open-source gateway as the call path (section 2).
- A hosted integration platform (option D): the owner's decision, not part of this design.
- Advertising "1000+ APIs" before the gated count reaches that number.

## 6. Decisions needed from the owner

- [ ] Approve option A (`GATEWAY.md`, first box).
- [ ] Approve starting step 1 above (`GATEWAY.md`, second box).
- [ ] Option D: wanted or not (`GATEWAY.md`, third box).
- [ ] Where API keys live once more than the keyless APIs are switched on (`GATEWAY.md`, fourth box).
- [ ] Probe retirement threshold: needs a proposal, then a decision.

## 7. Not verified

- Catalogue sizes, the no-auth share, the broken-API estimate, and the ContextForge and Docker advisory details (`GATEWAY.md`, "Not verified").
- Probe success criteria and retirement thresholds: design choices, not measured.
- The effort of step 1: not estimated.

## 8. Corrections to the first draft

| Draft said | Checked against `main` at `64cdefb` |
|---|---|
| `mcp-server.ts` has 668 lines, `live.ts` 100, of which the first 50 and 60 were read | 718 and 160 lines. The registry question the draft left open is answered in section 1 |
| The gaps are in a "Known limitations" section of `ROADMAP.md` | No such section; they are in `ROADMAP.md`, Backlog, "Gateway live mode", and in `DEPLOYMENT.md` |
| `DEPLOYMENT.md` assumes an egress allowlist | `DEPLOYMENT.md` says no NetworkPolicy exists, so a pod can reach any host: a gap, not an assumption |
| How the registry is loaded is unknown | It is hard-coded in `initializeAPIRegistry()`; step 1 therefore includes a code change, not only new records |
