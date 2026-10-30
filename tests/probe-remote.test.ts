import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import * as cp from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * scripts/probe-remote.js: the read-only check of a running server (a container, a Railway service). It is run as a user runs it,
 * as a process, against the server compiled from these sources and against small stand-ins that behave the way a deployment can.
 * The promise that matters most is that it only reads: a recording stand-in sees every request it sends. The other promises are the
 * verdicts (an open server, a missing contact, a wrong token) and that a token is never printed.
 */
const probe = require("../scripts/probe-remote.js");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-probe-remote-test-"));
const dist = path.join(tmp, "dist");
const children: cp.ChildProcess[] = [];
const stubs: http.Server[] = [];

beforeAll(() => {
  // Compile the project the way `npm run build` does, into a scratch directory that can find the dependencies.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(tmp, "node_modules"), "dir");
  const tsc = cp.spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", dist], { cwd: root, encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`the build for the probe tests failed:\n${tsc.stdout}${tsc.stderr}`);
}, 120_000);
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(stubs.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

interface Ran { status: number | null; stdout: string; stderr: string; json: any }
/** Runs the probe as a process (asynchronously: the stand-ins live in this process and must keep answering). */
function run(args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [path.join(root, "scripts", "probe-remote.js"), ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    let stderr = "";
    const failsafe = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      clearTimeout(failsafe);
      let json: any;
      try { json = JSON.parse(stdout); } catch { /* a plain-text run */ }
      resolve({ status, stdout, stderr, json });
    });
  });
}

/** The real server, compiled from these sources, on a free loopback port, with or without a token. */
async function realServer(token?: string) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(tmp, "data-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", PORT: String(port), HOST: "127.0.0.1", AB_DATA_FILE: path.join(data, "ab.jsonl"), RULES_FILE: path.join(data, "rules.yaml"), EXPERIMENTS_FILE: path.join(data, "experiments.yaml") };
  if (token) env.AUTH_TOKEN = token;
  const child = cp.spawn(process.execPath, [path.join(dist, "src", "index.js")], { env, cwd: tmp, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/ready`); if (r.ok) return `http://127.0.0.1:${port}`; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server did not become ready within 15 s:\n${stderr}`);
}

interface StubOptions {
  token?: string;            // the bearer token it wants; undefined: it answers everything (an open server)
  health?: unknown;
  readyStatus?: number;
  tools?: number;
  toolNames?: string[];      // the names tools/list answers, instead of tool_0 ... tool_N
  serverName?: string;       // serverInfo.name in the initialize answer
  stats?: Record<string, unknown>;
  rpcErrorMessage?: string;  // answer tools/call with a JSON-RPC error carrying this text
}
/** A stand-in server that records every request it receives: [method, path, rpc method, tool]. */
async function stub(options: StubOptions = {}) {
  const seen: string[][] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      let rpc: any;
      try { rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
      seen.push([req.method ?? "", req.url ?? "", rpc?.method ?? "", rpc?.params?.name ?? ""]);
      if (req.url === "/health") return send(200, options.health ?? { status: "ok" });
      if (req.url === "/ready") return send(options.readyStatus ?? 200, { status: options.readyStatus === 503 ? "draining" : "ok" });
      if (req.method === "POST" && req.url === "/mcp") {
        if (options.token && req.headers.authorization !== `Bearer ${options.token}`) return send(401, { error: "Unauthorized" });
        if (rpc?.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
        const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id: rpc.id, result });
        if (rpc.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: options.serverName ?? "increadible", version: "9.9.9" } });
        if (rpc.method === "tools/list") return reply({ tools: (options.toolNames ?? Array.from({ length: options.tools ?? 13 }, (_, i) => `tool_${i}`)).map((name) => ({ name })) });
        if (rpc.method === "tools/call" && rpc.params?.name === "get_api_stats") {
          if (options.rpcErrorMessage) return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: options.rpcErrorMessage } });
          return reply({ content: [{ type: "text", text: JSON.stringify(options.stats ?? { live_apis: ["hackernews"], user_agent_has_contact: true, gates: { hackernews: { status: "candidate" } }, total_calls: 0, live_calls: 0 }) }], isError: false });
        }
        return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
      }
      send(404, { error: "Not found" });
    });
  });
  stubs.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen };
}

