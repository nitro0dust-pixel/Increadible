import * as http from "http";
import { AddressInfo } from "net";
import { UniversalAPIGateway, APIDefinition, GatewayOptions, gatewayOptionsFromEnv } from "../features/09-api-gateway/src/mcp-server";
import { buildRequestUrl, liveGet, redact, LiveCallError } from "../features/09-api-gateway/src/live";
import { rng } from "./helpers/ab-golden-data";

/**
 * Live HTTP calls in the API gateway (opt-in, GATEWAY_LIVE_APIS). The provider is a real HTTP server on 127.0.0.1 that records
 * every request, so these tests check what actually goes over the wire, not what the code means to send. The credential values
 * below are fake. The properties under test: no request reaches anything but the registered URL; the credential is added by
 * the gateway only and appears in no result, error, log or cache key; failures are bounded, safe and never cached.
 */

const KEY_Q = "qsecret-123456";
const KEY_H = "hsecret-654321";

interface Seen {
  method?: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}
let seen: Seen[] = [];
let otherHits = 0;
let provider: http.Server;
let other: http.Server;
let base: string;
let otherBase: string;

const json = (res: http.ServerResponse, status: number, body: unknown, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

beforeAll(async () => {
  other = http.createServer((req, res) => {
    otherHits += 1;
    json(res, 200, { secret: true });
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

  provider = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url ?? "", headers: req.headers });
    const url = new URL(req.url ?? "/", "http://x");
    switch (url.pathname.replace(/(.)\/$/, "$1")) { // a trailing slash reaches the same route; the request is still recorded as sent
      case "/v1/ok":
      case "/v1/api.php":
        return json(res, 200, { ok: true, path: url.pathname, query: Object.fromEntries(url.searchParams) });
      case "/v1/json-charset":
        return json(res, 200, { ok: 1 }, "application/json; charset=utf-8");
      case "/v1/json-api":
        return json(res, 200, { ok: 2 }, "application/vnd.api+json");
      case "/v1/json-text":
        return json(res, 200, { ok: 3 }, "text/json");
      case "/v1/null":
        return json(res, 200, "null");
      case "/v1/slow":
        return; // never answers
      case "/v1/big":
        return json(res, 200, JSON.stringify({ pad: "x".repeat(10_000) }));
      case "/v1/text":
        return json(res, 200, "hello", "text/plain");
      case "/v1/badjson":
        return json(res, 200, "{oops");
      case "/v1/echo-error": // an API that repeats the key it was given in its error body
        return json(res, 500, { error: `invalid key ${url.searchParams.get("appid")} / ${req.headers["x-api-key"] ?? ""}` });
      case "/v1/long-error":
        return json(res, 500, "x".repeat(1500), "text/plain");
      case "/v1/limited":
        res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
        return res.end('{"error":"slow down"}');
      case "/v1/redirect":
        res.writeHead(302, { location: `${otherBase}/secret` });
        return res.end();
      default:
        return json(res, 404, { error: "not found" });
    }
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  provider.closeAllConnections();
  other.closeAllConnections();
  await Promise.all([new Promise((r) => provider.close(r)), new Promise((r) => other.close(r))]);
});

let errors: jest.SpyInstance;
beforeEach(() => {
  seen = [];
  otherHits = 0;
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

const api = (id: string, endpoint = base): APIDefinition => ({
  id,
  name: id,
  category: "test",
  endpoint,
  methods: ["GET"],
  auth: "none",
  free: true,
  description: `test api ${id}`,
});
const apis = () => [api("plain"), api("qkey"), api("hkey"), api("page", `${base}/api.php`)]; // built per test: the port is known only once the server runs
const CREDENTIALS = {
  qkey: { env: "TEST_KEY_Q", in: "query" as const, name: "appid" },
  hkey: { env: "TEST_KEY_H", in: "header" as const, name: "X-Api-Key" },
};
const open = (options: GatewayOptions = {}) =>
  new UniversalAPIGateway({
    apis: apis(),
    credentials: CREDENTIALS,
    liveApis: "*",
    env: { TEST_KEY_Q: KEY_Q, TEST_KEY_H: KEY_H },
    timeoutMs: 400,
    maxResponseBytes: 2048,
    ...options,
  });
const fail = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e: any) {
    return String(e.message);
  }
  throw new Error("expected the call to fail");
};

describe("which APIs are live", () => {
  it("answers with mock data and touches no network unless an API is listed", async () => {
    const gw = open({ liveApis: undefined });
    const r = await gw.callAPI("plain", "/ok", { q: "x" });
    expect(r.source).toBe("mock");
    expect(r.data).toMatchObject({ status: "success" });
    expect(seen).toEqual([]);
  });

  it("is live only for the listed APIs", async () => {
    const gw = open({ liveApis: ["plain"] });
    expect((await gw.callAPI("plain", "/ok")).source).toBe("live");
    expect((await gw.callAPI("qkey", "/ok")).source).toBe("mock");
    expect(seen.map((s) => s.url)).toEqual(["/v1/ok"]);
    expect(gw.getStats()).toMatchObject({ live_apis: ["plain"], live_calls: 1 });
  });

  it("is live for every API with '*'", async () => {
    const gw = open({ liveApis: "*" });
    for (const id of ["plain", "qkey", "hkey"]) expect((await gw.callAPI(id, "/ok")).source).toBe("live");
    expect(seen).toHaveLength(3);
    expect(gw.getStats().live_apis).toBe("*");
  });

  it("notes an unknown id in the list (names only) and does not count it as live", () => {
    const gw = open({ liveApis: ["plain", "nope"] });
    expect(gw.getStats().live_apis).toEqual(["plain"]);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain("GATEWAY_LIVE_APIS names an unknown API: nope");
  });

  it("reads its settings from the environment, and falls back (with a note) on a bad number", () => {
    const keep = { ...process.env };
    try {
      for (const k of ["GATEWAY_LIVE_APIS", "GATEWAY_TIMEOUT_MS", "GATEWAY_MAX_RESPONSE_BYTES", "GATEWAY_USER_AGENT", "GATEWAY_RATE_LIMITS"]) delete process.env[k];
      expect(gatewayOptionsFromEnv()).toEqual({ liveApis: [], timeoutMs: 10000, maxResponseBytes: 1048576, userAgent: "increadible-gateway", rateLimits: {} });
      Object.assign(process.env, { GATEWAY_LIVE_APIS: " coingecko, wikipedia ,", GATEWAY_TIMEOUT_MS: "2500", GATEWAY_MAX_RESPONSE_BYTES: "4096", GATEWAY_USER_AGENT: "me (a@b.example)" });
      expect(gatewayOptionsFromEnv()).toEqual({ liveApis: ["coingecko", "wikipedia"], timeoutMs: 2500, maxResponseBytes: 4096, userAgent: "me (a@b.example)", rateLimits: {} });
      process.env.GATEWAY_LIVE_APIS = "*";
      expect(gatewayOptionsFromEnv().liveApis).toBe("*");
      Object.assign(process.env, { GATEWAY_TIMEOUT_MS: "soon", GATEWAY_MAX_RESPONSE_BYTES: "5" });
      expect(gatewayOptionsFromEnv()).toMatchObject({ timeoutMs: 10000, maxResponseBytes: 1048576 });
      expect(errors.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining("GATEWAY_TIMEOUT_MS must be an integer"), expect.stringContaining("GATEWAY_MAX_RESPONSE_BYTES must be an integer")]));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });
});

