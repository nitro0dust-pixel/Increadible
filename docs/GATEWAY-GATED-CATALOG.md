# API gateway: gated catalog architecture (proposal, option A)

**Status: APPROVED by the owner on 2026-10-10 (option A). Not built yet; step 1 is next.**

This expands recommendation "A, with a gated catalog" in [`GATEWAY.md`](../GATEWAY.md) into components and an order of work.
It was drafted in a separate Claude session on 2026-10-10 from the owner's local copy, then checked line by line against
`main` at `64cdefb` (PR #38). Four statements of the draft were wrong and are corrected here (section 8). Nothing in this
document is built, installed or run.

## 1. Proven in the repository today

| Fact | Source |
|---|---|
| The gateway has four tools: `discover_apis`, `call_api`, `aggregate_apis`, `get_api_stats` | `features/09-api-gateway/src/mcp-server.ts`, `mcpb/manifest.json` |
| Nine registered APIs: openweathermap, weatherapi, coingecko, finnhub, newsapi, hackernews, wikipedia, wikidata, thesportsdb. `call_api` answers sample data unless an API is switched to live | `mcp-server.ts`, [`USING-THE-GATEWAY.md`](USING-THE-GATEWAY.md) |
| Live calls had never run against a real provider when this was written; on 2026-10-10 one call each to the four keyless APIs succeeded from Claude Desktop (the key-based APIs: never) | `GATEWAY.md` (requirement 2), `docs/INSTALL-CLAUDE-DESKTOP.md` section 5.4 |
| The live layer refuses other hosts and paths, `..` and encoded dots or slashes, full URLs, redirects, non-JSON, oversize and slow responses; GET only; the gateway adds the credential from an environment variable and redacts it from errors and logs | `features/09-api-gateway/src/live.ts` |
| **The registry is data** (since step 1a, below): `features/09-api-gateway/src/catalog.ts` holds the nine APIs, each with its `APIDefinition` (`id`, `name`, `category`, `endpoint`, `methods`, `auth`, `free`, `description`, `docs_url`), its credential source if it takes a key, and a gate record; the gateway reads it at start-up, and the `apis` option replaces it only in tests. Before step 1a it was hard-coded in `initializeAPIRegistry()` and `DEFAULT_CREDENTIALS` | `catalog.ts`, `mcp-server.ts` |
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
6. **Evidence record.** Per API: gate status, auth class, terms, probe history (latency, error rate), date of last change. Read-only, through `get_api_stats` (owner decision, 2026-10-10; the `gates` field, without probe history until a scheduled probe exists).
7. **Retirement.** A probe that keeps failing moves the API to `degraded`: hidden from `discover_apis`, kept in the store. The number of failures is a design choice, not a measured value.

## 4. Order of work

1. **Gate the nine APIs already registered**, proving the pipeline without a new external source. In two parts:
   - **1a, done (2026-10-10):** the built-in registry became data, `features/09-api-gateway/src/catalog.ts`. Each API carries a gate
     record: a status (`candidate`, `gated`, `degraded`) and one field per gate (pinned base URL, auth class, terms, health probe,
     contract test, each with who signed it off and when), plus the live calls seen to work. **All nine are `candidate`**, because no
     gate has a person's sign-off yet; the four keyless APIs carry their live calls of 2026-10-10 as evidence. What the gateway
     answers did not change: `tests/gateway-catalog.test.ts` holds it to a golden file recorded from the hard-coded registry
     (`tests/fixtures/gateway-registry-golden.json`), and refuses a `gated` or `degraded` API with any gate left empty.
   - **1a merged** as PR #50 (2026-10-10).
   - **1b, in progress:** for each API, the owner signs off its pinned URL and auth class, its terms are read and recorded (URL, summary,
     date), a health probe with success criteria and a recorded-response contract test are written; the four keyless APIs first.
     Only then does an API become `gated`, and only after that does `discover_apis` list gated APIs only (a behaviour change, in its
     own pull request).
     - **Done (no sign-off needed):** a probe for each keyless API in its gate record (one fixed request, success criteria in words);
       the same criteria as code in `features/09-api-gateway/src/probes.ts`; `scripts/record-contracts.js`, which sends each probe
       through the gateway's own live path and writes the provider's answer to `tests/fixtures/contracts/<api>.json` only when it
       passes (keyless APIs only, so no credential can reach a file; the User-Agent is not written); and
       `tests/gateway-contracts.test.ts`, which checks every recording against the catalog's current probe and URL and replays it
       through the gateway in CI. A `gated` or `degraded` API now also needs its recording.
     - **Not done: no recording exists.** The authoring sandbox cannot reach the four providers (`network error (ENOTFOUND)`) or read
       their terms pages, so the recorder runs on the owner's PC:
       `npm ci && npm run build`, then `GATEWAY_USER_AGENT="increadible (<contact>)" node scripts/record-contracts.js --where "<machine>"`
       (PowerShell: set `$env:GATEWAY_USER_AGENT` first), and the four files under `tests/fixtures/contracts/` go into a pull request.
       The chain (record, then replay) was run once here with a stubbed `fetch`: four files written, four replays passed; those files were
       synthetic and deleted.
     - **Waiting on the owner:** the sign-offs on each pinned URL and auth class, and the terms (read on a machine that reaches the
       providers, summarised, signed off).
   Output of step 1: nine gated records, each with a pinned URL, an auth class, terms and a probe history.
2. **Per-API rate limit and a retry policy** (both open in `ROADMAP.md`), before more APIs are switched to live.
   - **Rate limit: the mechanism is built** (`GATEWAY_RATE_LIMITS`, e.g. `coingecko=30`: live calls per API in any rolling minute;
     a call over it is refused before it reaches the provider and counted as `rate_limited` in `get_api_stats`). **No limit is
     set**: the values depend on each provider's terms, which are not read yet (step 1b), so they are the owner's decision.
   - **Retry policy: no retries for now (owner decision, 2026-10-10).** A live call that fails is reported, not repeated; to be
     revisited when real traffic exists. It was the owner's call because a retry sends another request to a provider on the
     operator's behalf.
3. **Egress allowlist at deploy time**: a NetworkPolicy limited to the pinned hosts; a prerequisite for live mode in a cluster.
   - **Written, NOT VERIFIED on a cluster** (`DEPLOYMENT.md`, "Egress"): the deployment manifests allow DNS only; `k8s/egress-live-cilium.yaml`
     allows HTTPS to the four keyless providers by host name, on Cilium only, because standard NetworkPolicy cannot name hosts.
     A test holds the host list to the catalog's keyless APIs. Other network plugins need an egress proxy: not built.
4. **Seed import** from the catalogues, as candidates only.
   - **Done for public-apis (2026-10-10)**: `scripts/seed-candidates.js` turned the list's README (fetched from
     `raw.githubusercontent.com`, SHA-256 `cf00cccb...`, MIT licence, its notice kept in the file) into
     `features/09-api-gateway/data/candidates-public-apis.json`: 2,032 candidates in 51 categories, each with the listed auth
     *as listed* (classifying it is gate 2), HTTPS and CORS flags and the documentation link; 5 malformed source rows are listed
     with their line, not guessed at. The file is read by no server code, compiled into nothing and shipped in neither the image nor
     the Claude Desktop package; `discover_apis` still lists the nine catalog APIs only (`tests/gateway-candidates.test.ts`).
   - **APIs.guru: not imported.** Its API (`api.apis.guru`) is not reachable from the authoring sandbox, and its data last changed
     on 2024-03-01 (section 2).
   - The commit of the list is not recorded: the GitHub API refused the lookup from the sandbox, so the snapshot is identified by
     its SHA-256 and the date fetched. A re-import is `node scripts/seed-candidates.js README.md LICENSE --fetched-on <date>
     --source-url <url>`; one candidate per line keeps the diff readable.
   - Which candidates to gate next is the owner's choice; a candidate reaches `catalog.ts` only by a person, through every gate.
     [`GATEWAY-CANDIDATES.md`](GATEWAY-CANDIDATES.md) (generated) gives the material: candidates per category and listed auth
     (909 keyless with HTTPS), and the nine catalog APIs as the list shows them; the list calls wikidata `OAuth`, which its read API
     is not (it answered without a key on 2026-10-10), an example of why gate 2 is a person's check.
