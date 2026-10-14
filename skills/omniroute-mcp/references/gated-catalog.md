<!-- Copy of docs/GATEWAY-GATED-CATALOG.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# API gateway: gated catalog architecture (proposal, option A)

**Status: APPROVED by the owner on 2026-10-10 (option A). Being built: steps 1a, 2, 3 and 4 done; step 1b in progress (probes, recordings, contract tests and a probe runner with a probe history done for the keyless four; sign-offs, terms and the retirement threshold wait on the owner). Section 4 has the detail.**

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
6. **Evidence record.** Per API: gate status, auth class, terms, probe history (latency, error rate), date of last change. Read-only, through `get_api_stats` (owner decision, 2026-10-10; the `gates` field). Probe history: `scripts/run-probes.js` writes one, on the machine that runs it; the server does not read it, so `get_api_stats` shows none yet.
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
     - **Done: the four recordings exist (2026-10-10).** The authoring sandbox cannot reach the providers (`network error (ENOTFOUND)`),
       so the owner ran the recorder on their Windows PC at `main` = `bed1008` (`npm ci && npm run build`, then
       `GATEWAY_USER_AGENT="increadible (<contact>)" node scripts/record-contracts.js --where "owner's Windows PC"`): "4 of 4 recorded".
       The files came in on the owner's branch `contracts-2026-10-10` (commit `02f16ac`) and were taken into the pull request byte for
       byte; their SHA-256 values match the recorder's output (coingecko `5332cc63...`, hackernews `0a0458c3...`, wikipedia
       `670a9195...`, wikidata `cf5df2f5...`); no User-Agent or contact is in them. All four replay through the gateway in CI. Each
       was broken on purpose and the replay failed: wikidata's label `Earth` changed, coingecko's URL changed, hackernews' status 500,
       hackernews' body a string, wikipedia's `sitename` changed; an extra recording for an unknown API also failed. A recording proves
       one answer on one day, nothing about uptime; re-record when a probe changes (the test refuses a recording made for another probe).
     - **Done: gate 6 recorded in `catalog.ts`.** The four gate records name `tests/gateway-contracts.test.ts` as their contract
       test, and `get_api_stats` shows it; a test holds the catalog and the recordings to each other both ways (a contract test
       named without a recording fails, and so does a recording whose API names none). This is evidence, not a sign-off: the four
       stay `candidate`.
     - **Done: a probe runner and a probe history (2026-10-14).** `scripts/run-probes.js` sends each keyless API's probe once
       through the gateway's live path (no retry, which would hide the failure; the User-Agent with `GATEWAY_CONTACT`, refused
       without one) and appends one JSON line per probe to a history file (default `probe-history.jsonl`, ignored by git): when,
       where, the API, passed or not, the latency, the HTTP status and the problems found; never the body, the User-Agent or a
       credential. `run-probes.js report` prints, per API, the runs, the failures, the failures in a row at the end and the median
       latency of the passed probes. Scheduling it (cron, Task Scheduler) is the operator's: nothing in the server runs or reads it.
       `tests/run-probes.test.ts` runs it against the recorded answers in place of the network. **Never run against the real
       providers from here** (the sandbox cannot reach them); its first real history comes from the owner's machine.
     - **Waiting on the owner:** the sign-offs on each pinned URL and auth class, and the terms (read on a machine that reaches the
       providers, summarised, signed off). What was found so far, and what each page still has to confirm, is in section 10.
   Output of step 1: nine gated records, each with a pinned URL, an auth class, terms and a probe history.