describe("a successful call", () => {
  it("sends one plain GET to the registered path with the params as the query, and returns the JSON", async () => {
    const gw = open({ userAgent: "tester (t@example.org)" });
    const r = await gw.callAPI("plain", "/ok", { q: "Paris", n: 3, flag: true, units: "metric" });
    expect(r).toMatchObject({ source: "live", cached: false, data: { ok: true, path: "/v1/ok", query: { q: "Paris", n: "3", flag: "true", units: "metric" } } });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/v1/ok?q=Paris&n=3&flag=true&units=metric");
    expect(seen[0].headers).toMatchObject({ accept: "application/json", "user-agent": "tester (t@example.org)" });
    for (const h of ["authorization", "cookie", "x-api-key"]) expect(seen[0].headers[h]).toBeUndefined();
  });

  it("caches a success (and says it is live), counts a network call only when it is made", async () => {
    const gw = open();
    await gw.callAPI("plain", "/ok", { a: 1 });
    const again = await gw.callAPI("plain", "/ok", { a: 1 });
    expect(again).toMatchObject({ cached: true, source: "live" });
    expect(seen).toHaveLength(1);
    expect(gw.getStats()).toMatchObject({ total_calls: 2, successful: 1, live_calls: 1 });
  });

  it("takes an endpoint with or without a leading slash, and an empty one for an API whose registered URL is the whole endpoint", async () => {
    const gw = open();
    await gw.callAPI("plain", "ok");
    await gw.callAPI("plain", "/ok/");
    await gw.callAPI("page", "", { action: "query" });
    await gw.callAPI("page", "/", { action: "query", format: "json" });
    expect(seen.map((s) => s.url)).toEqual(["/v1/ok", "/v1/ok/", "/v1/api.php?action=query", "/v1/api.php?action=query&format=json"]);
  });

  it("accepts the usual JSON content types, and a JSON null", async () => {
    const gw = open();
    for (const [p, expected] of [["/json-charset", { ok: 1 }], ["/json-api", { ok: 2 }], ["/json-text", { ok: 3 }], ["/null", null]] as const) {
      expect((await gw.callAPI("plain", p)).data).toEqual(expected);
    }
  });

  it("serves a cached JSON null as cached (a falsy value is still a value)", async () => {
    const gw = open();
    await gw.callAPI("plain", "/null");
    expect(await gw.callAPI("plain", "/null")).toMatchObject({ cached: true, data: null });
    expect(seen).toHaveLength(1);
  });
});