5. **Promote keyless APIs first** (coingecko, hackernews, wikipedia, wikidata), probed from a machine that can reach the providers, before any cluster.
6. **A/B measurement** of cost (primary) and quality (guardrail) on a real workload. Blocked until a real workload exists.

## 5. Out of scope

- An open-source gateway as the call path (section 2).
- A hosted integration platform (option D): the owner's decision, not part of this design.
- Advertising "1000+ APIs" before the gated count reaches that number.

## 6. Decisions needed from the owner

- [x] Approve option A (`GATEWAY.md`, first box): **approved 2026-10-10**.
- [x] Approve starting step 1 above (`GATEWAY.md`, second box): **approved 2026-10-10**.
- [ ] Option D: wanted or not (`GATEWAY.md`, third box).
- [ ] Where API keys live once more than the keyless APIs are switched on (`GATEWAY.md`, fourth box).
- [ ] Probe retirement threshold: needs a proposal, then a decision.
- [x] Where gate status is shown (section 3, item 6): **read-only in `get_api_stats`, decided by the owner on 2026-10-10**; built as the
  `gates` field (status, auth class, sign-off dates, terms address, probe path, contract test, live evidence; no probe history yet).
- [x] Retries for live calls: **none for now, decided by the owner on 2026-10-10** (step 2).
- [x] The first new APIs to gate: **one category's keyless HTTPS candidates, decided by the owner on 2026-10-10**
  ([`GATEWAY-CANDIDATES.md`](GATEWAY-CANDIDATES.md), section 3). **Category: Cryptocurrency** (owner, 2026-10-10: the most keyless
  HTTPS candidates, 36, and CoinGecko already answered live); **first five: CoinCap, CoinPaprika, CoinLore, DefiLlama, Mempool**
  (proposed in the session, accepted by the owner the same day). Their gate proposals are in
  `features/09-api-gateway/data/gate-proposals.json` (section 9).

