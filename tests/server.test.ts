import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";

type ServerModule = typeof import("../src/server");
type IndexModule = typeof import("../src/index");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-srv-"));
const saved = { r: process.env.RULES_FILE, e: process.env.EXPERIMENTS_FILE };
let server: ServerModule;
let index: IndexModule;

beforeAll(() => {
  process.env.RULES_FILE = path.join(tmpDir, "rules.yaml");
  process.env.EXPERIMENTS_FILE = path.join(tmpDir, "experiments.yaml");
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.isolateModules(() => {
    server = require("../src/server");
    index = require("../src/index");
  });
});

afterAll(() => {
  jest.restoreAllMocks();
  for (const [k, v] of [["RULES_FILE", saved.r], ["EXPERIMENTS_FILE", saved.e]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, any> = {}, id = 1) =>
  server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("JSON-RPC handler", () => {
  it("answers initialize with capabilities and server info", async () => {
    const r: any = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.serverInfo.name).toBe("increadible");
  });

  it("lists all 13 tools with unique names and object input schemas", async () => {
    const r: any = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names: string[] = r.result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(13);
    expect(new Set(names).size).toBe(13);
    expect(r.result.tools.every((t: any) => t.inputSchema.type === "object" && t.description)).toBe(true);
  });

  it("returns no reply for notifications and answers ping", async () => {
    expect(await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" })).toMatchObject({ result: {} });
  });

  it("rejects malformed requests and unknown methods/tools with JSON-RPC errors", async () => {
    expect((await server.handleMessage({} as any))?.error?.code).toBe(-32600);
    expect((await server.handleMessage({ jsonrpc: "2.0", id: 4, method: "nope" }))?.error?.code).toBe(-32601);
    expect((await call("no_such_tool"))?.error?.code).toBe(-32602);
  });

  it("dispatches tool calls to the right module and wraps output as MCP content", async () => {
    const r: any = await call("apply_routing_rules", { task_type: "qa", task_complexity: "low" });
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text).provider).toBe("claude-haiku");
    const g: any = await call("discover_apis", { query: "weather" });
    expect(JSON.parse(g.result.content[0].text)).toHaveLength(2);
  });

  it("marks tool-level failures with isError instead of crashing", async () => {
    const r: any = await call("record_metric", { experiment_id: "ghost", variant_id: "A", metrics: { q: 1 } });
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0].text).error).toContain("Experiment not found");
    const bad: any = await call("update_rules", { rules: "not-an-array" });
    expect(bad.result.isError).toBe(true);
  });

  it("runs a full experiment through the tools", async () => {
    await call("create_experiment", {
      id: "tool-exp", name: "n", hypothesis: "h", metrics: [{ id: "q", name: "q", type: "c", aggregation: "mean" }],
      variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
    });
    const assigned: any = await call("assign_variant", { experiment_id: "tool-exp" });
    expect(["A", "B"]).toContain(JSON.parse(assigned.result.content[0].text).variant_id);
    const bad: any = await call("record_metric", { experiment_id: "tool-exp", variant_id: "A", metrics: { q: "NaN" } });
    expect(bad.result.isError).toBe(true);
  });
});

describe("A/B persistence through the server entry point", () => {
  it("survives a server restart when AB_DATA_FILE is set", async () => {
    const file = path.join(tmpDir, "server-ab.jsonl");
    process.env.AB_DATA_FILE = file;
    const boot = () => {
      let mod: ServerModule;
      jest.isolateModules(() => {
        mod = require("../src/server");
      });
      return mod!;
    };
    const run = async (m: ServerModule, name: string, args: Record<string, any>) => {
      const r: any = await m.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return JSON.parse(r.result.content[0].text);
    };
    try {
      const first = boot();
      await run(first, "create_experiment", {
        id: "persisted", name: "n", hypothesis: "h", metrics: [{ id: "q", name: "q", type: "c", aggregation: "mean" }],
        variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
      });
      for (let i = 0; i < 60; i++) {
        await run(first, "record_metric", { experiment_id: "persisted", variant_id: "A", metrics: { q: 10 + (i % 3) } });
        await run(first, "record_metric", { experiment_id: "persisted", variant_id: "B", metrics: { q: 5 + (i % 3) } });
      }
      const before = await run(first, "get_experiment_results", { experiment_id: "persisted" });
      expect(before.winner).toBe("A");

      const second = boot(); // "restart": fresh module state, same file
      expect(await run(second, "get_experiment_results", { experiment_id: "persisted" })).toEqual(before);
      expect((await run(second, "create_experiment", { id: "persisted", name: "n", hypothesis: "h", metrics: [], variants: [] })).error)
        .toBeDefined();
    } finally {
      delete process.env.AB_DATA_FILE;
    }
  });
});

