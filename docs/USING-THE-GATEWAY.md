# Using the Increadible API gateway from a Claude chat

## Read this first

1. The gateway knows **9 public APIs**. In the Claude Desktop extension **as shipped (with no `GATEWAY_*` setting in its environment)**, every `call_api` and `aggregate_apis` answer is **built-in sample ("mock") data**. Nothing is fetched from the internet. Prices, weather and headlines are placeholders, not real data. (`discover_apis` and `get_api_stats` answers are the list of known APIs and a usage count, not sample data.)
2. `call_api` answers, and each successful result inside an `aggregate_apis` answer, carry a field `source`: `mock` is sample data, `live` is a real call. As shipped you will only ever see `mock`. (`discover_apis` and `get_api_stats` answers have no `source` field.)
3. **How this was checked.** The mock-mode answers below come from running the server the way the extension starts it (the code of package 1.0.1, as tested at the time of writing). It was **NOT VERIFIED inside Claude Desktop itself** (`docs/INSTALL-CLAUDE-DESKTOP.md`, section 5.4). The live-mode statements were checked offline only: by reading the code, and by runs in which the network call was replaced by a stub (no outbound call was made). **Never against a real provider.** The config-file route (Path B) and the Windows environment variable were **not run**. Claude may phrase its own tool calls differently, so name the tool in your prompt as shown.
4. **Which version?** The prompts below are written for package 1.0.1, the version you are retesting. The sources of package 1.0.2 are in this repository, not yet installed or tested by you; they describe the item shapes in the tool list, so the hints in the prompts should become unnecessary. Keep the hints until 1.0.2 is installed and tested. That it removes the retries is **NOT VERIFIED**.

## Step 0: is the extension answering?

Open a new chat and type:

`Use the increadible tool get_api_stats.`

A fresh server answers JSON that starts `{"total_calls":0,` and ends `"live_apis":[]}`. If Claude says it has no such tool, see `docs/TROUBLESHOOTING.md`.

## Step 1: find the API id (tool `discover_apis`)

| You type | Tool and arguments | What comes back |
|---|---|---|
| `Use the increadible tool discover_apis with no query and list every API it knows.` | `discover_apis`, no arguments | 9 entries, each with `id`, `name`, `category`, `endpoint`, `methods`, `auth`, `free`, `description` and (for some) `docs_url` |
| `Use the increadible tool discover_apis with the query weather.` | `discover_apis` `{query: "weather"}` | 2 entries: `openweathermap`, `weatherapi` |

- The ids are: openweathermap, weatherapi, coingecko, finnhub, newsapi, hackernews, wikipedia, wikidata, thesportsdb. Case matters.
- You use the `id` in the next steps. The `endpoint` shown here is the provider's base URL, information only: never pass it on.
- The search is one contiguous piece of text, case-insensitive, matched against name, category and description (not the id). Category words work best: weather, finance, news, reference, sports. Names are single words, so `hackernews` and `coingecko` each find one API, while `hacker news` and `bitcoin` find none. No match gives `[]`, which is not an error.

## Step 2: call one API (tool `call_api`)

An answer has the shape `{"data": <the answer>, "source": "mock", "cached": false, "timestamp": "..."}`. The rows below show the `data` part.

| You type | Tool and arguments | `data` | What it really is |
|---|---|---|---|
| `Use the increadible tool call_api with api_id coingecko, endpoint /simple/price and params ids=bitcoin and vs_currencies=usd. Show me the raw result.` | `call_api` `{api_id:"coingecko", endpoint:"/simple/price", params:{ids:"bitcoin", vs_currencies:"usd"}}` | `{"bitcoin":{"usd":43250.5,"usd_market_cap":850000000000,"usd_24h_vol":25000000000}}` | A fixed placeholder. A request for ethereum gave the same bitcoin answer. Not a market price |
| `Use call_api with api_id openweathermap, endpoint /weather and params q=London and units=metric. Show me the raw result.` | `call_api` on `openweathermap` | `{"main":{"temp":72.5,"humidity":65,"pressure":1013},"weather":[{"main":"Partly Cloudy"}]}` | Always the same, whatever the city |
| `Use call_api with api_id newsapi, endpoint /top-headlines and params country=us. Show me the raw result.` | `call_api` on `newsapi` | one article, "AI Advances Transform Technology", url example.com | Always the same single article |
| `Use call_api with api_id wikipedia, endpoint "" (an empty string) and params action=query, list=search, srsearch=Alan Turing, format=json. Show me the raw result.` | `call_api` on `wikipedia` with `endpoint:""` | `{"status":"success","data":{<your own params>},"timestamp":"..."}` | Your params echoed back. No article |

