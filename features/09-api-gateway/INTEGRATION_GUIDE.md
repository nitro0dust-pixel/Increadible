# Feature #9: API Gateway

A small registry of public APIs with response caching. Implemented in `src/mcp-server.ts`
(class `UniversalAPIGateway`), served by the root MCP server.

> **Current limitation:** by default `call_api` returns generated **mock data** and makes no HTTP requests. Real calls are
> **opt-in per API** (see "Live mode") and have been tested against a local server only, **not against the real providers**.
> The registry holds **9 APIs**, not thousands.

## Registry

openweathermap, weatherapi (weather); coingecko, finnhub (finance); newsapi, hackernews (news);
wikipedia, wikidata (reference); thesportsdb (sports). Add more at runtime from code with
`addCustomAPI()`; there is no tool for it.

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `discover_apis` | optional `query` (case-insensitive match on name, category or description) | array of API definitions |
| `call_api` | `api_id`, `endpoint` (a path under the API's registered URL, or empty), optional `params` | `{data, source: "mock" \| "live", cached, timestamp}`; `{error}` for an unknown API, a refused request or a failed call |
| `aggregate_apis` | `apis`: up to 100 of `[{id, endpoint, params?}]` | `{data: [...], count}`, order preserved, five calls at a time. A call that fails holds `{error}` in its place and the reply adds `failed: n`; only when every call failed is the reply an error (`error: "all n calls failed"`, with the `data` still attached). A wrong type or too many calls is a plain `{error}` |
| `get_api_stats` | none | `{total_calls, successful, failed, cache_hit_rate: "0.50", api_distribution, cached_items, cache_evictions, live_calls, live_apis}` |

Responses are cached for a fixed 300 seconds, keyed on `api_id + endpoint + params` (a failed call is never cached).
The cache and stats are in memory. The cache is bounded (a caller chooses the arguments of every call, and each distinct call used to add an entry for good): at most 500 entries and about 16 MiB of data, expired and then the oldest entries are dropped first (`cache_evictions` counts the latter), a result larger than 4 MiB is returned but not cached, and a long key is stored as its SHA-256. Live calls are limited to 10 at once across the gateway; 100 more may wait, and a call beyond that is refused with `the gateway is busy`.

## Live mode

Off by default. `GATEWAY_LIVE_APIS=coingecko,wikipedia` (or `*`) makes those APIs send a real GET; every other API keeps answering with mock data, and each result
says which (`source`). `endpoint` is appended to the API's registered URL (an empty endpoint or `/` is the registered URL itself, for APIs such as `/w/api.php`), `params` become the
query string. The four key-based APIs read their key from `GATEWAY_KEY_<API>` and add it themselves; a caller cannot set or override it. Redirects are not followed, only JSON is accepted,
and time and size are capped (`GATEWAY_TIMEOUT_MS`, `GATEWAY_MAX_RESPONSE_BYTES`). Variables, the credential table, the egress advice and what is not verified: `DEPLOYMENT.md`.
