import * as http from "http";
import { AddressInfo } from "net";
import {
  MAX_CACHE_BYTES,
  UniversalAPIGateway,
  APIDefinition,
  gatewayOptionsFromEnv,
  processToolCall,
} from "../features/09-api-gateway/src/mcp-server";
import { buildRequestUrl, liveGet, redact, LiveCallError, LiveOptions } from "../features/09-api-gateway/src/live";

/**
 * Edges of the gateway that no test pinned until the mutation-testing pass of the audit: every limit at exactly the limit and one
 * past it, every message with its exact text, the options read from the environment, the search fields, the cache clock and the
 * cache byte bounds. A mutation of each line below (a `>` made `>=`, a branch removed) passed the whole suite before these tests.
 */

let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await processToolCall(name, input));

describe("buildRequestUrl: sizes, paths and parameters at the edge", () => {
  const BASE = "https://api.test/v1";
  const fails = (fn: () => unknown, message: string | RegExp) => {
    let thrown: unknown;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LiveCallError);
    expect((thrown as Error).message).toMatch(message);
  };

  it("accepts an endpoint of exactly 512 characters and refuses 513", () => {
    expect(() => buildRequestUrl(BASE, "a".repeat(512), {})).not.toThrow();
    fails(() => buildRequestUrl(BASE, "a".repeat(513), {}), "endpoint is longer than 512 characters");
  });

  it("refuses only a scheme at the start: a colon later in the path is fine", () => {
    expect(buildRequestUrl(BASE, "items/a:b", {}).pathname).toBe("/v1/items/a:b");
    expect(buildRequestUrl(BASE, "/items/x:y:z", {}).pathname).toBe("/v1/items/x:y:z");
    fails(() => buildRequestUrl(BASE, "javascript:alert", {}), "not a URL");
    fails(() => buildRequestUrl(BASE, "//evil.test/x", {}), "not a URL");
  });

  it("joins under the registered path whatever slashes the registered URL or the endpoint carries", () => {
    expect(buildRequestUrl("https://api.test/v1/", "ok", {}).pathname).toBe("/v1/ok");
    expect(buildRequestUrl("https://api.test/v1//", "ok", {}).pathname).toBe("/v1/ok"); // more than one trailing slash
    expect(buildRequestUrl(BASE, "sub/ok", {}).pathname).toBe("/v1/sub/ok"); // a slash inside the endpoint stays
    expect(buildRequestUrl(BASE, "/sub/ok", {}).pathname).toBe("/v1/sub/ok");
    expect(buildRequestUrl("https://api.test", "ok", {}).pathname).toBe("/ok");
  });

  it("takes an empty endpoint or a bare slash as the registered URL itself", () => {
    expect(buildRequestUrl("https://api.test/w/api.php", "", {}).pathname).toBe("/w/api.php");
    expect(buildRequestUrl("https://api.test/w/api.php", "/", {}).pathname).toBe("/w/api.php");
    expect(buildRequestUrl("https://api.test/v1/", "", {}).pathname).toBe("/v1/");
  });

  it("accepts 30 parameters and refuses 31", () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(buildRequestUrl(BASE, "ok", many(30)).searchParams.size).toBe(30);
    fails(() => buildRequestUrl(BASE, "ok", many(31)), "params has more than 30 entries");
  });

  it("accepts a parameter name of 64 characters and refuses 65 or none", () => {
    expect(buildRequestUrl(BASE, "ok", { ["k".repeat(64)]: 1 }).searchParams.size).toBe(1);
    fails(() => buildRequestUrl(BASE, "ok", { ["k".repeat(65)]: 1 }), /params keys must be 1 to 64 letters/);
    fails(() => buildRequestUrl(BASE, "ok", { "": 1 }), /params keys must be 1 to 64 letters/);
    fails(() => buildRequestUrl(BASE, "ok", { "a b": 1 }), /params keys must be 1 to 64 letters/);
  });

  it("accepts a parameter value of 1024 characters and refuses 1025", () => {
    expect(buildRequestUrl(BASE, "ok", { q: "v".repeat(1024) }).searchParams.get("q")).toHaveLength(1024);
    fails(() => buildRequestUrl(BASE, "ok", { q: "v".repeat(1025) }), "params.q is longer than 1024 characters");
  });

  it("takes strings, booleans and finite numbers as values, and nothing else", () => {
    const url = buildRequestUrl(BASE, "ok", { s: "text", b: false, n: -2.5, zero: 0 });
    expect(Object.fromEntries(url.searchParams)).toEqual({ s: "text", b: "false", n: "-2.5", zero: "0" });
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, {}, [], [1], () => 1, 10n, Symbol("x")]) {
      fails(() => buildRequestUrl(BASE, "ok", { v: bad }), "params.v must be a string, a finite number or a boolean");
    }
  });

  it("refuses params that are not an object, and takes null or undefined as no params", () => {
    fails(() => buildRequestUrl(BASE, "ok", [1]), "params must be an object");
    fails(() => buildRequestUrl(BASE, "ok", "q=1"), "params must be an object");
    expect(buildRequestUrl(BASE, "ok", null).search).toBe("");
    expect(buildRequestUrl(BASE, "ok", undefined).search).toBe("");
  });

  it("refuses the name the gateway uses for the credential, in any letter case", () => {
    fails(() => buildRequestUrl(BASE, "ok", { APPID: "x" }, "appid"), "params may not set 'appid'");
    expect(buildRequestUrl(BASE, "ok", { appid: "x" }, undefined).searchParams.get("appid")).toBe("x");
  });
});

