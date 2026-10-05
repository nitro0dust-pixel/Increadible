import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

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
}

class UniversalAPIGateway {
  private apis: Map<string, APIDefinition> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTTL: number = 300; // 5 minutes default
  private stats = {
    total_calls: 0,
    successful: 0,
    failed: 0,
    cached_hits: 0,
    api_distribution: {} as Record<string, number>,
  };

  constructor() {
    this.initializeAPIRegistry();
  }

  private initializeAPIRegistry(): void {
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
        id: "coinagecko",
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

    // Add core APIs
    for (const api of coreAPIs) {
      this.apis.set(api.id, api);
    }

    console.log(`Initialized ${this.apis.size} core APIs`);
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

    // Check cache
    const cacheKey = `${apiId}:${endpoint}:${JSON.stringify(params)}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      this.stats.cached_hits++;
      return {
        data: cached,
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
      // In production, this would make actual HTTP requests
      // For demo, return mock data
      const data = this.generateMockData(apiId, endpoint, params);

      // Cache the result
      this.cacheData(cacheKey, data);
      this.stats.successful++;
      this.stats.api_distribution[apiId] =
        (this.stats.api_distribution[apiId] || 0) + 1;

      return {
        data,
        cached: false,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.stats.failed++;
      throw error;
    }
  }

  private generateMockData(
    apiId: string,
    endpoint: string,
    params?: Record<string, any>
  ): any {
    // Generate realistic mock data based on API type
    switch (apiId) {
      case "coinagecko":
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

  private getFromCache(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl * 1000) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  private cacheData(key: string, data: any, ttl?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.cacheTTL,
    });
  }

  public aggregateAPIs(
    apis: Array<{ id: string; endpoint: string; params?: Record<string, any> }>
  ): Promise<any[]> {
    // Aggregate multiple API calls in parallel
    return Promise.all(
      apis.map((api) => this.callAPI(api.id, api.endpoint, api.params))
    );
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
    };
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public addCustomAPI(api: APIDefinition): void {
    this.apis.set(api.id, api);
  }
}

// Initialize gateway
const apiGateway = new UniversalAPIGateway();

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

// Process tool calls
export async function processToolCall(
  toolName: string,
  toolInput: Record<string, any>
): Promise<string> {
  switch (toolName) {
    case "discover_apis":
      return JSON.stringify(apiGateway.discoverAPIs(toolInput.query));

    case "call_api":
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

    case "aggregate_apis":
      try {
        const results = await apiGateway.aggregateAPIs(toolInput.apis);
        return JSON.stringify({ data: results, count: results.length });
      } catch (error: any) {
        return JSON.stringify({ error: error.message });
      }

    case "get_api_stats":
      return JSON.stringify(apiGateway.getStats());

    default:
      return JSON.stringify({ error: "Unknown tool" });
  }
}

export { UniversalAPIGateway, APIDefinition };