## 7. Not verified

- Catalogue sizes, the no-auth share, the broken-API estimate, and the ContextForge and Docker advisory details (`GATEWAY.md`, "Not verified").
- Probe success criteria and retirement thresholds: design choices, not measured. The four probes have never been sent to the real providers (only replayed against a stubbed `fetch`).
- The effort of step 1: not estimated.

## 8. Corrections to the first draft

| Draft said | Checked against `main` at `64cdefb` |
|---|---|
| `mcp-server.ts` has 668 lines, `live.ts` 100, of which the first 50 and 60 were read | 718 and 160 lines. The registry question the draft left open is answered in section 1 |
| The gaps are in a "Known limitations" section of `ROADMAP.md` | No such section; they are in `ROADMAP.md`, Backlog, "Gateway live mode", and in `DEPLOYMENT.md` |
| `DEPLOYMENT.md` assumes an egress allowlist | `DEPLOYMENT.md` says no NetworkPolicy exists, so a pod can reach any host: a gap, not an assumption |
| How the registry is loaded is unknown | It was hard-coded in `initializeAPIRegistry()`; step 1 therefore included a code change, not only new records (done in step 1a) |

## 9. The first batch: five gate proposals waiting for the owner

`features/09-api-gateway/data/gate-proposals.json` holds a proposed base URL, auth class, documentation link and health probe for
CoinCap, CoinPaprika, CoinLore, DefiLlama and Mempool, and one thing to check first for each. **Every value was written from memory**:
the sandbox cannot reach the providers or their documentation. They are proposals: read by no server code, not in `catalog.ts`, not
listed or callable (`tests/gateway-candidates.test.ts`). An API moves into `catalog.ts` only after:

1. **Gates 1 and 2, the owner:** check the base URL and that no key is needed against the official documentation, then sign off
   (name and date). CoinCap first: its keyless v2 API may have been retired for a keyed v3, which would take it out of this batch.
2. **Gate 3, terms:** licence, attribution, commercial use and rate limit, with the page's URL and the date read, signed off.
   The owner's other assistant can fetch the pages; this session records what it is given.
3. **Gates 4 and 6, probe and contract:** the probe's check is added to `probes.ts` and `scripts/record-contracts.js` records one
   real answer on a machine that reaches the provider; the contract test replays it in CI.
4. **Rate limit:** a `GATEWAY_RATE_LIMITS` value from the terms, before the API is switched to live.

Only then is the entry added to `catalog.ts`, as `gated`. Until that change, nothing about these five is visible to a client.