- The same "echo" answer comes from weatherapi, finnhub, hackernews, wikipedia, wikidata and thesportsdb: no stories, no quotes, no pages. Its `status: "success"` says nothing about whether the request would be valid for the real provider.
- Write the endpoint as an empty string (not "left out"): if Claude omits it you get the error `endpoint must be a string`. For wikipedia and wikidata use the empty endpoint (or `/`): their base URL already ends in `/w/api.php`.

## Step 3: several calls at once (tool `aggregate_apis`)

`Use the increadible tool aggregate_apis with two calls: first coingecko, endpoint /simple/price, params ids=bitcoin and vs_currencies=usd; second wikipedia, endpoint "" (an empty string), params action=query, list=search, srsearch=MCP, format=json. In aggregate_apis each call names the API with the key id, not api_id. Show me the raw result.`

- The last sentence is needed with package 1.0.1 and earlier: the tool's schema does not describe the items, and a model that guesses `api_id` is refused (`apis[0].id must be a string`). Package 1.0.2 (in this repository, not yet installed or tested by you) describes them. That this removes the retry is **NOT VERIFIED**.
- Reply: `{"data":[ {...}, {...} ],"count":2}`. Each item is a `call_api` answer with its own `source`. Results come back in the order asked and do not name their API: match them by position.
- One call fails (for example an unknown id): that slot holds `{"error":"API not found: x"}` and the reply adds `"failed":1`. This is **not** flagged as an error. All calls fail: the whole reply is an error. One badly formed item: the whole request is refused and nothing runs.

## Step 4: see the statistics (tool `get_api_stats`)

`Use the increadible tool get_api_stats and explain each number.`

Real example after two identical Bitcoin calls in a fresh server: `{"total_calls":2,"successful":1,"failed":0,"cache_hit_rate":"0.50","api_distribution":{"coingecko":1},"cached_items":1,"cache_evictions":0,"live_calls":0,"live_apis":[]}`

| Field | Meaning |
|---|---|
| `total_calls` | Every call that reached the gateway, including cache hits and unknown ids: total = successful + failed + cache hits. Calls refused for wrong argument types are not counted |
| `successful` | Calls answered fresh (not from the cache) |
| `failed` | Calls that returned an error, for example an unknown id |
| `cache_hit_rate` | Text such as `"0.50"`: cache hits divided by `total_calls` |
| `api_distribution` | Fresh successes per API |
| `cached_items`, `cache_evictions` | Entries held now (may include expired ones), and entries pushed out because the cache was full |
| `live_calls`, `live_apis` | Real network calls made, and the APIs switched to live: `[]` in the extension as shipped; with live calls on, the ids, or the single value `"*"` when everything is live |

The counters live in the memory of one server process and start at 0 after every restart. Claude Desktop starts several copies and stops them at will (`docs/INSTALL-CLAUDE-DESKTOP.md`, section 5.3), so ask for the statistics in the same chat, soon after your calls. A zero after calls means the server process was restarted, or you are talking to another copy. That a chat's calls and its statistics can reach different copies was **not observed in Claude Desktop (NOT VERIFIED)**; it is an inference.

Repeating exactly the same call within 5 minutes returns `"cached":true`. Another key order in the params, or `x` instead of `/x`, counts as a different call.

## Errors you may see

| Message | Cause |
|---|---|
| `API not found: X` | Wrong id (case matters), or you passed the base URL |
| `api_id must be a string` | `call_api` was given `id` instead of `api_id` |
| `apis[0].id must be a string` | An `aggregate_apis` item used `api_id` instead of `id` |
| `endpoint must be a string` / `params must be an object` | Endpoint left out (an empty string is fine), or params not an object |
| `all N calls failed` | Every call of an `aggregate_apis` batch failed |

## Mock versus real

| | Extension as shipped (mock) | With live switched on |
|---|---|---|
| `source` | `mock` | `live` for the APIs you named, `mock` for the rest |
| Answer | Fixed or echoed | The provider's own JSON. **NOT VERIFIED**: live mode has never run against a real provider |
| `endpoint` | Any text, ignored | A plain path of that provider; the repository has no list of valid paths, take them from the provider's documentation |
| `params` | Anything | Flat values only (text, number, true/false), at most 30 entries (read from the code and checked offline) |