describe("credentials", () => {
  it("adds a query credential itself, and a header credential as a header", async () => {
    const gw = open();
    await gw.callAPI("qkey", "/ok", { q: "x" });
    await gw.callAPI("hkey", "/ok", { q: "x" });
    expect(seen[0].url).toBe(`/v1/ok?q=x&appid=${KEY_Q}`);
    expect(seen[0].headers["x-api-key"]).toBeUndefined();
    expect(seen[1].url).toBe("/v1/ok?q=x");
    expect(seen[1].headers["x-api-key"]).toBe(KEY_H);
  });

  it("does not send a credential to an API that has none", async () => {
    await open().callAPI("plain", "/ok");
    expect(seen[0].url).toBe("/v1/ok");
    expect(JSON.stringify(seen[0].headers)).not.toContain("secret");
  });

  it("refuses, without a request, when the credential is not set, and names the variable (not a value)", async () => {
    const gw = open({ env: { TEST_KEY_H: KEY_H } });
    const message = await fail(gw.callAPI("qkey", "/ok"));
    expect(message).toBe("qkey: this API needs a credential: set TEST_KEY_Q");
    expect(await fail(open({ env: { TEST_KEY_Q: "" } }).callAPI("qkey", "/ok"))).toContain("set TEST_KEY_Q");
    expect(seen).toEqual([]);
  });

  it("refuses a credential with a line break in it (header injection), without printing it", async () => {
    const gw = open({ env: { TEST_KEY_H: "abcd\r\nX-Evil: 1", TEST_KEY_Q: "ok-key-1234" } });
    const message = await fail(gw.callAPI("hkey", "/ok"));
    expect(message).toContain("TEST_KEY_H contains characters that are not allowed");
    expect(message).not.toContain("Evil");
    expect(seen).toEqual([]);
  });

  it("does not let the caller set the credential, whatever the case", async () => {
    const gw = open();
    for (const key of ["appid", "APPID", "AppId"]) {
      expect(await fail(gw.callAPI("qkey", "/ok", { [key]: "mine" }))).toContain("params may not set 'appid'");
    }
    expect(seen).toEqual([]);
  });

  it("keeps the credential out of the cache key, the stats and every log line", async () => {
    const gw = open();
    await gw.callAPI("qkey", "/ok", { q: "x" });
    await gw.callAPI("hkey", "/ok");
    const everything = JSON.stringify([...(gw as any).cache.keys()]) + JSON.stringify(gw.getStats()) + JSON.stringify(errors.mock.calls);
    expect(everything).not.toContain(KEY_Q);
    expect(everything).not.toContain(KEY_H);
  });
});

