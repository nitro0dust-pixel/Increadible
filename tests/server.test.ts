import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
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