const steps = (ran: Ran) => ran.json.results[0].steps as Array<{ name: string; ok: boolean; skipped?: boolean; status?: string; summary: string; problems: string[] }>;
const byName = (ran: Ran, start: string) => steps(ran).find((s) => s.name.startsWith(start))!;
const newToken = () => crypto.randomBytes(16).toString("hex");

describe("against the real server, compiled from these sources", () => {
  it("passes all six checks with the token: 13 tools, the version of this checkout, and the token is not in the report", async () => {
    const token = newToken();
    const url = await realServer(token);
    const ran = await run(["--url", url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: token });
    expect(ran.status).toBe(0);
    expect(steps(ran).map((s) => [s.name.split(":")[0], s.ok])).toEqual([["health", true], ["ready", true], ["auth", true], ["handshake", true], ["tools", true], ["stats", true]]);
    expect(byName(ran, "handshake").summary).toBe(`increadible ${pkg.version}`);
    expect(byName(ran, "tools").summary).toBe("13 tools");
    expect(byName(ran, "auth").summary).toMatch(/HTTP 401/);
    expect(ran.stdout).not.toContain(token);
    expect(ran.stderr).not.toContain(token);
    const plain = await run(["--url", url, "--token-env", "PROBE_TOKEN"], { PROBE_TOKEN: token });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(/PASS 6\/6/);
    expect(plain.stdout + plain.stderr).not.toContain(token);
  }, 60_000);

  it("without a token it still checks health, readiness and the refusal, and skips the rest (and says why)", async () => {
    const url = await realServer(newToken());
    const ran = await run(["--url", url, "--json"]);
    expect(ran.status).toBe(0);
    expect(steps(ran).map((s) => [s.name.split(":")[0], s.skipped === true])).toEqual([["health", false], ["ready", false], ["auth", false], ["handshake", true], ["tools", true], ["stats", true]]);
    const plain = await run(["--url", url]);
    expect(plain.stdout).toMatch(/PASS 3\/3 \(3 skipped: no token given\)/);
    expect(plain.stdout).not.toMatch(/they write data/);
  }, 60_000);

  it("a wrong token fails the handshake and says the token was not accepted, without printing either token", async () => {
    const real = newToken();
    const wrong = newToken();
    const url = await realServer(real);
    const ran = await run(["--url", url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: wrong });
    expect(ran.status).toBe(1);
    expect(byName(ran, "handshake").ok).toBe(false);
    expect(byName(ran, "handshake").problems.join(" ")).toMatch(/token was not accepted \(HTTP 401\)/);
    expect(ran.stdout + ran.stderr).not.toContain(wrong);
    expect(ran.stdout + ran.stderr).not.toContain(real);
  }, 60_000);

  it("fails when the number of tools is not the one expected", async () => {
    const token = newToken();
    const url = await realServer(token);
    const ran = await run(["--url", url, "--token-env", "PROBE_TOKEN", "--expect-tools", "12", "--json"], { PROBE_TOKEN: token });
    expect(ran.status).toBe(1);
    expect(byName(ran, "tools").problems.join(" ")).toMatch(/expected 12 tools, the server lists 13/);
  }, 60_000);

  it("reports a server that runs without a token as OPEN on this machine, and still passes (a development server)", async () => {
    const url = await realServer();
    const ran = await run(["--url", url, "--json"]);
    expect(ran.status).toBe(0);
    expect(byName(ran, "auth").status).toBe("OPEN");
    const plain = await run(["--url", url]);
    expect(plain.stdout).toMatch(/OPEN/);
  }, 60_000);
});