describe("what the model may not do with endpoint and params", () => {
  // [what it is, the endpoint, which check must be the one that stops it]. Naming the check matters: the dot-segment check and the
  // "stays under the registered path" check overlap, so a test that only saw "rejected" would miss the loss of either one.
  const BAD_ENDPOINTS: Array<[string, unknown, RegExp]> = [
    ["a full URL to another host", "https://evil.example/x", /not a URL/],
    ["a URL to the second local server", "OTHER/secret", /not a URL/],
    ["a protocol-relative URL", "//evil.example/x", /not a URL/],
    ["a scheme in any case", "HTTP://evil.example", /not a URL/],
    ["javascript:", "javascript:alert(1)", /not a URL/],
    ["a scheme without slashes", "https:evil.example", /not a URL/],
    ["a parent segment", "../x", /'\.' or '\.\.' segments/],
    ["a parent segment after a slash", "/../x", /'\.' or '\.\.' segments/],
    ["a parent segment in the middle", "/a/../../x", /'\.' or '\.\.' segments/],
    ["a current-directory segment", "/a/./b", /'\.' or '\.\.' segments/],
    ["an encoded parent segment", "/%2e%2e/x", /encoded dots, slashes or null bytes/],
    ["an encoded parent segment, upper case", "/%2E%2E/x", /encoded dots, slashes or null bytes/],
    ["an encoded slash", "/a%2Fb", /encoded dots, slashes or null bytes/],
    ["an encoded backslash", "/a%5Cb", /encoded dots, slashes or null bytes/],
    ["an encoded null byte", "/a%00b", /encoded dots, slashes or null bytes/],
    ["a backslash", "/a\\b", /plain path without spaces/],
    ["two backslashes", "\\\\evil.example\\x", /plain path without spaces/],
    ["a query string", "/x?y=1", /plain path without spaces/],
    ["a fragment", "/x#frag", /plain path without spaces/],
    ["a space", "/x y", /plain path without spaces/],
    ["a newline", "/x\n", /plain path without spaces/],
    ["a leading tab", "\t/x", /plain path without spaces/],
    ["a null byte", "/x\u0000", /plain path without spaces/],
    ["a number", 12345, /must be a string/],
    ["null", null, /must be a string/],
    ["an object", {}, /must be a string/],
    ["a string that is too long", "/" + "a".repeat(600), /longer than 512/],
  ];

  it.each(BAD_ENDPOINTS)("rejects %s without sending anything", async (_label, endpoint, pattern) => {
    const gw = open();
    const value = typeof endpoint === "string" ? endpoint.replace("OTHER", otherBase) : endpoint;
    const message = await fail(gw.callAPI("plain", value as any));
    expect(message).toMatch(/^plain: endpoint /);
    expect(message).toMatch(pattern);
    expect(seen).toEqual([]);
    expect(otherHits).toBe(0);
  });

  const BAD_PARAMS: Array<[string, unknown, RegExp]> = [
    ["a nested object", { a: { b: 1 } }, /params\.a must be/],
    ["an array value", { a: [1, 2] }, /params\.a must be/],
    ["a null value", { a: null }, /params\.a must be/],
    ["an undefined value", { a: undefined }, /params\.a must be/],
    ["a non-finite number", { a: Infinity }, /params\.a must be/],
    ["NaN", { a: NaN }, /params\.a must be/],
    ["a value that is too long", { a: "x".repeat(1025) }, /params\.a is longer/],
    ["a key with a space", { "a b": 1 }, /params keys/],
    ["a key with an ampersand", { "a&b": 1 }, /params keys/],
    ["an empty key", { "": 1 }, /params keys/],
    ["an array instead of an object", [1, 2], /params must be an object/],
    ["a string instead of an object", "x=1", /params must be an object/],
    ["more than 30 entries", Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, i])), /more than 30/],
  ];

  it.each(BAD_PARAMS)("rejects params with %s without sending anything", async (_label, params, pattern) => {
    const message = await fail(open().callAPI("plain", "/ok", params as any));
    expect(message).toMatch(pattern);
    expect(seen).toEqual([]);
  });

  it("encodes param values instead of letting them add parameters or change the path", async () => {
    await open().callAPI("plain", "/ok", { q: "a&appid=evil#x?y=/../z", "x[0]": "1" });
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0].url, "http://x");
    expect(url.pathname).toBe("/v1/ok");
    expect([...url.searchParams.keys()]).toEqual(["q", "x[0]"]);
    expect(url.searchParams.get("q")).toBe("a&appid=evil#x?y=/../z");
  });

  it("builds URLs only under the registered URL (pure checks)", () => {
    expect(buildRequestUrl("https://api.example.com/v3", "/simple/price", { ids: "bitcoin" }).href).toBe("https://api.example.com/v3/simple/price?ids=bitcoin");
    expect(buildRequestUrl("https://api.example.com/v3/", "simple", undefined).href).toBe("https://api.example.com/v3/simple");
    expect(buildRequestUrl("https://example.org/w/api.php", "", { action: "query" }).href).toBe("https://example.org/w/api.php?action=query");
    expect(buildRequestUrl("https://example.org", "/a", null).href).toBe("https://example.org/a");
    expect(buildRequestUrl("https://example.org", "", undefined).href).toBe("https://example.org/");
  });

  it("never produces a URL outside the registered origin and path, whatever the endpoint (60 000 random endpoints, 3 bases)", () => {
    // The property behind all the checks above, tested on its own so that it does not depend on which check fires.
    const tokens = [".", "..", "/", "//", "%2e", "%2E", "%2f", "%5c", "%00", "\\", "?", "#", ":", "@", " ", "\t", "\n", "a", "b", "0", "-", "~", "%", "%zz", "\u2025", "\uff0e", "\u3002", "\u0000", "http:", "//evil.example/", ".%2e", "%2e.", "..%2f", "%2e%2e%2f", "\u202e", "\ud83d\ude00"];
    const bases = ["https://api.example.com/v3", "https://example.org/w/api.php", "https://example.org"];
    const r = rng(20261007);
    let accepted = 0;
    const escaped: string[] = [];
    for (let i = 0; i < 60000; i++) {
      const length = 1 + Math.floor(r() * 8);
      const endpoint = Array.from({ length }, () => tokens[Math.floor(r() * tokens.length)]).join("");
      const baseUrl = bases[i % bases.length];
      let url: URL;
      try {
        url = buildRequestUrl(baseUrl, endpoint, undefined);
      } catch (e) {
        if (!(e instanceof LiveCallError)) escaped.push(`threw ${String(e)} for ${JSON.stringify(endpoint)}`);
        continue;
      }
      accepted += 1;
      const b = new URL(baseUrl);
      const basePath = b.pathname.replace(/\/+$/, "");
      const inside = url.origin === b.origin && (url.pathname === b.pathname || url.pathname.startsWith(basePath + "/")) && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
      if (!inside) escaped.push(`${baseUrl} + ${JSON.stringify(endpoint)} -> ${url.href}`);
    }
    expect(escaped.slice(0, 5)).toEqual([]);
    expect(accepted).toBeGreaterThan(1000); // not vacuous: many of the endpoints are legitimate
  });

  it("does not follow a redirect: the second server is never reached", async () => {
    const message = await fail(open().callAPI("hkey", "/redirect"));
    expect(message).toBe("hkey: the API answered with a redirect (HTTP 302), which is not followed");
    expect(otherHits).toBe(0);
  });
});