A call that works in mock mode can therefore be refused, or fail, in live mode.

## Can live calls be switched on?

- **From a chat: no.** It is an environment setting read once when the server starts.
- **Claude Desktop extension (.mcpb): not with anything it offers.** Its only settings are the data folder and durable writes (`mcpb/manifest.json`); no `GATEWAY_*` variable is passed. A Windows environment variable set before Claude Desktop starts might reach it, but nothing in the repository shows that it does (**NOT VERIFIED**; do not rely on it, and if one did reach it, the "mock only" statements above would no longer hold: check `source`). Offering live mode in the package is a code and test change that has not been done and needs your decision (`GATEWAY.md`, `ROADMAP.md`).
- **Config-file route (Path B in `docs/INSTALL-CLAUDE-DESKTOP.md`): possible, for an expert.** You need Node.js 22 or newer, a copy of the code built with `npm ci` and `npm run build` (section 2 of that guide), its own data folder (two copies must not share the A/B data file), and the extension switched off while you try it (how Claude Desktop treats two servers of one name is **NOT VERIFIED**). In the server's `env` block of `claude_desktop_config.json` set `GATEWAY_LIVE_APIS` to comma-separated ids (for example `coingecko,wikipedia`) or to `*`, then quit Claude Desktop completely and start it again. For openweathermap, weatherapi, finnhub and newsapi also set `GATEWAY_KEY_OPENWEATHERMAP`, `GATEWAY_KEY_WEATHERAPI`, `GATEWAY_KEY_FINNHUB`, `GATEWAY_KEY_NEWSAPI`; they sit in that file in plain text, and a key must never be pasted into a chat. Wikipedia and Wikidata want `GATEWAY_USER_AGENT` with contact details (`DEPLOYMENT.md`).
- **Status of that route:** Path B is verified only up to the handshake, not inside Claude Desktop. Live mode was checked offline (URL building, validation, error handling with the network stubbed), never against a real provider; provider terms, rate limits and an outbound-network restriction have not been reviewed. Recommendation: leave it off until you decide.
- **How to confirm live mode after a restart:** results say `"source":"live"`, and `get_api_stats` shows the ids in `live_apis` (or `"*"` when everything is live). A misspelt id (capitals, `all`) is ignored: it is simply missing from `live_apis` (the list is `[]` only if every id in it is misspelt), so always check `source`. (Checked with `get_api_stats` only, no `call_api`: `CoinGecko,wikipedia` gave `["wikipedia"]`; `CoinGecko` alone and `all` alone gave `[]`; `*` gave the text `"*"`; `coingecko,wikipedia` gave both ids.)

## Why Claude sometimes retries

In a test with a client that saw only the tool list of package 1.0.1, 3 of 10 first attempts were refused: `aggregate_apis` (item key `id`), `create_experiment` (metric `id`) and `update_rules` (rule shape). Each worked after one retry because the error names the required keys. Package 1.0.2 (in this repository, not yet installed or tested by you) puts these item shapes into the tool list; that it removes the retries is **NOT VERIFIED** until re-tested.

## If something is wrong after you install 1.0.2

This section is time-bound: delete it, and the version hints above, once 1.0.2 has been tested in Claude Desktop.

Package 1.0.2 adds item schemas, bounds, worked examples and one default value to the tool list. It also contains the start-up fix of 1.0.1, which the app has not yet answered either. If, after installing 1.0.2, Increadible shows an error, the tools are missing, or the app says it did not respond:

1. Remove the extension, then install the **1.0.1** file again (the one you already have). Whether the app replaces an installed extension in place is **NOT VERIFIED**, so remove the old one first.
2. Open Settings, Developer, choose Increadible, **View logs**, and send the lines around `increadible <version>: ready on stdio`, where `<version>` is the version you installed (1.0.1 or 1.0.2). See `docs/INSTALL-CLAUDE-DESKTOP.md`, section 5.5.
3. How to read the result: if 1.0.1 works and 1.0.2 does not, the cause is what 1.0.2 added to the tool list; if neither works, the cause is the start-up problem 1.0.1 was meant to fix. Both readings are **NOT VERIFIED** until you try.

Best order: retest 1.0.1 first (it is your pending retest), then 1.0.2.
