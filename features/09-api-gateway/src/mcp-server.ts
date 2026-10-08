import * as crypto from "crypto";
import { Credential, LiveCallError, LiveOptions, buildRequestUrl, liveGet, redact } from "./live";

interface APIDefinition {
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

interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
  source: "mock" | "live";
  /** Size of the cached data as JSON, counted against MAX_CACHE_BYTES. */
  bytes: number;
}

// Bounds on what one caller can make the process hold or start. A model (or whoever steers it) chooses the arguments of every
// call, so none of these may depend on them: without a bound, distinct calls grew the cache until the pod was killed, and one
// aggregate_apis request could start thousands of outbound calls at once with the gateway's own credentials.
/** The result cache holds at most this many entries, and about this many bytes of data; the oldest go first. */
export const MAX_CACHE_ENTRIES = 500;
export const MAX_CACHE_BYTES = 16 * 1024 * 1024;
/** One result larger than a quarter of the cache is returned but not cached (it would evict almost everything else). */
const MAX_CACHED_ENTRY_BYTES = MAX_CACHE_BYTES / 4;
/** A cache key longer than this (long params) is replaced by its SHA-256 so the key itself stays small. */
const MAX_CACHE_KEY_CHARS = 256;
/** At most this many calls in one aggregate_apis request, and this many of them in flight at a time. */
export const MAX_AGGREGATE_CALLS = 100;
const AGGREGATE_CONCURRENCY = 5;
/** Live (network) calls in flight across the whole gateway, and how many more may wait for a slot before new ones are refused. */
export const MAX_LIVE_IN_FLIGHT = 10;
export const MAX_LIVE_WAITING = 100;

/** Where each key-based API takes its credential. The environment variable is read at call time; its value is never logged or returned. */
const DEFAULT_CREDENTIALS: Record<string, Credential> = {
  openweathermap: { env: "GATEWAY_KEY_OPENWEATHERMAP", in: "query", name: "appid" },
  weatherapi: { env: "GATEWAY_KEY_WEATHERAPI", in: "query", name: "key" },
  finnhub: { env: "GATEWAY_KEY_FINNHUB", in: "header", name: "X-Finnhub-Token" },
  newsapi: { env: "GATEWAY_KEY_NEWSAPI", in: "header", name: "X-Api-Key" },
};

export interface GatewayOptions {
  /** Ids of the APIs that make real HTTP calls, or "*" for all. Default: none, so every API answers with generated mock data. */
  liveApis?: string[] | "*";
  timeoutMs?: number;
  maxResponseBytes?: number;
  userAgent?: string;
  /** Where credentials are read from at call time. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Replaces the built-in registry (used by tests to point an API at a local server). */
  apis?: APIDefinition[];
  credentials?: Record<string, Credential>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_USER_AGENT = "increadible-gateway";

function boundedInt(raw: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`${name} must be an integer from ${min} to ${max}; using ${fallback}`);
    return fallback;
  }
  return n;
}

/** The gateway's options from the environment: GATEWAY_LIVE_APIS, GATEWAY_TIMEOUT_MS, GATEWAY_MAX_RESPONSE_BYTES, GATEWAY_USER_AGENT. */
export function gatewayOptionsFromEnv(): GatewayOptions {
  const live = (process.env.GATEWAY_LIVE_APIS ?? "").trim();
  return {
    liveApis: live === "*" ? "*" : live === "" ? [] : live.split(",").map((x) => x.trim()).filter((x) => x !== ""),
    timeoutMs: boundedInt(process.env.GATEWAY_TIMEOUT_MS, "GATEWAY_TIMEOUT_MS", 100, 120_000, DEFAULT_TIMEOUT_MS),
    maxResponseBytes: boundedInt(process.env.GATEWAY_MAX_RESPONSE_BYTES, "GATEWAY_MAX_RESPONSE_BYTES", 1024, 32 * 1024 * 1024, DEFAULT_MAX_RESPONSE_BYTES),
    userAgent: process.env.GATEWAY_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  };
}