describe("failures are bounded, safe and not cached", () => {
  it("times out", async () => {
    expect(await fail(open({ timeoutMs: 150 }).callAPI("plain", "/slow"))).toBe("plain: timed out after 150 ms");
  });

  it("refuses a response over the size limit", async () => {
    expect(await fail(open({ maxResponseBytes: 2048 }).callAPI("plain", "/big"))).toBe("plain: response is larger than 2048 bytes");
  });

  it("refuses a response that is not JSON, or is invalid JSON", async () => {
    const gw = open();
    expect(await fail(gw.callAPI("plain", "/text"))).toBe("plain: the response is not JSON (content-type: text/plain)");
    expect(await fail(gw.callAPI("plain", "/badjson"))).toBe("plain: the response is not valid JSON");
  });

  it("reports an HTTP error with its status and (short) body, and the retry hint on 429", async () => {
    const gw = open();
    expect(await fail(gw.callAPI("plain", "/nothing-here"))).toBe('plain: HTTP 404: {"error":"not found"}');
    expect(await fail(gw.callAPI("plain", "/limited"))).toBe('plain: HTTP 429 (retry after 30): {"error":"slow down"}');
  });

  it("reports a network error by its code only", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const gw = new UniversalAPIGateway({ apis: [api("gone", `http://127.0.0.1:${port}/v1`)], liveApis: "*" });
    expect(await fail(gw.callAPI("gone", "/ok"))).toBe("gone: network error (ECONNREFUSED)");
  });

  it("scrubs the credential from an error body that repeats it, in both places a credential can travel", async () => {
    const gw = open();
    const q = await fail(gw.callAPI("qkey", "/echo-error"));
    const h = await fail(gw.callAPI("hkey", "/echo-error"));
    expect(q).toBe("qkey: HTTP 500: " + JSON.stringify({ error: "invalid key [redacted] / " }));
    expect(h).toContain("[redacted]");
    for (const message of [q, h]) {
      expect(message).not.toContain(KEY_Q);
      expect(message).not.toContain(KEY_H);
    }
  });

  it("shows at most 200 characters of an error body", async () => {
    const message = await fail(open().callAPI("plain", "/long-error"));
    expect(message).toMatch(/^plain: HTTP 500: x{200}$/);
  });

  it("scrubs the credential from every failure of a credentialed API", async () => {
    const gw = open({ timeoutMs: 150, maxResponseBytes: 2048 });
    const messages: string[] = [];
    for (const p of ["/slow", "/big", "/text", "/badjson", "/limited", "/redirect", "/echo-error", "/missing"]) {
      for (const id of ["qkey", "hkey"]) messages.push(await fail(gw.callAPI(id, p)));
    }
    expect(messages).toHaveLength(16);
    expect(messages.join("\n")).not.toContain(KEY_Q);
    expect(messages.join("\n")).not.toContain(KEY_H);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret-");
  });

  it("does not cache a failure: the next identical call goes out again", async () => {
    const gw = open();
    await fail(gw.callAPI("plain", "/nothing-here"));
    await fail(gw.callAPI("plain", "/nothing-here"));
    expect(seen).toHaveLength(2);
    expect(gw.getStats()).toMatchObject({ failed: 2, successful: 0, live_calls: 2 });
    expect((gw as any).cache.size).toBe(0);
  });

  it("counts a rejected request as failed but not as a live call", async () => {
    const gw = open();
    await fail(gw.callAPI("plain", "../x"));
    expect(gw.getStats()).toMatchObject({ failed: 1, live_calls: 0 });
  });

  it("leaves an unknown API as before", async () => {
    expect(await fail(open().callAPI("bogus", "/x"))).toBe("API not found: bogus");
  });
});

