import * as http from "http";
import * as net from "net";
import * as index from "../src/index";
import * as server from "../src/server";

/**
 * What the HTTP transport asks of a request before it reaches the handler, beyond the bearer token (audit findings PA-04 and PA-05):
 * an Origin header (a web page's, never a client's) is refused unless it is listed; GET and DELETE on /mcp say "not offered" (405) instead of
 * "not found"; an MCP-Protocol-Version header the server does not speak is refused (400). Each test starts the real HTTP server on a free port.
 */
const TOKEN = "s3cr3t-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
const SUPPORTED = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

const listen = (srv: http.Server) => new Promise<number>((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));
type Headers = Record<string, string | string[]>;
interface Answer { status: number; body: string; headers: http.IncomingHttpHeaders }
const send = (port: number, method: string, url: string, headers: Headers = {}, body?: string) =>
  new Promise<Answer>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers, agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
const post = (port: number, headers: Headers = {}) => send(port, "POST", "/mcp", headers, PING);

async function withServer(token: string | undefined, options: index.HttpOptions, fn: (port: number) => Promise<void>) {
  const srv = index.createHttpServer(token, options);
  const port = await listen(srv);
  try {
    await fn(port);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
}
const rejected = (reason: string) => server.metrics.http_rejected[reason] || 0;

describe("Origin (a web page's header; no other client sends one)", () => {
  it("refuses a request with an Origin that is not listed: 403 before the token is looked at, also with the right token", async () => {
    await withServer(TOKEN, {}, async (port) => {
      for (const origin of ["http://evil.example", "https://app.example.com", "http://localhost:3000", "null", ""]) {
        const withToken = await post(port, { ...AUTH, Origin: origin });
        expect({ origin, status: withToken.status, body: withToken.body }).toEqual({ origin, status: 403, body: '{"error":"Forbidden origin"}' });
        // not 401: the page is told nothing about the token
        expect({ origin, status: (await post(port, { Origin: origin })).status }).toEqual({ origin, status: 403 });
      }
    });
  });

  it("serves a request without an Origin exactly as before: the token decides", async () => {
    await withServer(TOKEN, {}, async (port) => {
      expect((await post(port, AUTH)).status).toBe(200);
      expect((await post(port)).status).toBe(401);
      expect((await send(port, "GET", "/metrics", AUTH)).status).toBe(200);
    });
  });

  it("also protects a server started without a token (the case a web page can reach through DNS rebinding)", async () => {
    await withServer(undefined, {}, async (port) => {
      expect((await post(port)).status).toBe(200);
      expect((await post(port, { Origin: "http://evil.example", "Content-Type": "text/plain" })).status).toBe(403);
      expect((await send(port, "GET", "/metrics", { Origin: "http://evil.example" })).status).toBe(403);
    });
  });

  it("serves an Origin that is listed (and still asks for the token); the comparison is exact on scheme, host and port, and ignores case", async () => {
    await withServer(TOKEN, { allowedOrigins: ["https://app.example.com", "http://localhost:3000"] }, async (port) => {
      for (const origin of ["https://app.example.com", "HTTPS://APP.EXAMPLE.COM", "http://localhost:3000"]) {
        expect({ origin, status: (await post(port, { ...AUTH, Origin: origin })).status }).toEqual({ origin, status: 200 });
        expect({ origin, status: (await post(port, { Origin: origin })).status }).toEqual({ origin, status: 401 });
      }
      for (const origin of ["http://app.example.com", "https://app.example.com:8443", "https://app.example.com.evil.example", "https://sub.app.example.com", "http://localhost", "http://localhost:3001", "https://evil.example"]) {
        expect({ origin, status: (await post(port, { ...AUTH, Origin: origin })).status }).toEqual({ origin, status: 403 });
      }
    });
  });

  it("compares in lower case on both sides: a list handed to the server in capitals still matches the lower-case Origin a browser sends", async () => {
    await withServer(TOKEN, { allowedOrigins: ["HTTPS://App.Example.com"] }, async (port) => {
      expect((await post(port, { ...AUTH, Origin: "https://app.example.com" })).status).toBe(200);
      expect((await post(port, { ...AUTH, Origin: "https://other.example.com" })).status).toBe(403);
    });
  });

  it("leaves /health and /ready alone (probes carry no Origin and the two hold nothing), but covers every other route", async () => {
    await withServer(TOKEN, {}, async (port) => {
      const origin = { Origin: "http://evil.example" };
      for (const url of ["/health", "/ready"]) expect({ url, status: (await send(port, "GET", url, origin)).status }).toEqual({ url, status: 200 });
      for (const [method, url] of [["GET", "/metrics"], ["GET", "/nope"], ["OPTIONS", "/mcp"], ["GET", "/mcp"], ["DELETE", "/mcp"], ["HEAD", "/mcp"]]) {
        expect({ method, url, status: (await send(port, method, url, { ...AUTH, ...origin })).status }).toEqual({ method, url, status: 403 });
      }
      // and without the header the same requests are what they were
      expect((await send(port, "OPTIONS", "/mcp", AUTH)).status).toBe(404);
    });
  });

  it("sends no CORS header, whatever the answer", async () => {
    await withServer(TOKEN, { allowedOrigins: ["https://app.example.com"] }, async (port) => {
      for (const origin of ["https://app.example.com", "http://evil.example"]) {
        const r = await post(port, { ...AUTH, Origin: origin });
        expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
      }
    });
  });

  it("counts each refusal, once, as increadible_http_rejected_total{reason=\"origin_forbidden\"}", async () => {
    await withServer(TOKEN, {}, async (port) => {
      const before = rejected("origin_forbidden");
      await post(port, { Origin: "http://evil.example" });
      await post(port, { ...AUTH, Origin: "http://evil.example" });
      await post(port, AUTH); // served: not counted
      expect(rejected("origin_forbidden")).toBe(before + 2);
      expect(server.renderPrometheusMetrics()).toContain('increadible_http_rejected_total{reason="origin_forbidden"}');
    });
  });
});

describe("parseAllowedOrigins (ALLOWED_ORIGINS)", () => {
  it("reduces each entry to its canonical origin, drops duplicates and empty items, and reports nothing for a clean list", () => {
    expect(index.parseAllowedOrigins(" https://App.Example.com , http://localhost:3000/,, https://app.example.com:443 , http://127.0.0.1:8080 ")).toEqual({
      origins: ["https://app.example.com", "http://localhost:3000", "http://127.0.0.1:8080"],
      problems: [],
    });
    expect(index.parseAllowedOrigins(undefined)).toEqual({ origins: [], problems: [] });
    expect(index.parseAllowedOrigins("")).toEqual({ origins: [], problems: [] });
    expect(index.parseAllowedOrigins(" , ,")).toEqual({ origins: [], problems: [] });
  });

  it("leaves out, and reports by name, an entry that is not a plain http(s) origin: a wildcard, null, a bare host, a path, a query, a fragment, credentials, another scheme", () => {
    const bad = ["*", "null", "app.example.com", "https://app.example.com/app", "https://app.example.com?x=1", "https://app.example.com#top", "https://user:pw@app.example.com", "https://user@app.example.com", "ftp://app.example.com", "https://", "https://app example.com", "http://a.example//"];
    const r = index.parseAllowedOrigins(["https://ok.example", ...bad].join(","));
    expect(r.origins).toEqual(["https://ok.example"]);
    expect(r.problems).toHaveLength(bad.length);
    bad.forEach((entry, i) => expect(r.problems[i]).toContain(`"${entry}"`));
  });
});

describe("GET and DELETE on /mcp", () => {
  it("answer 405 with Allow: POST (the event stream and the end of a session are not offered), after the token check", async () => {
    await withServer(TOKEN, {}, async (port) => {
      const before = rejected("method_not_allowed");
      for (const [method, headers] of [["GET", { ...AUTH, Accept: "text/event-stream" }], ["DELETE", { ...AUTH, "Mcp-Session-Id": "abc" }]] as Array<[string, Headers]>) {
        const r = await send(port, method, "/mcp", headers);
        expect({ method, status: r.status, allow: r.headers.allow, body: r.body }).toEqual({ method, status: 405, allow: "POST", body: '{"error":"Method not allowed"}' });
        expect({ method, status: (await send(port, method, "/mcp")).status }).toEqual({ method, status: 401 }); // the token first
      }
      expect(rejected("method_not_allowed")).toBe(before + 2);
    });
  });

  it("do not widen anything else: HEAD, PUT, PATCH and OPTIONS on /mcp and GET on other paths stay 404, POST stays what it was", async () => {
    await withServer(TOKEN, {}, async (port) => {
      for (const [method, url] of [["HEAD", "/mcp"], ["PUT", "/mcp"], ["PATCH", "/mcp"], ["OPTIONS", "/mcp"], ["GET", "/mcp/"], ["DELETE", "/mcp/x"], ["GET", "/mcp2"], ["DELETE", "/nope"]]) {
        expect({ method, url, status: (await send(port, method, url, AUTH)).status }).toEqual({ method, url, status: 404 });
      }
      expect((await post(port, AUTH)).status).toBe(200);
    });
  });
});

describe("the MCP-Protocol-Version header", () => {
  it("is optional and accepted for each version the server speaks", async () => {
    await withServer(TOKEN, {}, async (port) => {
      expect((await post(port, AUTH)).status).toBe(200);
      for (const v of SUPPORTED) expect({ v, status: (await post(port, { ...AUTH, "MCP-Protocol-Version": v })).status }).toEqual({ v, status: 200 });
    });
  });

  it("is refused with 400, and the versions the server speaks are listed, when it names anything else", async () => {
    await withServer(TOKEN, {}, async (port) => {
      const before = rejected("protocol_version");
      for (const v of ["1999-01-01", "2025-11-26", "2099-01-01", "latest", "", "2025-06-18, 2025-11-25", "constructor", "2025-06-18 x"]) {
        const r = await post(port, { ...AUTH, "MCP-Protocol-Version": v });
        expect({ v, status: r.status }).toEqual({ v, status: 400 });
        expect(JSON.parse(r.body)).toEqual({ error: "Unsupported MCP-Protocol-Version", supported: SUPPORTED });
      }
      // two header lines are one joined value, which is not a version either
      expect((await post(port, { ...AUTH, "MCP-Protocol-Version": ["2025-06-18", "2025-11-25"] })).status).toBe(400);
      expect(rejected("protocol_version")).toBe(before + 9);
    });
  });

  it("is looked at after the token, and before the rate limit (a refused request costs no token of the bucket)", async () => {
    await withServer(TOKEN, { rateLimitPerMinute: 1 }, async (port) => {
      expect((await post(port, { "MCP-Protocol-Version": "1999-01-01" })).status).toBe(401);
      for (let i = 0; i < 3; i++) expect((await post(port, { ...AUTH, "MCP-Protocol-Version": "1999-01-01" })).status).toBe(400);
      expect((await post(port, AUTH)).status).toBe(200); // the one token of the bucket is still there
      expect((await post(port, AUTH)).status).toBe(429);
    });
  });

  it("is not looked at on the other routes", async () => {
    await withServer(TOKEN, {}, async (port) => {
      expect((await send(port, "GET", "/health", { "MCP-Protocol-Version": "1999-01-01" })).status).toBe(200);
      expect((await send(port, "GET", "/metrics", { ...AUTH, "MCP-Protocol-Version": "1999-01-01" })).status).toBe(200);
    });
  });
});
