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
| `aggregate_apis` | `apis`: `[{id, endpoint, params?}]` | `{data: [...], count}` (calls run in parallel, order preserved) |
| `get_api_stats` | none | `{total_calls, successful, failed, cache_hit_rate: "0.50", api_distribution, cached_items, live_calls, live_apis}` |

Responses are cached for a fixed 300 seconds, keyed on `api_id + endpoint + params` (a failed call is never cached).
The cache and stats are in memory.

## Live mode

Off by default. `GATEWAY_LIVE_APIS=coingecko,wikipedia` (or `*`) makes those APIs send a real GET; every other API keeps answering with mock data, and each result
says which (`source`). `endpoint` is appended to the API's registered URL (an empty endpoint or `/` is the registered URL itself, for APIs such as `/w/api.php`), `params` become the
query string. The four key-based APIs read their key from `GATEWAY_KEY_<API>` and add it themselves; a caller cannot set or override it. Redirects are not followed, only JSON is accepted,
and time and size are capped (`GATEWAY_TIMEOUT_MS`, `GATEWAY_MAX_RESPONSE_BYTES`). Variables, the credential table, the egress advice and what is not verified: `DEPLOYMENT.md`.