describe("aggregate_apis and the tool layer with live calls", () => {
  it("mixes live and mock APIs in one aggregate, and one safe failure no longer discards the others (audit finding GW-4)", async () => {
    const gw = open({ liveApis: ["plain"] });
    const ok = await gw.aggregateAPIs([
      { id: "plain", endpoint: "/ok" },
      { id: "qkey", endpoint: "/ok" },
    ]);
    expect(ok.map((r) => r.source)).toEqual(["live", "mock"]);
    // The failed call holds its safe message in its own place; the call that worked is still there.
    const mixed = await gw.aggregateAPIs([{ id: "plain", endpoint: "/ok" }, { id: "plain", endpoint: "https://evil.example" }]);
    expect(mixed[0]).toMatchObject({ source: "live", cached: expect.any(Boolean) });
    expect(mixed[1]).toEqual({ error: expect.stringContaining("plain: endpoint must be a path") });
  });
});

describe("the built-in registry (fetch is mocked: no external network is touched)", () => {
  let fetchSpy: jest.SpyInstance;
  let calls: Array<{ url: string; headers: Record<string, string> }>;
  beforeEach(() => {
    calls = [];
    fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: any) => {
      calls.push({ url: String(input), headers: init?.headers ?? {} });
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as any);
  });
  afterEach(() => fetchSpy.mockRestore());
  const builtin = (env: Record<string, string> = {}) => new UniversalAPIGateway({ liveApis: "*", env });

  it.each([
    ["openweathermap", "GATEWAY_KEY_OPENWEATHERMAP", "https://api.openweathermap.org/data/2.5/weather?q=Paris&appid=KEYVALUE1"],
    ["weatherapi", "GATEWAY_KEY_WEATHERAPI", "https://api.weatherapi.com/v1/weather?q=Paris&key=KEYVALUE1"],
  ])("sends the %s key as a query parameter, as its provider expects", async (id, env, expected) => {
    await builtin({ [env]: "KEYVALUE1" }).callAPI(id, "/weather", { q: "Paris" });
    expect(calls.map((c) => c.url)).toEqual([expected]);
  });

  it.each([
    ["finnhub", "GATEWAY_KEY_FINNHUB", "X-Finnhub-Token", "https://finnhub.io/api/v1/quote?symbol=AAPL"],
    ["newsapi", "GATEWAY_KEY_NEWSAPI", "X-Api-Key", "https://newsapi.org/v2/top-headlines?country=us"],
  ])("sends the %s key as the %s header, never in the URL", async (id, env, header, expected) => {
    const path = new URL(expected).pathname.replace(/^\/(api\/v1|v2)/, "");
    const params = Object.fromEntries(new URL(expected).searchParams);
    await builtin({ [env]: "KEYVALUE2" }).callAPI(id, path, params);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(expected);
    expect(calls[0].headers[header]).toBe("KEYVALUE2");
    expect(calls[0].url).not.toContain("KEYVALUE2");
  });

  it.each([
    ["coingecko", "/simple/price", "https://api.coingecko.com/api/v3/simple/price"],
    ["hackernews", "/topstories.json", "https://hacker-news.firebaseio.com/v0/topstories.json"],
    ["wikipedia", "", "https://en.wikipedia.org/w/api.php"],
    ["wikidata", "/", "https://www.wikidata.org/w/api.php"],
    ["thesportsdb", "/all_leagues.php", "https://www.thesportsdb.com/api/v1/json/1/all_leagues.php"],
  ])("calls %s at its registered URL and adds no credential", async (id, endpoint, expected) => {
    await builtin().callAPI(id, endpoint);
    expect(calls.map((c) => c.url)).toEqual([expected]);
    expect(Object.keys(calls[0].headers).map((h) => h.toLowerCase()).sort()).toEqual(["accept", "user-agent"]);
  });

  it.each([
    ["openweathermap", "GATEWAY_KEY_OPENWEATHERMAP"],
    ["weatherapi", "GATEWAY_KEY_WEATHERAPI"],
    ["finnhub", "GATEWAY_KEY_FINNHUB"],
    ["newsapi", "GATEWAY_KEY_NEWSAPI"],
  ])("tells you which variable to set when the %s key is missing, and calls nothing", async (id, env) => {
    expect(await fail(builtin().callAPI(id, "/x"))).toBe(`${id}: this API needs a credential: set ${env}`);
    expect(calls).toEqual([]);
  });

  it("hides what is wrong with a broken registered URL (nothing from the error is passed on)", async () => {
    const gw = new UniversalAPIGateway({ apis: [api("broken", "this is not a url")], liveApis: "*" });
    expect(await fail(gw.callAPI("broken", "/x"))).toBe("broken: unexpected error");
  });
});

describe("liveGet on its own", () => {
  // The gateway scrubs again around liveGet, so a test through the gateway cannot tell whether the inner scrubbing still works.
  it("scrubs a credential the API repeats, without the gateway around it", async () => {
    const options = { timeoutMs: 400, maxResponseBytes: 2048, userAgent: "t" };
    const message = await liveGet(new URL(`${base}/echo-error?appid=${KEY_Q}`), {}, options, [KEY_Q]).then(
      () => "",
      (e) => String(e.message)
    );
    expect(message).toBe("HTTP 500: " + JSON.stringify({ error: "invalid key [redacted] / " }));
  });
});

describe("redact", () => {
  it("replaces a secret in its plain and URL-encoded forms, and ignores a very short one", () => {
    expect(redact("a k3y/+ b k3y%2F%2B c", ["k3y/+"])).toBe("a [redacted] b [redacted] c");
    expect(redact("abc", ["a"])).toBe("abc");
    expect(redact("x", [])).toBe("x");
  });
});
