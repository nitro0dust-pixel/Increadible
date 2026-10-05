# Feature #9: API Gateway

A small registry of public APIs with response caching. Implemented in `src/mcp-server.ts`
(class `UniversalAPIGateway`), served by the root MCP server.

> **Current limitation:** `call_api` returns generated **mock data**; it makes no HTTP requests,
> and the registry holds **9 APIs**, not thousands. Real HTTP calls are not implemented.

## Registry

openweathermap, weatherapi (weather); coingecko, finnhub (finance); newsapi, hackernews (news);
wikipedia, wikidata (reference); thesportsdb (sports). Add more at runtime from code with
`addCustomAPI()`; there is no tool for it.

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `discover_apis` | optional `query` (case-insensitive match on name, category or description) | array of API definitions |
| `call_api` | `api_id`, `endpoint`, optional `params` | `{data, cached, timestamp}`; `{error}` for an unknown API |
| `aggregate_apis` | `apis`: `[{id, endpoint, params?}]` | `{data: [...], count}` (calls run in parallel, order preserved) |
| `get_api_stats` | none | `{total_calls, successful, failed, cache_hit_rate: "0.50", api_distribution, cached_items}` |

Responses are cached for a fixed 300 seconds, keyed on `api_id + endpoint + params`.
The cache and stats are in memory.
