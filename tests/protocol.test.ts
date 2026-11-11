import * as http from "http";
import * as net from "net";
import * as index from "../src/index";
import * as server from "../src/server";

/**
 * JSON-RPC and HTTP conformance (audit findings P-1 to P-6). Found by sending hostile and unusual requests to the built server:
 * jsonrpc "1.0" and an object-valued id were accepted and echoed; initialize echoed any protocolVersion; a notification (no id)
 * to ping, tools/list or initialize got a reply, which JSON-RPC forbids; HEAD /health and /health?x=1 answered 401 when a token
 * was set; and "bearer" (lower case) was refused although the scheme name is case-insensitive.
 */

let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

describe("a message must be a JSON-RPC 2.0 request", () => {
  const invalid = async (msg: unknown) => {
    const r: any = await server.handleMessage(msg as any);
    return r?.error?.code === -32600 ? r : null;
  };

  it.each([
    ["no jsonrpc", { id: 1, method: "ping" }],
    ["jsonrpc 1.0", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["jsonrpc as a number", { jsonrpc: 2, id: 1, method: "ping" }],
    ["no method", { jsonrpc: "2.0", id: 1 }],
    ["a numeric method", { jsonrpc: "2.0", id: 1, method: 5 }],
  ])("refuses %s with Invalid Request and keeps the id", async (_name, msg) => {
    expect(await invalid(msg)).toMatchObject({ id: 1, error: { code: -32600, message: "Invalid Request" } });
  });

  it.each([
    ["an object", { a: 1 }],
    ["a boolean", true],
    ["an array", [1]],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("refuses an id that is %s, and answers with id null (never echoes it)", async (_name, id) => {
    const r: any = await server.handleMessage({ jsonrpc: "2.0", id, method: "ping" } as any);
    expect(r).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
  });

  it("refuses a batch, null, a number and a string", async () => {
    for (const m of [[], [{ jsonrpc: "2.0", id: 1, method: "ping" }], null, 42, "ping"]) {
      expect(await invalid(m)).toMatchObject({ id: null });
    }
  });

  it("accepts a string, a number and a null id and echoes it", async () => {
    for (const id of ["abc", "", 0, 7, -3, 1.5, null]) {
      expect(await server.handleMessage({ jsonrpc: "2.0", id, method: "ping" } as any)).toEqual({ jsonrpc: "2.0", id, result: {} });
    }
  });
});

describe("a notification is carried out and never answered", () => {
  it.each(["ping", "tools/list", "initialize", "notifications/initialized", "no/such/method"])("%s without an id gets no reply", async (method) => {
    expect(await server.handleMessage({ jsonrpc: "2.0", method } as any)).toBeNull();
  });

  it("a tool call sent as a notification still runs (its effect happens), and gets no reply", async () => {
    const before = server.metrics.tool_calls.get_api_stats ?? 0;
    expect(await server.handleMessage({ jsonrpc: "2.0", method: "tools/call", params: { name: "get_api_stats", arguments: {} } })).toBeNull();
    expect(server.metrics.tool_calls.get_api_stats).toBe(before + 1);
  });

  it("an unknown method sent as a notification is not counted as a protocol error", async () => {
    const before = server.metrics.rpc_errors;
    await server.handleMessage({ jsonrpc: "2.0", method: "notifications/whatever" });
    expect(server.metrics.rpc_errors).toBe(before);
  });

  it("the same unknown method WITH an id is answered and counted", async () => {
    const before = server.metrics.rpc_errors;
    const r: any = await server.handleMessage({ jsonrpc: "2.0", id: 9, method: "nope" });
    expect(r.error.code).toBe(-32601);
    expect(server.metrics.rpc_errors).toBe(before + 1);
  });
});

describe("initialize", () => {
  const version = async (protocolVersion: unknown) =>
    ((await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } })) as any).result.protocolVersion;

  it("echoes a protocol version that it speaks, one of the four it lists", async () => {
    expect(server.SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
    for (const v of server.SUPPORTED_PROTOCOL_VERSIONS) expect(await version(v)).toBe(v);
  });

  it("answers the latest version it speaks to one it does not (a date from the future, or the past), instead of claiming to speak it", async () => {
    for (const v of ["2099-01-01", "1999-01-01", "2025-11-26", "2024-11-04"]) expect(await version(v)).toBe("2025-11-25");
  });

  it("answers the latest version it speaks to anything that is not a version at all", async () => {
    for (const v of ["latest", "", {}, 20241105, null, ["2025-03-26"], "2025-3-26", "2025-03-26T00:00:00Z", "x".repeat(5000), "2025-03-26\n", " 2025-03-26", "2025-06-18 "]) {
      expect(await version(v)).toBe("2025-11-25");
    }
  });

  it("answers the latest version it speaks when the client sends no version", async () => {
    const r: any = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(r.result.protocolVersion).toBe("2025-11-25");
    expect(server.LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
  });

  it("negotiates by exact match on its list, not by prototype or substring: inherited names are not versions", async () => {
    for (const v of ["constructor", "__proto__", "length", "toString", "2025-06-18,2025-11-25"]) expect(await version(v)).toBe("2025-11-25");
  });
});

describe("HTTP routes and the bearer token", () => {
  const TOKEN = "s3cr3t-token";
  const listen = (srv: http.Server) =>
    new Promise<number>((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));
  const send = (port: number, method: string, url: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: url, headers, agent: false }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const withServer = async (token: string | undefined, fn: (port: number) => Promise<void>) => {
    const srv = index.createHttpServer(token);
    const port = await listen(srv);
    try {
      await fn(port);
    } finally {
      await new Promise((r) => srv.close(r));
      srv.closeAllConnections();
    }
  };

  it("health and readiness answer GET and HEAD, with or without a query string, without a token", async () => {
    await withServer(TOKEN, async (port) => {
      for (const method of ["GET", "HEAD"]) {
        for (const url of ["/health", "/health?probe=1", "/ready", "/ready?x=y&z"]) {
          const r = await send(port, method, url);
          expect({ method, url, status: r.status }).toEqual({ method, url, status: 200 });
        }
      }
      expect((await send(port, "GET", "/health?probe=1")).body).toBe('{"status":"ok"}');
      expect((await send(port, "HEAD", "/health")).body).toBe(""); // a HEAD reply has no body
    });
  });

  it("/ready still answers 503 while draining, for GET and HEAD with a query string", async () => {
    const srv = index.createHttpServer(TOKEN);
    const port = await listen(srv);
    try {
      srv.setDraining(true);
      for (const method of ["GET", "HEAD"]) expect((await send(port, method, "/ready?x=1")).status).toBe(503);
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });

  it("the route does not widen what is open: similar paths still need the token", async () => {
    await withServer(TOKEN, async (port) => {
      for (const url of ["/health/", "/healthz", "/health/x", "//health", "/Health", "/ready/", "/mcp", "/metrics", "/health%3Fx"]) {
        const r = await send(port, "GET", url);
        expect({ url, status: r.status }).toEqual({ url, status: 401 });
      }
      expect((await send(port, "POST", "/health?x=1", {}, "{}")).status).toBe(401);
      expect((await send(port, "HEAD", "/mcp")).status).toBe(401);
      expect((await send(port, "GET", "/metrics?x=1")).status).toBe(401);
    });
  });

  it("/mcp and /metrics ignore a query string once the token is right", async () => {
    await withServer(TOKEN, async (port) => {
      const auth = { Authorization: `Bearer ${TOKEN}` };
      expect((await send(port, "POST", "/mcp?session=1", auth, ping)).status).toBe(200);
      expect((await send(port, "GET", "/metrics?x=1", auth)).status).toBe(200);
      expect((await send(port, "HEAD", "/mcp", auth)).status).toBe(404); // HEAD is not POST
      expect((await send(port, "GET", "/mcp", auth)).status).toBe(405); // the optional event stream is not offered (tests/http-origin.test.ts)
    });
  });

  it("the scheme name is case-insensitive, the token is not", async () => {
    await withServer(TOKEN, async (port) => {
      for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) {
        const r = await send(port, "POST", "/mcp", { Authorization: `${scheme} ${TOKEN}` }, ping);
        expect({ scheme, status: r.status }).toEqual({ scheme, status: 200 });
      }
      // (A trailing space is not tested: an HTTP parser drops whitespace around a header value, so it never reaches the server.)
      for (const header of [`Bearer ${TOKEN.toUpperCase()}`, `Bearer  ${TOKEN}`, `Bearer\t${TOKEN}`, `Bearer`, `Bearer `, TOKEN, `Basic ${TOKEN}`, `Token ${TOKEN}`, `Bearer${TOKEN}`, ""]) {
        const r = await send(port, "POST", "/mcp", header === "" ? {} : { Authorization: header }, ping);
        expect({ header, status: r.status }).toEqual({ header, status: 401 });
      }
    });
  });

  it("without a token configured nothing is checked, as before", async () => {
    await withServer(undefined, async (port) => {
      expect((await send(port, "POST", "/mcp?x=1", {}, ping)).status).toBe(200);
    });
  });
});
