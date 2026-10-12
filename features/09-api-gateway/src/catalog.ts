/**
 * The gateway's catalog: every registered API as data, each with its gate record (option A, `docs/GATEWAY-GATED-CATALOG.md`).
 *
 * Step 1a (this file) only moves the built-in registry out of the code and gives each API a gate record; what the gateway answers
 * is unchanged (`tests/gateway-catalog.test.ts` holds it to the answers of the earlier hard-coded registry). No API is `gated` yet:
 * an API is promoted only when every gate below holds evidence, and a test refuses a `gated` entry with a gate left empty.
 * Step 1b adds the health probes of the keyless APIs (their checks are in `probes.ts`); a probe written here is proposed, not signed
 * off, and its recorded answer (`scripts/record-contracts.js`) is what the contract test replays.
 */
import type { Credential } from "./live";

export interface APIDefinition {
  id: string;
  name: string;
  category: string;
  endpoint: string;
  methods: string[];
  auth: "none" | "api_key" | "oauth" | "basic";
  free: boolean;
  description: string;
  docs_url?: string;
}

/**
 * `candidate`: registered, gates not all passed (it answers as before; nothing is hidden in step 1a).
 * `gated`: every gate passed, with its evidence recorded. `degraded`: was gated, its health probe keeps failing.
 */
export type GateStatus = "candidate" | "gated" | "degraded";

/** Who confirmed a gate, and when (YYYY-MM-DD). */
export interface SignOff {
  by: string;
  on: string;
}

export interface GateRecord {
  status: GateStatus;
  /** Gate 1: the base URL (`endpoint`) was pinned by a person at registration, never taken from a spec's `servers`. */
  base_url_pinned: SignOff | null;
  /** Gate 2: the auth class (`auth`) was confirmed by a person from the provider's documentation. */
  auth_confirmed: SignOff | null;
  /** Gate 3: the provider's terms (licence, usage limits), where they were read, and a person's sign-off. */
  terms: (SignOff & { url: string; summary: string }) | null;
  /** Gate 4: one fixed, keyless health request and what counts as success. */
  probe: { endpoint: string; params: Record<string, string>; success: string } | null;
  /** Gate 6: the test file with this API's recorded-response contract test, run in CI; the recording is tests/fixtures/contracts/<id>.json. */
  contract_test: string | null;
  /** Real calls that were seen to work. Evidence for the gates above; not a gate by itself. */
  live_evidence: Array<{ on: string; where: string; endpoint: string; result: string }>;
}

export interface CatalogEntry {
  definition: APIDefinition;
  /** Where a key-based API takes its credential; read from the environment at call time, never logged or returned. */
  credential?: Credential;
  gate: GateRecord;
}

/** Gate 6 for the keyless four: their recorded answers (tests/fixtures/contracts/, recorded 2026-10-10) are replayed by this test. */
const CONTRACTS = "tests/gateway-contracts.test.ts";

/** No gate passed: the state of every API registered before the gated catalog. */
const NO_GATES = { status: "candidate", base_url_pinned: null, auth_confirmed: null, terms: null, probe: null, contract_test: null } as const;

/** The Railway probe printed only `source` and `error` (`DEPLOYMENT.md`), so that is all it records. */
const LIVE_OK = "source live, no error";

/** One call each on 2026-10-10, from the owner's Claude Desktop (package 1.0.3) and from the Railway rehearsal (`DEPLOYMENT.md`). */
const seen = (endpoint: string, desktop: string, railway: string): GateRecord["live_evidence"] => [
  { on: "2026-10-10", where: "Claude Desktop, the owner's Windows PC", endpoint, result: desktop },
  { on: "2026-10-10", where: "Railway rehearsal (sfo)", endpoint, result: railway },
];