describe("it only reads", () => {
  it("sends nothing but GET /health, GET /ready and POST /mcp with initialize, tools/list or get_api_stats", async () => {
    const token = newToken();
    const s = await stub({ token });
    const ran = await run(["--url", s.url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: token });
    expect(ran.status).toBe(0);
    expect(s.seen.length).toBeGreaterThanOrEqual(6);
    const allowed = new Set(["GET /health", "GET /ready", "POST /mcp initialize", "POST /mcp notifications/initialized", "POST /mcp tools/list", "POST /mcp tools/call get_api_stats"]);
    const sent = s.seen.map(([method, url, rpc, tool]) => [method, url, rpc, tool].filter(Boolean).join(" "));
    expect(sent.filter((line) => !allowed.has(line))).toEqual([]);
  }, 60_000);
});

describe("the verdicts", () => {
  it("fails on a health body that is not ok, and on a server that says it is draining", async () => {
    const bad = await stub({ health: { status: "starting" } });
    const a = await run(["--url", bad.url, "--json"]);
    expect(a.status).toBe(1);
    expect(byName(a, "health").problems.join(" ")).toMatch(/not \{"status":"ok"\}/);
    const draining = await stub({ readyStatus: 503 });
    const b = await run(["--url", draining.url, "--json"]);
    expect(b.status).toBe(1);
    expect(byName(b, "ready").problems.join(" ")).toMatch(/draining/);
  }, 60_000);

  it("fails when Wikipedia is live and the User-Agent has no contact, and passes with a contact", async () => {
    const token = newToken();
    const without = await stub({ token, stats: { live_apis: ["wikipedia"], user_agent_has_contact: false, gates: {} } });
    const a = await run(["--url", without.url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: token });
    expect(a.status).toBe(1);
    expect(byName(a, "stats").problems.join(" ")).toMatch(/wikipedia is live without a contact/);
    const withContact = await stub({ token, stats: { live_apis: ["wikipedia"], user_agent_has_contact: true, gates: {} } });
    const b = await run(["--url", withContact.url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: token });
    expect(b.status).toBe(0);
  }, 60_000);

  it("fails when the server is not this one, and when two tools share a name", async () => {
    const token = newToken();
    const other = await stub({ token, serverName: "some-other-server" });
    const a = await run(["--url", other.url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: token });
    expect(a.status).toBe(1);
    expect(byName(a, "handshake").problems.join(" ")).toMatch(/serverInfo\.name is "some-other-server", expected "increadible"/);
    const names = Array.from({ length: 13 }, (_, i) => `tool_${i}`);
    names[12] = "tool_0";
    const twice = await stub({ token, toolNames: names });
    const b = await run(["--url", twice.url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: token });
    expect(b.status).toBe(1);
    expect(byName(b, "tools").problems.join(" ")).toMatch(/two tools have the same name/);
  }, 60_000);

  it("hides a token the server echoes back in an error", async () => {
    const token = newToken();
    const s = await stub({ token, rpcErrorMessage: `bad request from Bearer ${token}` });
    const ran = await run(["--url", s.url, "--token-env", "PROBE_TOKEN", "--json"], { PROBE_TOKEN: token });
    expect(ran.status).toBe(1);
    expect(byName(ran, "stats").ok).toBe(false);
    expect(ran.stdout + ran.stderr).not.toContain(token);
  }, 60_000);

  it("fails, with exit 1 and not a stack trace, when nothing answers", async () => {
    const port = await freePort(); // closed again at once: nothing listens
    const ran = await run(["--url", `http://127.0.0.1:${port}`, "--timeout-ms", "2000", "--json"]);
    expect(ran.status).toBe(1);
    expect(steps(ran).slice(0, 3).every((s) => !s.ok)).toBe(true);
    expect(ran.stderr).toBe("");
  }, 60_000);

  it("warns before sending anything when the token would cross plain http to another machine", async () => {
    const ran = await run(["--url", "http://192.0.2.1:9", "--token-env", "PROBE_TOKEN", "--timeout-ms", "300"], { PROBE_TOKEN: newToken() });
    expect(ran.stderr).toMatch(/the token is sent over plain http to an address that is not this machine/);
  }, 60_000);

  describe("the judgements", () => {
    it("an unauthenticated POST: 401 is right; 200 is open (a failure anywhere but on this machine); anything else is wrong", () => {
      expect(probe.judgeUnauthenticated(401, "example.com").problems).toEqual([]);
      expect(probe.judgeUnauthenticated(200, "example.com").problems).toHaveLength(1);
      expect(probe.judgeUnauthenticated(200, "increadible-production.up.railway.app").problems.join(" ")).toMatch(/open to anything that can reach it/);
      expect(probe.judgeUnauthenticated(200, "127.0.0.1")).toMatchObject({ problems: [], status: "OPEN" });
      expect(probe.judgeUnauthenticated(200, "localhost").status).toBe("OPEN");
      expect(probe.judgeUnauthenticated(500, "example.com").problems.join(" ")).toMatch(/expected 401, got HTTP 500/);
      expect(probe.judgeUnauthenticated(404, "127.0.0.1").problems).toHaveLength(1);
    });

    it("loopback is this machine only: 127.x.x.x, localhost and ::1", () => {
      for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "[::1]", "::1"]) expect({ host, loopback: probe.isLoopback(host) }).toEqual({ host, loopback: true });
      for (const host of ["10.0.0.1", "192.168.1.5", "example.com", "127.example.com", "1270.0.0.1", "0.0.0.0", "127.0.0.1.example.com", "evil127.0.0.1", "localhost.example.com"]) expect({ host, loopback: probe.isLoopback(host) }).toEqual({ host, loopback: false });
    });

    it("get_api_stats: needs live_apis as a list of names, takes a missing contact field as a note, and counts the gates", () => {
      expect(probe.judgeStats({ live_apis: [], user_agent_has_contact: true, gates: { a: { status: "candidate" }, b: { status: "gated" }, c: { status: "candidate" } } }).summary).toBe("live: none; contact: set; gates: candidate 2, gated 1");
      expect(probe.judgeStats({ live_apis: ["a", 3] }).problems.join(" ")).toMatch(/live_apis is missing or is not a list of names/);
      expect(probe.judgeStats({}).problems.join(" ")).toMatch(/live_apis/);
      const older = probe.judgeStats({ live_apis: ["hackernews"] });
      expect(older.problems).toEqual([]);
      expect(older.notes.join(" ")).toMatch(/predates 2026-10-13/);
      expect(probe.judgeStats({ live_apis: ["hackernews"], user_agent_has_contact: "yes" }).problems.join(" ")).toMatch(/not true or false/);
      expect(probe.judgeStats({ live_apis: ["wikidata", "hackernews"], user_agent_has_contact: false }).problems.join(" ")).toMatch(/wikidata is live without a contact/);
      expect(probe.judgeStats({ live_apis: ["hackernews"], user_agent_has_contact: false }).problems).toEqual([]);
      expect(probe.judgeStats(null).problems).toHaveLength(1);
      expect(probe.judgeStats([]).problems).toHaveLength(1);
    });
  });
});

describe("the command line", () => {
  const cases: Array<[string, string[], RegExp]> = [
    ["no --url", [], /--url is required/],
    ["a URL with a path", ["--url", "http://127.0.0.1:1/mcp"], /address only/],
    ["a URL with a user name", ["--url", "http://user:pw@127.0.0.1:1"], /must not carry a user name or password/],
    ["a URL that is not http", ["--url", "ftp://127.0.0.1"], /must be http or https/],
    ["a token variable that is not set", ["--url", "http://127.0.0.1:1", "--token-env", "NOT_SET_ANYWHERE"], /names a variable that is not set or is empty/],
    ["the token given on the command line", ["--url", "http://127.0.0.1:1", "--token", "secret"], /unknown option --token/],
    ["a bad tool count", ["--url", "http://127.0.0.1:1", "--expect-tools", "many"], /--expect-tools must be a whole number/],
    ["a stray argument", ["--url", "http://127.0.0.1:1", "extra"], /unexpected argument "extra"/],
  ];
  for (const [what, args, message] of cases) {
    it(`exits 2 for ${what}`, async () => {
      const ran = await run(args);
      expect([ran.status, ran.stdout]).toEqual([2, ""]);
      expect(ran.stderr).toMatch(message);
    });
  }
});