2. **Per-API rate limit and a retry policy**, before more APIs are switched to live.
   - **Rate limit: built** (`GATEWAY_RATE_LIMITS`, e.g. `coingecko=30`: live calls per API in any rolling minute; a call over it is
     refused before it reaches the provider and counted as `rate_limited` in `get_api_stats`). **No per-API value is set**: only
     HN's limit was read on its own page (section 11). **A default of 5 calls a minute** for every API without its own entry
     (`GATEWAY_DEFAULT_RATE_LIMIT`; owner's instruction of 2026-10-12 to set conservative configurable limits): the project's own
     choice, the lowest figure any source gave for any live API, not a provider's number.
   - **Retry policy: bounded retries (owner's instruction of 2026-10-12, which replaces "no retries for now" of 2026-10-10).** One
     retry by default (`GATEWAY_RETRIES`, 0 to 3), only after an HTTP 429, 502, 503 or 504 or a dropped connection, never after a
     timeout; the wait is the provider's `Retry-After` when given (seconds or a date), else 1 s doubling, and never longer than
     `GATEWAY_RETRY_MAX_WAIT_MS` (5 s). A 429 (or a 503 with `Retry-After`) starts a **cooldown**: no live call goes to that API
     until the `Retry-After` has passed, or for a minute without one. Each retry passes the rate limit like any call.
   - **User-Agent: built** (owner's instruction of 2026-10-12, section 10's finding). The gateway sends
     `increadible-gateway/<version>`, with ` (<contact>)` when `GATEWAY_CONTACT` holds an email address or URL; it never makes one
     up. Wikipedia and Wikidata without a contact: a warning at start-up in development, a refusal before sending in production
     (`NODE_ENV=production`, as the image sets).
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
- [ ] Probe retirement threshold. **Proposal (2026-10-14), not decided:** an API becomes `degraded` after **3 failed probes in a
  row**, the probes **at least 1 hour apart**, and goes back after **2 passed probes in a row**; one failure is never enough (a
  provider's bad minute), and a run of failures within the same hour counts once. The numbers are design choices, not measured
  values: no probe history exists yet to measure them against. `run-probes.js report` already prints the failures in a row; moving
  an API to `degraded` stays a person's change to `catalog.ts` until the owner decides whether it should be automatic.
- [x] Where gate status is shown (section 3, item 6): **read-only in `get_api_stats`, decided by the owner on 2026-10-10**; built as the
  `gates` field (status, auth class, sign-off dates, terms address, probe path, contract test, live evidence; no probe history yet).
- [x] Retries for live calls: **none for now, decided by the owner on 2026-10-10**; **replaced on 2026-10-12** by the owner's
  instruction: bounded, configurable retries with HTTP 429 and Retry-After handled (step 2).
- [x] The Wikimedia User-Agent: **decided by the owner on 2026-10-12**: an identifiable name and version, a contact URL or email
  that is never made up; a warning in development, a refusal in production while it is missing (step 2).
- [x] CoinCap: **deferred for this release, owner, 2026-10-12** (section 9).
- [ ] Sign-offs: each API's pinned URL, auth class and terms (gates 1 to 3). The terms review of section 11 approves nothing.
- [ ] Per-API rate limits from the official documentation: only HN's was read on its page (none); the others need the owner's
  reading of the provider pages or an account tier to be chosen (section 11).
- [x] The first new APIs to gate: **one category's keyless HTTPS candidates, decided by the owner on 2026-10-10**
  ([`GATEWAY-CANDIDATES.md`](GATEWAY-CANDIDATES.md), section 3). **Category: Cryptocurrency** (owner, 2026-10-10: the most keyless
  HTTPS candidates, 36, and CoinGecko already answered live); **first five: CoinCap, CoinPaprika, CoinLore, DefiLlama, Mempool**
  (proposed in the session, accepted by the owner the same day). Their gate proposals are in
  `features/09-api-gateway/data/gate-proposals.json` (section 9).

## 7. Not verified

- Catalogue sizes, the no-auth share, the broken-API estimate, and the ContextForge and Docker advisory details (`GATEWAY.md`, "Not verified").
- Probe success criteria and retirement thresholds: design choices, not measured. The four probes were sent to the real providers once, by the recorder on the owner's PC on 2026-10-10 (each passed); everything since is a replay of those answers. `scripts/run-probes.js` has never run against the real providers.
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

**What a search found on 2026-10-10** (each proposal's `found_2026_10_10` in the file holds the summary, sources and how reliable
they are; the providers' sites do not resolve from the sandbox, so none of it was read on the provider's own page):

| API | Finding | Consequence |
|---|---|---|
| CoinCap | `api.coincap.io` reportedly no longer resolves; v3 (`rest.coincap.io/v3`) answers 401 without a key | **Deferred for this release (owner, 2026-10-12)**; its proposal is kept with status `deferred` |
| CoinPaprika | Keyless free tier; its own docs state the limit two ways (20,000 a month; 1,000 a day without a key); a third party says a public or commercial instance needs an enterprise agreement | Commercial use is the clause to read |
| CoinLore | Keyless; no official terms or limit found (third parties: about one request a second); endpoint paths differ between sources | The probe path `/global/` must be checked live |
| DefiLlama | Keyless; its own Pro page gives the open tier 10 to 200 requests a minute | `/v2/chains` was not confirmed by any result |
| Mempool | Keyless; rate limited (one third party: about 10 a second); no terms of service found | The limit and terms are on mempool.space's docs |


## 10. Terms of the keyless four: what was found, and what the owner confirms (gate 3)

Looked up on 2026-10-10 by the authoring session. **Nothing here is a sign-off, and only one line was read on the provider's own
page.** The session's fetcher reached `github.com` but not `coingecko.com`, `docs.coingecko.com`, `foundation.wikimedia.org`,
`www.mediawiki.org` or `meta.wikimedia.org` (`ENOTFOUND`); for those, the lines below come from a web search's summaries of the
pages, some of them second-hand, and say so. Gate 3 needs a person to read each page, confirm or correct the line, and sign it off
with the date; only then is `gate.terms` filled in `catalog.ts`.

| API | Page to read | What was found | How reliable | Still unknown |
|---|---|---|---|---|
| hackernews | <https://github.com/HackerNews/API> (README) | "There is currently no rate limit." No terms of use, licence for the data or attribution are stated; the repository's MIT licence covers the repository, not the data. Bugs go to `api@ycombinator.com` | **Read on the page** by this session | Whether Y Combinator has terms elsewhere that cover the API; ask or accept the README as the terms |
| coingecko | <https://www.coingecko.com/en/api_terms>, <https://docs.coingecko.com/docs/keyless-public-api>, <https://docs.coingecko.com/docs/errors-and-rate-limits> | CoinGecko's docs (search summary) say the keyless API is rate-limited per IP, shared with everyone on that IP, and **not meant for production, scheduled polling or high-frequency use**; no fixed keyless limit is published (the Demo plan, with a key, is 100 calls per minute). Attribution ("Data provided by CoinGecko" with a link) and **non-commercial use only** for the keyless and Demo tiers are claimed by third parties only | Search summary; attribution and commercial use **second-hand** | The attribution clause and the commercial-use clause in the terms themselves; whether the gateway's use counts as "production" |
| wikipedia, wikidata | <https://foundation.wikimedia.org/wiki/Policy:API_usage_guidelines>, <https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy>, <https://meta.wikimedia.org/wiki/API_Policy_Update_2024> | Every request needs a **User-Agent with contact information**; clients without one may be blocked without notice. Operators must obey instructions in a response to slow down or delay. Numerical limits may change; an older page (2019) gives 200 requests per second as a ceiling | Search summary of Wikimedia's own pages | The current numerical limits; whether the 2024 policy adds anything for keyless clients |
| wikipedia (content) | <https://www.wikidata.org/wiki/Wikidata:Licensing>, Wikimedia Terms of Use | Text is CC BY-SA 4.0, so text passed on to users needs attribution and share-alike | Search summary of Wikidata's licensing page | How attribution should be shown when the gateway returns article text |
| wikidata (content) | <https://www.wikidata.org/wiki/Wikidata:Licensing> | Structured data in the main, property and lexeme namespaces is CC0 (no attribution required) | Search summary of Wikidata's own page | Nothing for the probe's use (labels are main-namespace data) |

**One finding for the code, not a terms question** (resolved on 2026-10-12, step 2: `GATEWAY_CONTACT`, a warning in development, a
refusal in production; the paragraph below is kept as found). When `GATEWAY_USER_AGENT` is not set, the gateway sends the User-Agent
`increadible-gateway` (`features/09-api-gateway/src/mcp-server.ts`), which carries no contact. That is against Wikimedia's policy
above, so live calls to wikipedia or wikidata need `GATEWAY_USER_AGENT` set with a contact (Railway and the owner's Claude Desktop
set it). Whether the gateway should refuse or warn about live Wikimedia calls without a contact is an owner decision (a behaviour
change); nothing is changed here.

**What the owner confirms, per API:** the page's URL and the date read; licence; attribution (wording, and whether the gateway must
pass it on to its users); commercial use; the rate limit (which becomes the `GATEWAY_RATE_LIMITS` value); then a sign-off with name and
date. For coingecko, also whether keyless use fits the gateway at all, given "not for production".

## 11. Terms review of the catalog's nine APIs (2026-10-12): found, not approved

`features/09-api-gateway/data/terms-review.json` records, per API, the official pages to read, each finding with its source and
how it was read (**read on the page**, **search summary of the official page**, or **third party**), the rate limit seen and
whether it is verified, the restrictions, the open questions, and the account tier actually configured. `owner_signoff` is
`null` everywhere, and `tests/gateway-terms.test.ts` refuses anything else; `gate.terms` stays empty in `catalog.ts`. The sandbox
could fetch `github.com` but not CoinGecko's or Wikimedia's sites (`ENOTFOUND`, again on 2026-10-12).

| API | Account tier configured | Rate limit | How sure | Restriction found |
|---|---|---|---|---|
| hackernews | none (anonymous) | none ("There is currently no rate limit.") | **read on the page** | none stated |
| coingecko | none (anonymous, keyless) | not published for keyless; 5 to 15 a minute | third party | not for production; attribution "Data provided by CoinGecko"; no redistribution (search summaries) |
| wikipedia | none (anonymous) | not fixed; 200 a second on a 2019 page | search summary | User-Agent with contact required; obey slow-down answers; text CC BY-SA 4.0 |
| wikidata | none (anonymous) | not found | search summary | User-Agent with contact required; data CC0 |
| newsapi | none (no key set) | 100 a day (Developer plan) | search summary | **Developer plan: no staging or production use** |
| openweathermap | none (no key set) | 60 a minute, 1,000,000 a month (free) | search summary | not found; the catalog's `/data/2.5` may be outdated |
| weatherapi | none (no key set) | 1,000,000 a month or 1,000 a day | third party | not found |
| finnhub | none (no key set) | 60 a minute | third party | personal, non-commercial (third party) |
| thesportsdb | none (test key in the URL) | about 30 a minute | third party | personal, non-commercial on the free key (third party) |

What the gateway does with this, without approval: the **default limit of 5 calls a minute per API** stays under every figure
above; **no per-API value is set**, because none but HN's is verified; the key-based five have never run live and no account tier
is configured for them. **For the owner:** read each page, confirm or correct the line, decide NewsAPI's place (its free plan
forbids production use) and whether keyless CoinGecko fits "not for production", then sign off (name and date).