class UniversalAPIGateway {
  private apis: Map<string, APIDefinition> = new Map();
  private credentials: Map<string, Credential> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private cacheBytes = 0;
  private cacheEvictions = 0;
  private liveInFlight = 0;
  private liveWaiters: Array<() => void> = [];
  private cacheTTL: number = 300; // 5 minutes default
  private liveApis: Set<string> | "*";
  private live: LiveOptions;
  private env: Record<string, string | undefined>;
  private stats = {
    total_calls: 0,
    successful: 0,
    failed: 0,
    cached_hits: 0,
    live_calls: 0,
    api_distribution: {} as Record<string, number>,
  };

  constructor(options: GatewayOptions = {}) {
    this.liveApis = options.liveApis === "*" ? "*" : new Set(options.liveApis ?? []);
    this.live = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    };
    this.env = options.env ?? process.env;
    this.initializeAPIRegistry(options.apis);
    for (const [id, credential] of Object.entries(options.credentials ?? (options.apis ? {} : DEFAULT_CREDENTIALS))) {
      this.credentials.set(id, credential);
    }
    if (this.liveApis !== "*") {
      for (const id of this.liveApis) if (!this.apis.has(id)) console.error(`GATEWAY_LIVE_APIS names an unknown API: ${id}`);
    }
    const names = this.liveApis === "*" ? "all APIs" : [...this.liveApis].filter((id) => this.apis.has(id)).join(", ");
    if (names !== "") console.error(`Live API calls enabled for: ${names}`);
  }

  private isLive(apiId: string): boolean {
    return this.liveApis === "*" || this.liveApis.has(apiId);
  }

  private initializeAPIRegistry(replacement?: APIDefinition[]): void {
    // Core public APIs - representative sample
    const coreAPIs: APIDefinition[] = [
      // Weather
      {
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
      {
        id: "weatherapi",
        name: "WeatherAPI",
        category: "weather",
        endpoint: "https://api.weatherapi.com/v1",
        methods: ["GET"],
        auth: "api_key",
        free: true,
        description: "Weather forecast and current conditions",
      },

      // Finance
      {
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
      {
        id: "finnhub",
        name: "Finnhub",
        category: "finance",
        endpoint: "https://finnhub.io/api/v1",
        methods: ["GET"],
        auth: "api_key",
        free: true,
        description: "Stock market data and quotes",
      },

      // News
      {
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
      {
        id: "hackernews",
        name: "HackerNews",
        category: "news",
        endpoint: "https://hacker-news.firebaseio.com/v0",
        methods: ["GET"],
        auth: "none",
        free: true,
        description: "Technology and startup news",
      },

      // Reference
      {
        id: "wikipedia",
        name: "Wikipedia",
        category: "reference",
        endpoint: "https://en.wikipedia.org/w/api.php",
        methods: ["GET"],
        auth: "none",
        free: true,
        description: "Encyclopedia content via API",
      },
      {
        id: "wikidata",
        name: "Wikidata",
        category: "reference",
        endpoint: "https://www.wikidata.org/w/api.php",
        methods: ["GET"],
        auth: "none",
        free: true,
        description: "Structured data knowledge base",
      },

      // Sports
      {
        id: "thesportsdb",
        name: "TheSportsDB",
        category: "sports",
        endpoint: "https://www.thesportsdb.com/api/v1/json/1",
        methods: ["GET"],
        auth: "api_key",
        free: true,
        description: "Sports data and statistics",
      },
    ];

    // Add core APIs (or the registry the caller supplied)
    for (const api of replacement ?? coreAPIs) {
      this.apis.set(api.id, api);
    }

    console.error(`Initialized ${this.apis.size} core APIs`);
  }

  public discoverAPIs(query?: string): APIDefinition[] {
    const allAPIs = Array.from(this.apis.values());

    if (!query) {
      return allAPIs;
    }

    // Simple search - match category or name
    const lowerQuery = query.toLowerCase();
    return allAPIs.filter(
      (api) =>
        api.name.toLowerCase().includes(lowerQuery) ||
        api.category.toLowerCase().includes(lowerQuery) ||
        api.description.toLowerCase().includes(lowerQuery)
    );
  }

  public async callAPI(
    apiId: string,
    endpoint: string,
    params?: Record<string, any>
  ): Promise<any> {
    this.stats.total_calls++;

    // Check cache. Long params would make a long key that stays in memory for as long as the entry does.
    const rawKey = `${apiId}:${endpoint}:${JSON.stringify(params)}`;
    const cacheKey =
      rawKey.length > MAX_CACHE_KEY_CHARS ? `sha256:${crypto.createHash("sha256").update(rawKey).digest("hex")}` : rawKey;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      this.stats.cached_hits++;
      return {
        data: cached.data,
        source: cached.source,
        cached: true,
        timestamp: new Date().toISOString(),
      };
    }

    const api = this.apis.get(apiId);
    if (!api) {
      this.stats.failed++;
      throw new Error(`API not found: ${apiId}`);
    }

    try {
      // Real HTTP only for the APIs listed in GATEWAY_LIVE_APIS; every other API answers with generated mock data.
      const source = this.isLive(apiId) ? "live" : "mock";
      const data =
        source === "live"
          ? await this.callLive(api, endpoint, params)
          : this.generateMockData(apiId, endpoint, params);

      // Cache the result (failures are never cached)
      this.cacheData(cacheKey, data, undefined, source);
      this.stats.successful++;
      this.stats.api_distribution[apiId] =
        (this.stats.api_distribution[apiId] || 0) + 1;

      return {
        data,
        source,
        cached: false,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.stats.failed++;
      throw error;
    }
  }

  /**
   * One real GET to the API's registered URL. `endpoint` and `params` are untrusted (see live.ts); the credential comes from the
   * environment and is only ever sent to that URL. Every message that leaves this method is free of the credential.
   */
  private async callLive(api: APIDefinition, endpoint: string, params?: Record<string, any>): Promise<any> {
    const credential = this.credentials.get(api.id);
    const secret = credential ? this.env[credential.env] : undefined;
    const secrets = secret ? [secret] : [];
    try {
      if (credential && (secret === undefined || secret === "")) {
        throw new LiveCallError(`this API needs a credential: set ${credential.env}`);
      }
      // eslint-disable-next-line no-control-regex -- a line break or NUL in a header value would let the credential inject headers
      if (credential && /[\r\n\u0000]/.test(secret as string)) {
        throw new LiveCallError(`the credential in ${credential.env} contains characters that are not allowed`);
      }
      const url = buildRequestUrl(api.endpoint, endpoint, params, credential?.in === "query" ? credential.name : undefined);
      const headers: Record<string, string> = {};
      if (credential) {
        if (credential.in === "query") url.searchParams.set(credential.name, secret as string);
        else headers[credential.name] = secret as string;
      }
      return await this.withLiveSlot(() => {
        this.stats.live_calls++;
        return liveGet(url, headers, this.live, secrets);
      });
    } catch (error: any) {
      // The original error is deliberately not attached as `cause` in either throw below: its message and stack could carry a
      // credential from the request, and the cause would travel with the error to wherever it is logged or serialised.
      // eslint-disable-next-line preserve-caught-error
      if (error instanceof LiveCallError) throw new Error(`${api.id}: ${redact(error.message, secrets)}`);
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`${api.id}: unexpected error`);
    }
  }

  /**
   * Runs `fn` once one of MAX_LIVE_IN_FLIGHT slots is free. Past MAX_LIVE_WAITING waiting calls a new one is refused at once, so a
   * flood of requests becomes a quick, safe error instead of an ever-growing queue of outbound calls on the gateway's credentials.
   */
  private async withLiveSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.liveInFlight >= MAX_LIVE_IN_FLIGHT) {
      if (this.liveWaiters.length >= MAX_LIVE_WAITING) throw new LiveCallError("the gateway is busy: too many live calls are waiting");
      await new Promise<void>((resolve) => this.liveWaiters.push(resolve)); // the slot is handed over, not re-counted
    } else {
      this.liveInFlight++;
    }
    try {
      return await fn();
    } finally {
      const next = this.liveWaiters.shift();
      if (next) next();
      else this.liveInFlight--;
    }
  }

  private generateMockData(
    apiId: string,
    endpoint: string,
    params?: Record<string, any>
  ): any {
    // Generate realistic mock data based on API type
    switch (apiId) {
      case "coingecko":
        return {
          bitcoin: {
            usd: 43250.5,
            usd_market_cap: 850000000000,
            usd_24h_vol: 25000000000,
          },
        };
      case "newsapi":
        return {
          articles: [
            {
              title: "AI Advances Transform Technology",
              description: "Latest developments in artificial intelligence",
              url: "https://example.com",
              publishedAt: new Date().toISOString(),
            },
          ],
          totalResults: 1,
        };
      case "openweathermap":
        return {
          main: {
            temp: 72.5,
            humidity: 65,
            pressure: 1013,
          },
          weather: [{ main: "Partly Cloudy" }],
        };
      default:
        return {
          status: "success",
          data: params,
          timestamp: new Date().toISOString(),
        };
    }
  }

  private getFromCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl * 1000) {
      this.dropFromCache(key, entry);
      return null;
    }

    return entry;
  }

  private dropFromCache(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cacheBytes -= entry.bytes;
  }

  private cacheData(key: string, data: any, ttl: number | undefined, source: "mock" | "live"): void {
    const bytes = JSON.stringify(data)?.length ?? 0;
    const existing = this.cache.get(key);
    if (existing) this.dropFromCache(key, existing); // re-inserting moves it to the newest position
    if (bytes > MAX_CACHED_ENTRY_BYTES) return;
    // Oldest first (a Map iterates in insertion order, and every entry is inserted when written): expired entries go, then the
    // oldest live ones, until the new entry fits within both bounds.
    const now = Date.now();
    for (const [oldKey, old] of this.cache) {
      const expired = now - old.timestamp > old.ttl * 1000;
      const full = this.cache.size >= MAX_CACHE_ENTRIES || this.cacheBytes + bytes > MAX_CACHE_BYTES;
      if (!expired && !full) break;
      this.dropFromCache(oldKey, old);
      if (!expired) this.cacheEvictions++;
    }
    this.cache.set(key, {
      data,
      timestamp: now,
      ttl: ttl || this.cacheTTL,
      source,
      bytes,
    });
    this.cacheBytes += bytes;
  }

  /**
   * Several calls, MAX concurrently, results in the order asked. A call that fails does not fail the others: its place in the
   * result holds `{ error }` (the message is the same safe one `callAPI` throws), so the data already fetched is not thrown away.
   */
  public async aggregateAPIs(
    apis: Array<{ id: string; endpoint: string; params?: Record<string, any> }>
  ): Promise<any[]> {
    const results: any[] = new Array(apis.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < apis.length; i = next++) {
        try {
          const api = apis[i];
          results[i] = await this.callAPI(api.id, api.endpoint, api.params);
        } catch (error: any) {
          results[i] = { error: String(error?.message ?? error) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AGGREGATE_CONCURRENCY, apis.length) }, worker));
    return results;
  }

  public getStats(): Record<string, any> {
    return {
      total_calls: this.stats.total_calls,
      successful: this.stats.successful,
      failed: this.stats.failed,
      cache_hit_rate: (
        this.stats.cached_hits / Math.max(1, this.stats.total_calls)
      ).toFixed(2),
      api_distribution: this.stats.api_distribution,
      cached_items: this.cache.size,
      cache_evictions: this.cacheEvictions,
      live_calls: this.stats.live_calls,
      live_apis: this.liveApis === "*" ? "*" : [...this.liveApis].filter((id) => this.apis.has(id)),
    };
  }

  public clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  public addCustomAPI(api: APIDefinition, credential?: Credential): void {
    this.apis.set(api.id, api);
    if (credential) this.credentials.set(api.id, credential);
  }
}