describe("redact", () => {
  it("searches for secrets of 4 characters or more, and leaves shorter ones alone", () => {
    expect(redact("key=abcd end", ["abcd"])).toBe("key=[redacted] end");
    expect(redact("key=abc end", ["abc"])).toBe("key=abc end");
    expect(redact("key= end", [""])).toBe("key= end");
  });
  it("replaces the URL-encoded form too", () => {
    expect(redact("a%2Fb%2Fc and a/b/c", ["a/b/c"])).toBe("[redacted] and [redacted]");
  });
});

describe("liveGet against a local server: statuses, bodies and content types", () => {
  const options = (extra: Partial<LiveOptions> = {}): LiveOptions => ({ timeoutMs: 2000, maxResponseBytes: 10_000, userAgent: "t", ...extra });
  let server: http.Server;
  let base: string;
  /** What the server sends for the next request: set by each test. */
  let reply: (res: http.ServerResponse) => void;
  const get = (secrets: string[] = [], extra: Partial<LiveOptions> = {}) => liveGet(new URL(`${base}/x`), {}, options(extra), secrets);
  const failure = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(LiveCallError);
      return (error as Error).message;
    }
    throw new Error("expected the call to fail");
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => reply(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const send = (status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => {
    reply = (res) => {
      res.writeHead(status, headers);
      res.end(body);
    };
  };

  it("treats 300 to 399 as a redirect that is not followed, and 299 and 400 as what they are", async () => {
    send(300, "");
    expect(await failure(get())).toBe("the API answered with a redirect (HTTP 300), which is not followed");
    send(399, "");
    expect(await failure(get())).toBe("the API answered with a redirect (HTTP 399), which is not followed");
    send(400, "bad");
    expect(await failure(get())).toBe("HTTP 400: bad");
    send(299, '{"ok":1}');
    expect(await get()).toEqual({ ok: 1 });
  });

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    const body = JSON.stringify({ pad: "x".repeat(100) });
    send(200, body);
    expect(await get([], { maxResponseBytes: Buffer.byteLength(body) })).toEqual({ pad: "x".repeat(100) });
    expect(await failure(get([], { maxResponseBytes: Buffer.byteLength(body) - 1 }))).toBe(
      `response is larger than ${Buffer.byteLength(body) - 1} bytes`
    );
  });

  it("shows an error body on one line, trimmed, at most 200 characters, with secrets removed", async () => {
    send(500, "  first line\n\n\tsecond   line  ", { "content-type": "text/plain" });
    expect(await failure(get())).toBe("HTTP 500: first line second line");
    send(500, `${"y".repeat(250)}`, { "content-type": "text/plain" });
    expect(await failure(get())).toBe(`HTTP 500: ${"y".repeat(200)}`);
    send(500, "token abcd leaked", { "content-type": "text/plain" });
    expect(await failure(get(["abcd"]))).toBe("HTTP 500: token [redacted] leaked");
    send(500, "", { "content-type": "text/plain" });
    expect(await failure(get())).toBe("HTTP 500"); // no body, no colon
  });

  it("adds the retry hint on 429 only, only when the header is there, cut to 40 characters", async () => {
    send(429, "slow", { "content-type": "text/plain", "retry-after": "30" });
    expect(await failure(get())).toBe("HTTP 429 (retry after 30): slow");
    send(429, "slow", { "content-type": "text/plain" });
    expect(await failure(get())).toBe("HTTP 429: slow");
    send(503, "down", { "content-type": "text/plain", "retry-after": "30" });
    expect(await failure(get())).toBe("HTTP 503: down");
    send(429, "slow", { "content-type": "text/plain", "retry-after": "1".repeat(60) });
    expect(await failure(get())).toBe(`HTTP 429 (retry after ${"1".repeat(40)}): slow`);
  });

  it("accepts JSON content types and refuses the near misses, saying what it saw", async () => {
    for (const type of ["application/json", "APPLICATION/JSON", "application/json; charset=utf-8", "application/json ; charset=utf-8", "application/problem+json", "text/json", "json"]) {
      send(200, '{"ok":1}', { "content-type": type });
      expect(await get()).toEqual({ ok: 1 });
    }
    for (const type of ["application/jsonp; charset=utf-8", "application/xjson", "text/html", "application/json-seq", "xjson"]) {
      send(200, '{"ok":1}', { "content-type": type });
      expect(await failure(get())).toBe(`the response is not JSON (content-type: ${type})`);
    }
    send(200, '{"ok":1}', {});
    expect(await failure(get())).toBe("the response is not JSON (content-type: none)");
    const long = `text/${"z".repeat(100)}`;
    send(200, "{}", { "content-type": long });
    expect(await failure(get())).toBe(`the response is not JSON (content-type: ${long.slice(0, 60)})`);
  });

  it("says when the body is JSON in name only", async () => {
    send(200, "{not json");
    expect(await failure(get())).toBe("the response is not valid JSON");
  });
});