export const CATALOG: CatalogEntry[] = [
  // Weather
  {
    definition: {
      id: "openweathermap",
      name: "OpenWeatherMap",
      category: "weather",
      endpoint: "https://api.openweathermap.org/data/2.5",
      methods: ["GET"],
      auth: "api_key",
      free: true,
      description: "Real-time weather data worldwide",
      docs_url: "https://openweathermap.org/api",
    },
    credential: { env: "GATEWAY_KEY_OPENWEATHERMAP", in: "query", name: "appid" },
    gate: { ...NO_GATES, live_evidence: [] },
  },
  {
    definition: {
      id: "weatherapi",
      name: "WeatherAPI",
      category: "weather",
      endpoint: "https://api.weatherapi.com/v1",
      methods: ["GET"],
      auth: "api_key",
      free: true,
      description: "Weather forecast and current conditions",
    },
    credential: { env: "GATEWAY_KEY_WEATHERAPI", in: "query", name: "key" },
    gate: { ...NO_GATES, live_evidence: [] },
  },

  // Finance
  {
    definition: {
      id: "coingecko",
      name: "CoinGecko",
      category: "finance",
      endpoint: "https://api.coingecko.com/api/v3",
      methods: ["GET"],
      auth: "none",
      free: true,
      description: "Cryptocurrency data and prices",
      docs_url: "https://www.coingecko.com/en/api",
    },
    gate: {
      ...NO_GATES,
      contract_test: CONTRACTS,
      probe: { endpoint: "/ping", params: {}, success: "HTTP 200, JSON, a non-empty string gecko_says" },
      live_evidence: seen("/simple/price", "bitcoin and ethereum prices in USD and INR", LIVE_OK),
    },
  },
  {
    definition: {
      id: "finnhub",
      name: "Finnhub",
      category: "finance",
      endpoint: "https://finnhub.io/api/v1",
      methods: ["GET"],
      auth: "api_key",
      free: true,
      description: "Stock market data and quotes",
    },
    credential: { env: "GATEWAY_KEY_FINNHUB", in: "header", name: "X-Finnhub-Token" },
    gate: { ...NO_GATES, live_evidence: [] },
  },

  // News
  {
    definition: {
      id: "newsapi",
      name: "NewsAPI",
      category: "news",
      endpoint: "https://newsapi.org/v2",
      methods: ["GET"],
      auth: "api_key",
      free: true,
      description: "News aggregation and search",
      docs_url: "https://newsapi.org",
    },
    credential: { env: "GATEWAY_KEY_NEWSAPI", in: "header", name: "X-Api-Key" },
    gate: { ...NO_GATES, live_evidence: [] },
  },
  {
    definition: {
      id: "hackernews",
      name: "HackerNews",
      category: "news",
      endpoint: "https://hacker-news.firebaseio.com/v0",
      methods: ["GET"],
      auth: "none",
      free: true,
      description: "Technology and startup news",
    },
    gate: {
      ...NO_GATES,
      contract_test: CONTRACTS,
      probe: { endpoint: "/maxitem.json", params: {}, success: "HTTP 200, JSON, a positive integer (the newest item id)" },
      live_evidence: seen("/maxitem.json", "item id 50028141", LIVE_OK),
    },
  },

  // Reference
  {
    definition: {
      id: "wikipedia",
      name: "Wikipedia",
      category: "reference",
      endpoint: "https://en.wikipedia.org/w/api.php",
      methods: ["GET"],
      auth: "none",
      free: true,
      description: "Encyclopedia content via API",
    },
    gate: {
      ...NO_GATES,
      contract_test: CONTRACTS,
      probe: {
        endpoint: "/",
        params: { action: "query", meta: "siteinfo", siprop: "general", format: "json" },
        success: "HTTP 200, JSON, no error object, query.general.sitename is Wikipedia and query.general.base is on https://en.wikipedia.org/",
      },
      live_evidence: seen("(api.php) action=query list=search srsearch=Earth", "234 239 hits, top three listed", LIVE_OK),
    },
  },
  {
    definition: {
      id: "wikidata",
      name: "Wikidata",
      category: "reference",
      endpoint: "https://www.wikidata.org/w/api.php",
      methods: ["GET"],
      auth: "none",
      free: true,
      description: "Structured data knowledge base",
    },
    gate: {
      ...NO_GATES,
      contract_test: CONTRACTS,
      probe: {
        endpoint: "/",
        params: { action: "wbgetentities", ids: "Q2", props: "labels", languages: "en", format: "json" },
        success: "HTTP 200, JSON, no error object, entities.Q2.labels.en.value is Earth",
      },
      live_evidence: seen("(api.php) action=wbsearchentities search=Earth", "7 entities, Q2 first", LIVE_OK),
    },
  },

  // Sports
  {
    definition: {
      id: "thesportsdb",
      name: "TheSportsDB",
      category: "sports",
      endpoint: "https://www.thesportsdb.com/api/v1/json/1",
      methods: ["GET"],
      auth: "api_key",
      free: true,
      description: "Sports data and statistics",
    },
    gate: { ...NO_GATES, live_evidence: [] },
  },
];

/** The registry the gateway serves by default: every catalog entry, in catalog order (step 1a hides nothing). */
export function catalogDefinitions(catalog: CatalogEntry[] = CATALOG): APIDefinition[] {
  return catalog.map((entry) => entry.definition);
}

/** Where each key-based API takes its credential, from the catalog. */
export function catalogCredentials(catalog: CatalogEntry[] = CATALOG): Record<string, Credential> {
  return Object.fromEntries(catalog.filter((e) => e.credential).map((e) => [e.definition.id, e.credential as Credential]));
}

/** One API's gate record as `get_api_stats` shows it: what was signed off and when, never the terms' text or any credential. */
export interface GateSummary {
  status: GateStatus;
  auth: APIDefinition["auth"];
  base_url_pinned_on: string | null;
  auth_confirmed_on: string | null;
  terms: { url: string; on: string } | null;
  probe: string | null;
  contract_test: string | null;
  live_evidence: { calls: number; last_on: string | null };
}

/**
 * The gate record of every catalog API among `ids` (the APIs the gateway serves), read-only (owner decision, 2026-10-10: shown
 * through `get_api_stats`). Probe history is not part of it: no scheduled probe exists yet.
 */
export function gateSummaries(ids: Iterable<string>, catalog: CatalogEntry[] = CATALOG): Record<string, GateSummary> {
  const wanted = new Set(ids);
  const out: Record<string, GateSummary> = {};
  for (const { definition: d, gate: g } of catalog) {
    if (!wanted.has(d.id)) continue;
    const dates = g.live_evidence.map((e) => e.on).sort();
    out[d.id] = {
      status: g.status,
      auth: d.auth,
      base_url_pinned_on: g.base_url_pinned?.on ?? null,
      auth_confirmed_on: g.auth_confirmed?.on ?? null,
      terms: g.terms ? { url: g.terms.url, on: g.terms.on } : null,
      probe: g.probe ? g.probe.endpoint : null,
      contract_test: g.contract_test,
      live_evidence: { calls: g.live_evidence.length, last_on: dates.length > 0 ? dates[dates.length - 1] : null },
    };
  }
  return out;
}