// Initialize gateway
const apiGateway = new UniversalAPIGateway(gatewayOptionsFromEnv());

// Tool: Discover APIs
export const discoverAPIsTool = {
  name: "discover_apis",
  description: "Discover available public APIs by category or search term",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query (optional): category, name, or description",
      },
    },
  },
};

// Tool: Call API
export const callAPITool = {
  name: "call_api",
  description: "Call a specific public API with parameters",
  inputSchema: {
    type: "object" as const,
    properties: {
      api_id: { type: "string", description: "The API identifier" },
      endpoint: { type: "string", description: "API endpoint path" },
      params: {
        type: "object",
        description: "Query parameters (optional)",
      },
    },
    required: ["api_id", "endpoint"],
  },
};

// Tool: Aggregate APIs
export const aggregateAPIsTool = {
  name: "aggregate_apis",
  description: "Call multiple APIs in parallel and combine results",
  inputSchema: {
    type: "object" as const,
    properties: {
      apis: {
        type: "array",
        description: "Array of API calls to aggregate",
      },
    },
    required: ["apis"],
  },
};

// Tool: Get gateway stats
export const getStatsTool = {
  name: "get_api_stats",
  description: "Get statistics on API gateway usage and caching",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

/**
 * What is wrong with the arguments of one call, or null. call_api names the API `api_id`; an item of aggregate_apis names it `id`.
 * `label` prefixes the message when the call is an item of an aggregate. Checked here so that a wrong type is a plain message
 * rather than whatever error the code behind it happens to throw.
 */
function callInputProblem(input: unknown, label: string, idField: "api_id" | "id"): string | null {
  const at = (field: string) => (label ? `${label}.${field}` : field);
  if (!input || typeof input !== "object" || Array.isArray(input)) return `${label || "arguments"} must be an object`;
  const call = input as Record<string, unknown>;
  if (typeof call[idField] !== "string") return `${at(idField)} must be a string`;
  if (typeof call.endpoint !== "string") return `${at("endpoint")} must be a string`;
  if (call.params !== undefined && call.params !== null && (typeof call.params !== "object" || Array.isArray(call.params))) {
    return `${at("params")} must be an object`;
  }
  return null;
}

function aggregateInputProblem(apis: unknown): string | null {
  if (!Array.isArray(apis)) return "apis must be an array";
  if (apis.length > MAX_AGGREGATE_CALLS) return `apis may hold at most ${MAX_AGGREGATE_CALLS} calls (got ${apis.length})`;
  for (let i = 0; i < apis.length; i++) {
    const problem = callInputProblem(apis[i], `apis[${i}]`, "id");
    if (problem) return problem;
  }
  return null;
}

// Process tool calls
export async function processToolCall(
  toolName: string,
  toolInput: Record<string, any>
): Promise<string> {
  switch (toolName) {
    case "discover_apis":
      // A non-string query used to throw out of processToolCall and take the whole server down.
      if (toolInput.query != null && typeof toolInput.query !== "string") {
        return JSON.stringify({ error: "query must be a string" });
      }
      return JSON.stringify(apiGateway.discoverAPIs(toolInput.query));

    case "call_api": {
      const problem = callInputProblem(toolInput, "", "api_id");
      if (problem) return JSON.stringify({ error: problem });
      try {
        const result = await apiGateway.callAPI(
          toolInput.api_id,
          toolInput.endpoint,
          toolInput.params
        );
        return JSON.stringify(result);
      } catch (error: any) {
        return JSON.stringify({ error: error.message });
      }
    }

    case "aggregate_apis": {
      const problem = aggregateInputProblem(toolInput.apis);
      if (problem) return JSON.stringify({ error: problem });
      const results = await apiGateway.aggregateAPIs(toolInput.apis);
      // A failed call holds { error } in its place (see aggregateAPIs); a result that worked never has a top-level error.
      const failed = results.filter((r) => r && typeof r === "object" && "error" in r).length;
      if (results.length > 0 && failed === results.length) {
        return JSON.stringify({ error: `all ${failed} calls failed`, data: results, count: results.length, failed });
      }
      return JSON.stringify({ data: results, count: results.length, ...(failed > 0 ? { failed } : {}) });
    }

    case "get_api_stats":
      return JSON.stringify(apiGateway.getStats());

    default:
      return JSON.stringify({ error: "Unknown tool" });
  }
}

export { UniversalAPIGateway, APIDefinition };