describe("liveGet: how a failed fetch is reported (the real fetch is replaced)", () => {
  const options: LiveOptions = { timeoutMs: 1234, maxResponseBytes: 1000, userAgent: "t" };
  const failWith = async (rejection: unknown): Promise<string> => {
    jest.spyOn(global, "fetch").mockRejectedValue(rejection);
    try {
      await liveGet(new URL("http://x.test/"), {}, options, []);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected the call to fail");
  };

  it("names a timeout, whichever way the runtime spells it", async () => {
    expect(await failWith(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe("timed out after 1234 ms");
    expect(await failWith(Object.assign(new Error("t"), { name: "AbortError" }))).toBe("timed out after 1234 ms");
  });

  it("reports only the error code of anything else, 'unknown' when there is none, and never the message", async () => {
    expect(await failWith(Object.assign(new Error("GET http://x.test/?key=SECRET failed"), { cause: { code: "ECONNRESET" } }))).toBe("network error (ECONNRESET)");
    expect(await failWith(new Error("GET http://x.test/?key=SECRET failed"))).toBe("network error (unknown)");
    expect(await failWith(Object.assign(new Error("x"), { cause: { code: 104 } }))).toBe("network error (unknown)");
    expect(await failWith(Object.assign(new Error("x"), { cause: null }))).toBe("network error (unknown)");
    expect(await failWith(undefined)).toBe("network error (unknown)");
    expect(await failWith(null)).toBe("network error (unknown)");
  });

  it("sends a GET without following redirects, with the accept header, the user agent and the caller's headers", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await liveGet(new URL("http://x.test/p"), { "X-Key": "v", Accept: "text/plain" }, options, []);
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://x.test/p");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual({ Accept: "text/plain", "User-Agent": "t", "X-Key": "v" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the options read from the environment", () => {
  const NAMES = ["GATEWAY_LIVE_APIS", "GATEWAY_TIMEOUT_MS", "GATEWAY_MAX_RESPONSE_BYTES", "GATEWAY_USER_AGENT"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => NAMES.forEach((n) => ((saved[n] = process.env[n]), delete process.env[n])));
  afterEach(() => NAMES.forEach((n) => (saved[n] === undefined ? delete process.env[n] : (process.env[n] = saved[n]))));

  it("defaults to no live API, 10 s, 1 MiB and a named user agent", () => {
    expect(gatewayOptionsFromEnv()).toEqual({ liveApis: [], timeoutMs: 10_000, maxResponseBytes: 1_048_576, userAgent: "increadible-gateway" });
    expect(errors).not.toHaveBeenCalled();
  });

  it("reads the list of live APIs: trimmed, without empty items, '*' for all, blanks for none", () => {
    process.env.GATEWAY_LIVE_APIS = "  *  ";
    expect(gatewayOptionsFromEnv().liveApis).toBe("*");
    process.env.GATEWAY_LIVE_APIS = " a , b ,, c ,";
    expect(gatewayOptionsFromEnv().liveApis).toEqual(["a", "b", "c"]);
    process.env.GATEWAY_LIVE_APIS = "    ";
    expect(gatewayOptionsFromEnv().liveApis).toEqual([]);
    process.env.GATEWAY_LIVE_APIS = " , ";
    expect(gatewayOptionsFromEnv().liveApis).toEqual([]);
  });

  it("takes an integer from the limit up to the limit, and falls back with a message outside it", () => {
    const timeout = (raw: string) => {
      process.env.GATEWAY_TIMEOUT_MS = raw;
      return gatewayOptionsFromEnv().timeoutMs;
    };
    expect(timeout("100")).toBe(100);
    expect(timeout("120000")).toBe(120_000);
    expect(errors).not.toHaveBeenCalled();
    for (const bad of ["99", "120001", "1.5", "abc", "-5", "1e3x"]) {
      errors.mockClear();
      expect(timeout(bad)).toBe(10_000);
      expect(errors).toHaveBeenCalledWith("GATEWAY_TIMEOUT_MS must be an integer from 100 to 120000; using 10000");
    }
    delete process.env.GATEWAY_TIMEOUT_MS; // the last value above was a bad one: it would be reported by every call from here
    process.env.GATEWAY_MAX_RESPONSE_BYTES = "1024";
    expect(gatewayOptionsFromEnv().maxResponseBytes).toBe(1024);
    process.env.GATEWAY_MAX_RESPONSE_BYTES = String(32 * 1024 * 1024);
    expect(gatewayOptionsFromEnv().maxResponseBytes).toBe(32 * 1024 * 1024);
    errors.mockClear();
    process.env.GATEWAY_MAX_RESPONSE_BYTES = "1023";
    expect(gatewayOptionsFromEnv().maxResponseBytes).toBe(1_048_576);
    process.env.GATEWAY_MAX_RESPONSE_BYTES = String(32 * 1024 * 1024 + 1);
    expect(gatewayOptionsFromEnv().maxResponseBytes).toBe(1_048_576);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it("takes a blank limit as unset, without a message", () => {
    process.env.GATEWAY_TIMEOUT_MS = "   ";
    process.env.GATEWAY_MAX_RESPONSE_BYTES = "";
    expect(gatewayOptionsFromEnv()).toMatchObject({ timeoutMs: 10_000, maxResponseBytes: 1_048_576 });
    expect(errors).not.toHaveBeenCalled();
  });

  it("trims the user agent and uses the default for a blank one", () => {
    process.env.GATEWAY_USER_AGENT = "  my-agent/1.0  ";
    expect(gatewayOptionsFromEnv().userAgent).toBe("my-agent/1.0");
    process.env.GATEWAY_USER_AGENT = "   ";
    expect(gatewayOptionsFromEnv().userAgent).toBe("increadible-gateway");
  });
});

describe("what the gateway says at start-up about live APIs", () => {
  it("names the live APIs that exist, warns about the ones that do not, and says nothing when none is live", () => {
    new UniversalAPIGateway({ liveApis: [] });
    expect(errors).toHaveBeenCalledTimes(1); // only 'Initialized 9 core APIs'
    expect(errors).toHaveBeenCalledWith("Initialized 9 core APIs");
    errors.mockClear();
    new UniversalAPIGateway(); // no options at all: the same, and no unknown API is invented
    expect(errors.mock.calls.map((c) => c[0])).toEqual(["Initialized 9 core APIs"]);

    errors.mockClear();
    new UniversalAPIGateway({ liveApis: ["coingecko", "nope"] });
    expect(errors).toHaveBeenCalledWith("GATEWAY_LIVE_APIS names an unknown API: nope");
    expect(errors).toHaveBeenCalledWith("Live API calls enabled for: coingecko");
    expect(errors).not.toHaveBeenCalledWith("GATEWAY_LIVE_APIS names an unknown API: coingecko");

    errors.mockClear();
    new UniversalAPIGateway({ liveApis: ["nope"] });
    expect(errors.mock.calls.map((c) => c[0])).toEqual(["Initialized 9 core APIs", "GATEWAY_LIVE_APIS names an unknown API: nope"]); // nothing live, so no 'enabled' line

    errors.mockClear();
    new UniversalAPIGateway({ liveApis: "*" });
    expect(errors).toHaveBeenCalledWith("Live API calls enabled for: all APIs");
    expect(errors.mock.calls.some((c) => String(c[0]).includes("unknown API"))).toBe(false);
  });

  it("lists in the statistics only the live APIs that exist", () => {
    expect(new UniversalAPIGateway({ liveApis: ["coingecko", "nope"] }).getStats().live_apis).toEqual(["coingecko"]);
    expect(new UniversalAPIGateway({ liveApis: "*" }).getStats().live_apis).toBe("*");
    expect(new UniversalAPIGateway().getStats().live_apis).toEqual([]);
  });
});

describe("the built-in registry and the search over it", () => {
  const registry = () => new UniversalAPIGateway().discoverAPIs();

  it("lists 9 APIs, each GET-only and free, and says which ones use an API key", () => {
    const apis = registry();
    expect(apis.map((a) => a.id)).toHaveLength(9);
    for (const api of apis) {
      expect(api.methods).toEqual(["GET"]);
      expect(api.free).toBe(true);
    }
    expect(Object.fromEntries(apis.filter((a) => a.auth !== "none").map((a) => [a.id, a.auth]))).toEqual({
      openweathermap: "api_key",
      weatherapi: "api_key",
      finnhub: "api_key",
      newsapi: "api_key",
      thesportsdb: "api_key", // the provider's public test key is part of the registered URL, so no GATEWAY_KEY_ variable (DEPLOYMENT.md)
    });
  });

  const custom: APIDefinition[] = [
    { id: "a", name: "Alpha Service", category: "misc", endpoint: "https://a.test", methods: ["GET"], auth: "none", free: true, description: "plain" },
    { id: "b", name: "Beta", category: "Weather", endpoint: "https://b.test", methods: ["GET"], auth: "none", free: true, description: "plain" },
    { id: "c", name: "Gamma", category: "misc", endpoint: "https://c.test", methods: ["GET"], auth: "none", free: true, description: "Reports Rain" },
  ];
  const search = (query?: string) => new UniversalAPIGateway({ apis: custom }).discoverAPIs(query).map((a) => a.id);

  it("matches the query against the name, the category and the description, in any letter case", () => {
    expect(search("alpha")).toEqual(["a"]);
    expect(search("ALPHA SERVICE")).toEqual(["a"]);
    expect(search("weather")).toEqual(["b"]);
    expect(search("WEATHER")).toEqual(["b"]);
    expect(search("rain")).toEqual(["c"]);
    expect(search("RAIN")).toEqual(["c"]);
    expect(search("misc")).toEqual(["a", "c"]);
    expect(search("no such thing")).toEqual([]);
  });

  it("returns everything for no query or an empty one", () => {
    expect(search()).toEqual(["a", "b", "c"]);
    expect(search("")).toEqual(["a", "b", "c"]);
  });
});

describe("the statistics", () => {
  it("count a call once in the total and once per API when it worked", async () => {
    const gw = new UniversalAPIGateway();
    await gw.callAPI("hackernews", "/a", { n: 1 });
    await gw.callAPI("hackernews", "/a", { n: 2 });
    await gw.callAPI("coingecko", "/a");
    const stats = gw.getStats();
    expect(stats.api_distribution).toEqual({ hackernews: 2, coingecko: 1 });
    expect(stats).toMatchObject({ total_calls: 3, successful: 3, failed: 0, cached_items: 3 });
  });

  it("start one call per item of an aggregate, not more", async () => {
    const gw = new UniversalAPIGateway();
    await gw.aggregateAPIs([1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: "hackernews", endpoint: "/a", params: { n } })));
    expect(gw.getStats().total_calls).toBe(7);
    expect(gw.getStats().api_distribution).toEqual({ hackernews: 7 });
  });

  it("show a cache hit as one, without counting it as a success", async () => {
    const gw = new UniversalAPIGateway();
    await gw.callAPI("hackernews", "/a");
    const again = await gw.callAPI("hackernews", "/a");
    expect(again.cached).toBe(true);
    expect(gw.getStats()).toMatchObject({ total_calls: 2, successful: 1, cache_hit_rate: "0.50" });
  });
});

describe("what the generated mock data looks like", () => {
  const data = async (id: string, params?: Record<string, unknown>) => (await new UniversalAPIGateway().callAPI(id, "/x", params)).data;

  it("has the shape of the real answer for the three APIs that have a model of it", async () => {
    const coin = await data("coingecko");
    expect(Object.keys(coin)).toEqual(["bitcoin"]);
    expect(Object.keys(coin.bitcoin).sort()).toEqual(["usd", "usd_24h_vol", "usd_market_cap"]);
    for (const value of Object.values(coin.bitcoin)) expect(typeof value).toBe("number");

    const news = await data("newsapi");
    expect(news.totalResults).toBe(1);
    expect(news.articles).toHaveLength(1);
    expect(Object.keys(news.articles[0]).sort()).toEqual(["description", "publishedAt", "title", "url"]);
    expect(Number.isNaN(Date.parse(news.articles[0].publishedAt))).toBe(false);

    const weather = await data("openweathermap");
    expect(Object.keys(weather.main).sort()).toEqual(["humidity", "pressure", "temp"]);
    expect(weather.weather).toHaveLength(1);
    expect(typeof weather.weather[0].main).toBe("string");
  });

  it("echoes the parameters for every other API", async () => {
    const other = await data("hackernews", { q: "x" });
    expect(other).toMatchObject({ status: "success", data: { q: "x" } });
    expect(Number.isNaN(Date.parse(other.timestamp))).toBe(false);
  });
});

describe("the result cache: its clock, its keys and its byte bounds", () => {
  let now: jest.SpyInstance;
  const T0 = 1_800_000_000_000;
  beforeEach(() => {
    now = jest.spyOn(Date, "now").mockReturnValue(T0);
  });

  it("serves an entry for exactly its time to live, and not a millisecond longer", async () => {
    const gw = new UniversalAPIGateway();
    await gw.callAPI("hackernews", "/a");
    now.mockReturnValue(T0 + 300_000);
    expect((await gw.callAPI("hackernews", "/a")).cached).toBe(true);
    now.mockReturnValue(T0 + 300_001);
    expect((await gw.callAPI("hackernews", "/a")).cached).toBe(false);
  });

  it("does not drop an entry that is exactly as old as its time to live when it makes room for another", async () => {
    const gw = new UniversalAPIGateway();
    await gw.callAPI("hackernews", "/a");
    now.mockReturnValue(T0 + 300_000);
    await gw.callAPI("hackernews", "/b");
    expect(gw.getStats().cached_items).toBe(2);
    now.mockReturnValue(T0 + 300_001);
    await gw.callAPI("hackernews", "/c"); // now the first is expired and goes; the second is not
    expect(gw.getStats()).toMatchObject({ cached_items: 2, cache_evictions: 0 }); // an expired entry is not an eviction
  });

  it("drops an expired entry when it is read, so a call that then fails leaves nothing stale behind", async () => {
    const api: APIDefinition = { id: "x", name: "X", category: "misc", endpoint: "http://api.test/v1", methods: ["GET"], auth: "none", free: true, description: "d" };
    const gw = new UniversalAPIGateway({ apis: [api] });
    await gw.callAPI("x", "/a");
    expect(gw.getStats().cached_items).toBe(1);
    now.mockReturnValue(T0 + 300_001);
    (gw as any).liveApis = new Set(["x"]); // the same call now goes out, and fails
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
    await expect(gw.callAPI("x", "/a")).rejects.toThrow("x: network error (unknown)");
    expect(gw.getStats().cached_items).toBe(0);
  });

  it("keeps a short key as it is and replaces a key over 256 characters by its SHA-256", async () => {
    const gw = new UniversalAPIGateway();
    const cacheKeys = () => [...(gw as any).cache.keys()] as string[];
    await gw.callAPI("hackernews", "/a", { n: 1 });
    expect(cacheKeys()).toEqual(['hackernews:/a:{"n":1}']);

    const keyLength = (pad: number) => `hackernews:/a:${JSON.stringify({ p: "x".repeat(pad) })}`.length;
    const exactly256 = 256 - keyLength(0);
    await gw.callAPI("hackernews", "/a", { p: "x".repeat(exactly256) });
    await gw.callAPI("hackernews", "/a", { p: "x".repeat(exactly256 + 1) });
    const keys = cacheKeys();
    expect(keys[1]).toHaveLength(256);
    expect(keys[1].startsWith("hackernews:")).toBe(true);
    expect(keys[2]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  describe("byte bounds (the entry sizes are exact; the data is the echoed parameters of a mock call)", () => {
    const quarter = MAX_CACHE_BYTES / 4;
    const frame = JSON.stringify({ status: "success", data: { p: "" }, timestamp: new Date(T0).toISOString() }).length;
    /** Params that make the cached result exactly `bytes` long as JSON. `tag` keeps the keys apart. */
    const sized = (bytes: number, tag: string) => ({ p: tag + "x".repeat(bytes - frame - tag.length) });

    it("caches a result of exactly a quarter of the cache and does not cache one byte more", async () => {
      const gw = new UniversalAPIGateway();
      await gw.callAPI("hackernews", "/a", sized(quarter, "a"));
      expect(gw.getStats().cached_items).toBe(1);
      await gw.callAPI("hackernews", "/a", sized(quarter + 1, "b"));
      expect(gw.getStats().cached_items).toBe(1);
      expect((await gw.callAPI("hackernews", "/a", sized(quarter + 1, "b"))).cached).toBe(false);
    });

    it("fits entries up to exactly MAX_CACHE_BYTES and evicts the oldest only when the next one would pass it", async () => {
      const gw = new UniversalAPIGateway();
      for (const tag of ["a", "b", "c", "d"]) await gw.callAPI("hackernews", "/a", sized(quarter, tag));
      expect(gw.getStats()).toMatchObject({ cached_items: 4, cache_evictions: 0 }); // 4 x a quarter is exactly the bound
      await gw.callAPI("hackernews", "/a", { n: 1 });
      expect(gw.getStats()).toMatchObject({ cached_items: 4, cache_evictions: 1 });
      expect((await gw.callAPI("hackernews", "/a", sized(quarter, "a"))).cached).toBe(false); // the oldest went
    });
  });
});

describe("the tools around the gateway", () => {
  it("answers a tool it does not have with an error, not an exception", async () => {
    expect(await call("no_such_tool")).toEqual({ error: "Unknown tool" });
  });

  it("refuses a query that is not a string, takes none, null or an empty one as 'everything'", async () => {
    for (const bad of [0, 1, false, true, {}, [], ["a"]]) expect(await call("discover_apis", { query: bad })).toEqual({ error: "query must be a string" });
    for (const none of [{}, { query: null }, { query: "" }]) expect(await call("discover_apis", none)).toHaveLength(9);
    expect((await call("discover_apis", { query: "weather" })).length).toBeGreaterThan(0);
  });

  it("names what is wrong with the arguments of a call, with the position inside an aggregate", async () => {
    expect(await call("call_api", { endpoint: "/a" })).toEqual({ error: "api_id must be a string" });
    expect(await call("call_api", { api_id: "hackernews" })).toEqual({ error: "endpoint must be a string" });
    expect(await call("call_api", { api_id: "hackernews", endpoint: "/a", params: [1] })).toEqual({ error: "params must be an object" });
    expect(await call("call_api", { api_id: "hackernews", endpoint: "/a", params: "q" })).toEqual({ error: "params must be an object" });
    expect((await call("call_api", { api_id: "hackernews", endpoint: "/a", params: null })).data).toBeDefined();

    expect(await call("aggregate_apis", { apis: "x" })).toEqual({ error: "apis must be an array" });
    for (const item of [null, 5, "x", []]) expect(await call("aggregate_apis", { apis: [item] })).toEqual({ error: "apis[0] must be an object" });
    expect(await call("aggregate_apis", { apis: [{ id: "hackernews", endpoint: "/a" }, { endpoint: "/a" }] })).toEqual({ error: "apis[1].id must be a string" });
    expect(await call("aggregate_apis", { apis: [{ id: "hackernews" }] })).toEqual({ error: "apis[0].endpoint must be a string" });
    expect(await call("aggregate_apis", { apis: [{ id: "hackernews", endpoint: "/a", params: [] }] })).toEqual({ error: "apis[0].params must be an object" });
    expect((await call("aggregate_apis", { apis: [{ id: "hackernews", endpoint: "/a", params: null }] })).count).toBe(1);
  });

  it("reports how many calls of an aggregate failed: none, some, all, and the empty aggregate", async () => {
    const good = { id: "hackernews", endpoint: "/ok" };
    const bad = { id: "nope", endpoint: "/ok" };

    const allGood = await call("aggregate_apis", { apis: [good, good] });
    expect(allGood.count).toBe(2);
    expect("failed" in allGood).toBe(false);
    expect("error" in allGood).toBe(false);

    const some = await call("aggregate_apis", { apis: [good, bad] });
    expect(some).toMatchObject({ count: 2, failed: 1 });
    expect("error" in some).toBe(false);
    expect(some.data[0].source).toBe("mock");
    expect(some.data[1]).toEqual({ error: "API not found: nope" });

    const none = await call("aggregate_apis", { apis: [bad, bad, bad] });
    expect(none).toMatchObject({ error: "all 3 calls failed", count: 3, failed: 3 });

    expect(await call("aggregate_apis", { apis: [] })).toEqual({ data: [], count: 0 });
  });

  it("returns a failed call_api as an error with the message and nothing else", async () => {
    expect(await call("call_api", { api_id: "nope", endpoint: "/a" })).toEqual({ error: "API not found: nope" });
  });

  it("reports its statistics through get_api_stats", async () => {
    const stats = await call("get_api_stats");
    expect(Object.keys(stats).sort()).toEqual([
      "api_distribution", "cache_evictions", "cache_hit_rate", "cached_items", "failed", "live_apis", "live_calls", "successful", "total_calls",
    ]);
  });
});