describe("stdio transport", () => {
  it("replies in order, ignores notifications, reports parse errors, and writes only JSON to stdout", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c) => chunks.push(c.toString()));
    const done = index.serveStdio(input, output);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write("{not json\n\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    input.end();
    await done;
    const lines = chunks.join("").split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(3);
    expect(parsed[0].id).toBe(1);
    expect(parsed[1].error.code).toBe(-32700);
    expect(parsed[2].id).toBe(2);
  });
});

describe("HTTP transport", () => {
  const start = (token?: string) =>
    new Promise<{ srv: http.Server; port: number }>((resolve) => {
      const srv = index.createHttpServer(token);
      srv.listen(0, "127.0.0.1", () => resolve({ srv, port: (srv.address() as any).port }));
    });

  const request = (port: number, method: string, url: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      });
      req.on("error", reject);
      req.end(body);
    });

  it("serves health, ready, metrics, and JSON-RPC over POST /mcp", async () => {
    const { srv, port } = await start();
    try {
      expect((await request(port, "GET", "/health")).status).toBe(200);
      expect((await request(port, "GET", "/ready")).status).toBe(200);
      const list = await request(port, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      expect(JSON.parse(list.body).result.tools).toHaveLength(13);
      expect((await request(port, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
      expect((await request(port, "POST", "/mcp", "{bad")).status).toBe(400);
      expect((await request(port, "GET", "/nope")).status).toBe(404);
      await request(port, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_api_stats", arguments: {} } }));
      const metrics = await request(port, "GET", "/metrics");
      expect(metrics.body).toContain('increadible_tool_calls_total{tool="get_api_stats"}');
      expect(metrics.body).toContain("increadible_uptime_seconds");
    } finally {
      srv.close();
    }
  });

  it("requires the bearer token for everything except health probes", async () => {
    const { srv, port } = await start("s3cret");
    try {
      expect((await request(port, "GET", "/health")).status).toBe(200);
      expect((await request(port, "GET", "/metrics")).status).toBe(401);
      expect((await request(port, "POST", "/mcp", "{}", { Authorization: "Bearer wrong" })).status).toBe(401);
      const ok = await request(port, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { Authorization: "Bearer s3cret" });
      expect(ok.status).toBe(200);
    } finally {
      srv.close();
    }
  });

  it("rejects oversized request bodies", async () => {
    const { srv, port } = await start();
    try {
      const res = await request(port, "POST", "/mcp", "x".repeat(1_200_000)).catch((e) => ({ status: e.code === "ECONNRESET" || e.code === "EPIPE" ? 413 : 0, body: "" }));
      expect(res.status).toBe(413);
    } finally {
      srv.close();
    }
  });
});

describe("a failing tool or handler must not end the process", () => {
  it("discover_apis rejects a non-string query as a tool error (it used to throw and kill the server)", async () => {
    for (const query of [123, {}, [], true]) {
      const reply: any = await call("discover_apis", { query });
      expect(reply.result.isError).toBe(true);
      expect(JSON.parse(reply.result.content[0].text).error).toMatch(/query must be a string/);
    }
    expect(((await call("discover_apis", {})) as any).result.isError).toBe(false);
    expect(((await call("discover_apis", { query: null })) as any).result.isError).toBe(false);
  });

  it("a tool module that throws is reported as a tool error, not thrown from handleMessage", async () => {
    const gateway = "../features/09-api-gateway/src/mcp-server";
    await jest.isolateModulesAsync(async () => {
      jest.doMock(gateway, () => ({
        ...jest.requireActual(gateway),
        processToolCall: async () => {
          throw new Error("boom");
        },
      }));
      try {
        const isolated: ServerModule = require("../src/server");
        const reply: any = await isolated.handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_api_stats", arguments: {} } });
        expect(reply.id).toBe(7);
        expect(reply.result.isError).toBe(true);
        expect(JSON.parse(reply.result.content[0].text).error).toBe("boom");
        expect(isolated.metrics.tool_errors.get_api_stats).toBe(1);
      } finally {
        jest.dontMock(gateway);
      }
    });
  });

  it("stdio: a message that makes the handler throw gets an Internal error reply and the session carries on", async () => {
    const spy = jest.spyOn(server, "handleMessage").mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on("data", (c) => chunks.push(c.toString()));
      const done = index.serveStdio(input, output);
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
      input.end();
      await done;
      const replies = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(replies).toHaveLength(2);
      expect(replies[0]).toMatchObject({ id: 1, error: { code: -32603, message: "Internal error" } });
      expect(replies[1]).toMatchObject({ id: 2, result: {} });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("HTTP hardening", () => {
  const listen = (srv: http.Server) =>
    new Promise<number>((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));

  const send = (port: number, method: string, url: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: url, headers, agent: false }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

  it("an unexpected handler failure over HTTP is a 500 JSON-RPC error and the server keeps serving", async () => {
    const spy = jest.spyOn(server, "handleMessage").mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const srv = index.createHttpServer();
    const port = await listen(srv);
    try {
      const failed = await send(port, "POST", "/mcp", ping);
      expect(failed.status).toBe(500);
      expect(JSON.parse(failed.body)).toMatchObject({ id: 1, error: { code: -32603, message: "Internal error" } });
      expect(failed.body).not.toContain("boom"); // the cause is logged, not returned
      expect((await send(port, "POST", "/mcp", ping)).status).toBe(200);
    } finally {
      spy.mockRestore();
      srv.close();
    }
  });

  it("answers 503 on /ready while draining and keeps /health and /mcp working", async () => {
    const srv = index.createHttpServer();
    const port = await listen(srv);
    try {
      expect((await send(port, "GET", "/ready")).status).toBe(200);
      srv.setDraining(true);
      const ready = await send(port, "GET", "/ready");
      expect(ready.status).toBe(503);
      expect(JSON.parse(ready.body)).toEqual({ status: "draining" });
      expect((await send(port, "GET", "/health")).status).toBe(200);
      expect((await send(port, "POST", "/mcp", ping)).status).toBe(200);
      srv.setDraining(false);
      expect((await send(port, "GET", "/ready")).status).toBe(200);
    } finally {
      srv.close();
    }
  });

  it("closes a connection that never finishes its headers or its body (explicit timeouts, not Node's 60 s and 300 s)", async () => {
    const srv = index.createHttpServer(undefined, { headersTimeoutMs: 300, requestTimeoutMs: 600 });
    const port = await listen(srv);
    const closedAfter = (payload: string) =>
      new Promise<number>((resolve) => {
        const t0 = Date.now();
        const s = net.connect(port, "127.0.0.1");
        s.on("error", () => undefined);
        s.on("close", () => resolve(Date.now() - t0));
        s.resume(); // read the 408: a socket with unread data never emits 'close'
        s.write(payload);
        setTimeout(() => s.destroy(), 4000).unref(); // a regression fails the assertion below instead of hanging
      });
    try {
      expect(await closedAfter("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Le")).toBeLessThan(2500);
      expect(await closedAfter('POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":')).toBeLessThan(2500);
      expect((await send(port, "POST", "/mcp", ping)).status).toBe(200); // a normal request is unaffected
    } finally {
      srv.close();
    }
  }, 10_000);

  it("limits POST /mcp when RATE_LIMIT_PER_MINUTE is set, tells the client when to retry, and counts it", async () => {
    const srv = index.createHttpServer(undefined, { rateLimitPerMinute: 2 });
    const port = await listen(srv);
    try {
      expect((await send(port, "POST", "/mcp", ping)).status).toBe(200);
      expect((await send(port, "POST", "/mcp", ping)).status).toBe(200);
      const limited = await send(port, "POST", "/mcp", ping);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect((await send(port, "GET", "/health")).status).toBe(200); // probes are never limited
      expect((await send(port, "GET", "/metrics")).body).toMatch(/increadible_http_rejected_total\{reason="rate_limited"\} [1-9]/);
    } finally {
      srv.close();
    }
  });

  it("does not limit anything by default", async () => {
    const srv = index.createHttpServer();
    const port = await listen(srv);
    try {
      for (let i = 0; i < 25; i++) expect((await send(port, "POST", "/mcp", ping)).status).toBe(200);
    } finally {
      srv.close();
    }
  });

  it("counts an oversized body once, not once per chunk", async () => {
    const before = server.metrics.http_rejected.payload_too_large ?? 0;
    const srv = index.createHttpServer();
    const port = await listen(srv);
    try {
      await send(port, "POST", "/mcp", "x".repeat(1_500_000)).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      expect((server.metrics.http_rejected.payload_too_large ?? 0) - before).toBe(1);
    } finally {
      srv.close();
    }
  });
});

describe("rate limiter", () => {
  it("allows a burst, refuses with a retry delay, and refills over time", () => {
    let now = 0;
    const take = index.createRateLimiter(60, () => now); // 60 per minute = 1 per second
    for (let i = 0; i < 60; i++) expect(take()).toBe(0);
    expect(take()).toBe(1);
    now += 999;
    expect(take()).toBeGreaterThanOrEqual(1);
    now += 1;
    expect(take()).toBe(0);
    now += 10 * 60_000;
    for (let i = 0; i < 60; i++) expect(take()).toBe(0); // refilled, but never above the burst size
    expect(take()).toBeGreaterThanOrEqual(1);
  });

  it("is off for 0, negative and NaN", () => {
    for (const off of [0, -5, NaN]) {
      const take = index.createRateLimiter(off);
      for (let i = 0; i < 1000; i++) expect(take()).toBe(0);
    }
  });
});

describe("graceful shutdown", () => {
  const listen = (srv: http.Server) =>
    new Promise<number>((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));
  const get = (port: number, url: string) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: url, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      }).on("error", reject);
    });
  const exited = () => {
    let resolve!: (code: number) => void;
    const promise = new Promise<number>((r) => (resolve = r));
    return { promise, exit: jest.fn((code: number) => resolve(code)) };
  };

  it("exits 0 promptly when nothing is in flight, and ignores a second signal", async () => {
    const srv = index.createHttpServer();
    await listen(srv);
    const done = exited();
    const shutdown = index.installShutdown(srv, { drainMs: 0, timeoutMs: 2000, exit: done.exit, log: () => undefined });
    shutdown("SIGTERM");
    shutdown("SIGINT");
    expect(await done.promise).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(done.exit).toHaveBeenCalledTimes(1);
  });

  it("keeps serving while draining (with /ready 503) and only then closes", async () => {
    const srv = index.createHttpServer();
    const port = await listen(srv);
    const done = exited();
    const t0 = Date.now();
    index.installShutdown(srv, { drainMs: 400, timeoutMs: 2000, exit: done.exit, log: () => undefined })("SIGTERM");
    expect(await get(port, "/ready")).toBe(503);
    expect(await get(port, "/health")).toBe(200);
    expect(done.exit).not.toHaveBeenCalled();
    expect(await done.promise).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  it("cuts a stalled request at the deadline and exits 1 (it used to wait for the orchestrator's SIGKILL)", async () => {
    const srv = index.createHttpServer(); // default 10 s / 30 s receive timeouts: far beyond the deadline below
    const port = await listen(srv);
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write('POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":');
    await new Promise((r) => setTimeout(r, 100));
    const done = exited();
    const logs: string[] = [];
    const t0 = Date.now();
    index.installShutdown(srv, { drainMs: 0, timeoutMs: 300, exit: done.exit, log: (m) => logs.push(m) })("SIGTERM");
    expect(await done.promise).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2000);
    await closed;
    expect(logs.join("\n")).toMatch(/deadline passed/);
  }, 8000);
});

describe("refusing to serve an open API beyond this machine", () => {
  const open = /Refusing to listen on/;
  it.each([
    ["0.0.0.0", undefined],
    ["0.0.0.0", ""],
    ["0.0.0.0", "   "],
    ["::", undefined],
    ["10.0.0.5", undefined],
    ["127.evil.example", undefined], // looks loopback-ish, is not
  ])("refuses HOST=%s with AUTH_TOKEN=%j", (host, token) => {
    expect(index.exposureProblem(host, token as string | undefined, undefined)).toMatch(open);
  });

  it.each([
    ["0.0.0.0", "a-token", undefined],
    ["127.0.0.1", undefined, undefined],
    ["127.1.2.3", undefined, undefined],
    ["localhost", undefined, undefined],
    ["::1", undefined, undefined],
    ["[::1]", undefined, undefined],
    ["0.0.0.0", undefined, "1"],
    ["0.0.0.0", undefined, "true"],
  ])("allows HOST=%s with AUTH_TOKEN=%j ALLOW_UNAUTHENTICATED=%j", (host, token, allow) => {
    expect(index.exposureProblem(host, token as string | undefined, allow as string | undefined)).toBeNull();
  });

  it("does not treat ALLOW_UNAUTHENTICATED=0 or an empty value as consent", () => {
    expect(index.exposureProblem("0.0.0.0", undefined, "0")).toMatch(open);
    expect(index.exposureProblem("0.0.0.0", undefined, "")).toMatch(open);
  });
});

describe("integer settings from the environment", () => {
  const NAME = "INCREADIBLE_TEST_INT";
  afterEach(() => {
    delete process.env[NAME];
  });

  it("uses a non-negative integer, including 0 (which switches a timeout or the limiter off)", () => {
    process.env[NAME] = "42";
    expect(index.envInt(NAME, 7)).toBe(42);
    process.env[NAME] = "0";
    expect(index.envInt(NAME, 7)).toBe(0);
  });

  it("falls back for unset or blank values without complaining", () => {
    const err = jest.spyOn(console, "error");
    err.mockClear();
    delete process.env[NAME];
    expect(index.envInt(NAME, 7)).toBe(7);
    process.env[NAME] = "   ";
    expect(index.envInt(NAME, 7)).toBe(7);
    expect(err).not.toHaveBeenCalled();
  });

  it("falls back and says so for negative, fractional and non-numeric values", () => {
    const err = jest.spyOn(console, "error");
    for (const bad of ["-1", "1.5", "abc", "10s", "NaN"]) {
      err.mockClear();
      process.env[NAME] = bad;
      expect(index.envInt(NAME, 7)).toBe(7);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(`Ignoring ${NAME}="${bad}"`));
    }
  });
});
