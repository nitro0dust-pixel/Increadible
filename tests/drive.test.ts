import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * The request drivers (scripts/drive-stdio.js, drive-http.js, drive-probe.js, drive-bundle.js; docs/DRIVERS.md), run as a user runs
 * them: as separate processes, against the server compiled from these sources and against a real bundle built by scripts/mcpb.js.
 * The tests that matter most are the ones that break something on purpose and expect the driver to say so: a driver that cannot fail
 * proves nothing. The same breakages were also made in the drivers themselves (the list is in docs/DRIVERS.md, section "How these
 * drivers were tested").
 */
const mcpb = require("../scripts/mcpb.js");
const bundleDriver = require("../scripts/drive-bundle.js");
const probe = require("../scripts/drive-probe.js");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-drive-test-"));
const server = path.join(tmp, "server"); // a root the drivers can use: package.json, dist/, node_modules
const children: cp.ChildProcess[] = [];

beforeAll(() => {
  fs.mkdirSync(server);
  fs.symlinkSync(path.join(root, "node_modules"), path.join(server, "node_modules"), "dir");
  fs.copyFileSync(path.join(root, "package.json"), path.join(server, "package.json"));
  const tsc = cp.spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(server, "dist")], { cwd: root, encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`the build for the driver tests failed:\n${tsc.stdout}${tsc.stderr}`);
}, 120_000);
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Ran { status: number | null; stdout: string; stderr: string; json: any }
/** Runs a driver as a process, with a failsafe, and parses its --json output when it printed one. */
function drive(script: string, args: string[], env: Record<string, string> = {}): Ran {
  const r = cp.spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], { encoding: "utf8", timeout: 90_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  let json: any;
  try { json = JSON.parse(r.stdout); } catch { /* not a --json run */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
/** A driver that keeps running while the test does something to it (signals it). */
function driveAsync(script: string, args: string[], env: Record<string, string> = {}) {
  const child = cp.spawn(process.execPath, [path.join(root, "scripts", script), ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d));
  child.stderr?.on("data", (d) => (stderr += d));
  const exit = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, exit };
}
/** A directory shaped like a built checkout (package.json, dist/src/<files>) holding small stand-ins for the server, to make the drivers meet behaviour the real one never shows. */
function fakeRoot(name: string, files: Record<string, string>) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "dist", "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  for (const [file, code] of Object.entries(files)) fs.writeFileSync(path.join(dir, "dist", "src", file), code);
  return dir;
}
const pending = (dir: string) => fs.readdirSync(dir).filter((f) => f.startsWith("increadible-drive-"));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (what: string, test: () => boolean, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!test()) {
    if (Date.now() > until) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const privateTmp = () => fs.mkdtempSync(path.join(tmp, "private-tmp-"));

/** Stand-in for dist/src/index.js: answers /ready, /health, /metrics and /mcp, notes its pid in $TMPDIR, can delay answers (FAKE_DELAY) or echo the bearer token in an error (FAKE_ECHO). */
const FAKE_HTTP = `
  const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path");
  fs.writeFileSync(path.join(process.env.TMPDIR || os.tmpdir(), "fake-http.pid"), String(process.pid));
  if (process.env.FAKE_STUBBORN) { process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); }
  http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/ready") { res.end("{}"); return; }
      if (req.url === "/health") { res.setHeader("Content-Type", "application/json"); res.end('{"status":"ok"}'); return; }
      if (req.url === "/metrics") { res.end('increadible_tool_calls_total{tool="x"} 1\\n'); return; }
      if (req.method === "POST" && req.url === "/mcp") {
        if (!(req.headers.authorization || "").startsWith("Bearer ")) { res.statusCode = 401; res.end('{"error":"Unauthorized"}'); return; }
        const m = JSON.parse(body);
        if (m.id === undefined) { res.statusCode = 202; res.end(); return; }
        const answer = () => {
          res.setHeader("Content-Type", "application/json");
          if (m.method === "initialize") res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "x", capabilities: { tools: {} }, serverInfo: { name: "increadible", version: "1.2.3" } } }));
          else if (process.env.FAKE_ECHO) res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "cannot use " + req.headers.authorization } }));
          else res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
        };
        setTimeout(answer, m.method === "initialize" ? 0 : Number(process.env.FAKE_DELAY || 0));
        return;
      }
      res.statusCode = 404; res.end("{}");
    });
  }).listen(Number(process.env.PORT), "127.0.0.1");`;

/** Stand-in for dist/src/main.js: notes its pid in $TMPDIR, answers every request (after FAKE_DELAY ms), and can put FAKE_SECRET and an escape sequence into a tool error. */
const FAKE_STDIO = `
  const fs = require("fs"); const os = require("os"); const path = require("path");
  fs.writeFileSync(path.join(process.env.TMPDIR || os.tmpdir(), "fake-stdio.pid"), String(process.pid));
  process.stdin.setEncoding("utf8"); let buf = "";
  process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) continue;
    setTimeout(() => {
      let result = {};
      if (m.method === "initialize") result = { protocolVersion: "x", capabilities: { tools: {} }, serverInfo: { name: "increadible", version: "1.2.3" } };
      if (m.method === "tools/call") result = { isError: true, content: [{ type: "text", text: "failed with " + (process.env.FAKE_SECRET || "nothing") + " \\u001b[31mred\\u001b[0m" }] };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    }, m.method === "initialize" ? 0 : Number(process.env.FAKE_DELAY || 0)); } });
  process.stdin.on("end", () => process.exit(0));`;

const names = (ran: Ran) => ran.json.results[0].steps.map((s: any) => s.name);
const failing = (ran: Ran) => ran.json.results[0].steps.filter((s: any) => !s.ok).map((s: any) => s.name);

/** Changes one compiled file of the test server in place for the duration of fn, so a driver can be shown to notice. */
function broken<T>(file: string, from: string, to: string, fn: () => T): T {
  const target = path.join(server, "dist", "src", file);
  const original = fs.readFileSync(target, "utf8");
  expect({ file, occurrences: original.split(from).length - 1 }).toEqual({ file, occurrences: 1 }); // the breakage must hit exactly one place
  fs.writeFileSync(target, original.replace(from, to));
  try { return fn(); } finally { fs.writeFileSync(target, original); }
}

const writeScenario = (name: string, scenario: object) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(scenario));
  return file;
};

describe("scripts/drive-stdio.js", () => {
  it("runs the basic scenario against the server the way Claude Desktop starts it, and ends it cleanly", () => {
    const ran = drive("drive-stdio.js", ["--root", server, "--json"]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.json.ok).toBe(true);
    expect(ran.json.server).toMatchObject({ name: "increadible", version: pkg.version });
    expect(names(ran)).toEqual(expect.arrayContaining(["handshake", "ping", "A/B: record a measurement", "gateway: a call answers sample data", "shutdown", "stdout is protocol only"]));
    expect(failing(ran)).toEqual([]);
    expect(ran.json.results[0].steps.length).toBe(19);
  });

  it("prints a plain report with the verdict, and removes its data directory afterwards", () => {
    const ran = drive("drive-stdio.js", ["--root", server]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("PASS 19/19");
    const dir = /data directory: (\S+) \(removed afterwards\)/.exec(ran.stdout)![1];
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("writes into the directory it is given and can run twice into it (each run names its experiment differently)", () => {
    const dir = path.join(tmp, "stdio-data");
    expect(drive("drive-stdio.js", ["--root", server, "--data-dir", dir, "--json"]).status).toBe(0);
    expect(drive("drive-stdio.js", ["--root", server, "--data-dir", dir, "--json"]).status).toBe(0);
    const lines = fs.readFileSync(path.join(dir, "ab-data.jsonl"), "utf8");
    expect(lines.match(/"id":"drive-/g)?.length).toBe(2);
  });

  it("never prints a secret it was given, in the report, as JSON or on stderr", () => {
    const value = "zz-very-secret-value-9141";
    for (const extra of [[], ["--json"]]) {
      const ran = drive("drive-stdio.js", ["--root", server, "--env", `GATEWAY_KEY_ALPHA=${value}`, ...extra]);
      expect(ran.status).toBe(0);
      expect(ran.stdout + ran.stderr).not.toContain(value);
      expect(ran.stdout).toContain("GATEWAY_KEY_ALPHA (set)");
    }
  });

  it("fails a step whose answer is not the expected one, says what it expected and what it got, and still shuts the server down", () => {
    const scenario = writeScenario("wrong.json", { name: "wrong", steps: [{ name: "provider", tool: "apply_routing_rules", arguments: { task_type: "code" }, expect: { json: { provider: "no-such-provider" } } }] });
    const ran = drive("drive-stdio.js", ["--root", server, "--scenario", scenario, "--json"]);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["provider"]);
    expect(ran.json.results[0].steps[1].problems[0]).toMatch(/json\.provider: expected "no-such-provider", got "/);
    expect(ran.json.results[0].steps.find((s: any) => s.name === "shutdown").ok).toBe(true);
    const text = drive("drive-stdio.js", ["--root", server, "--scenario", scenario]);
    expect(text.stdout).toMatch(/provider\s+FAIL/);
    expect(text.stdout).toContain("FAIL 1 of 4 steps");
  });

  it("exits 2 with a message, not a stack, when it cannot run: unknown scenario, unknown option, no build", () => {
    const missing = drive("drive-stdio.js", ["--root", server, "--scenario", "no-such"]);
    expect([missing.status, missing.stderr]).toEqual([2, expect.stringContaining('no scenario "no-such"')]);
    const option = drive("drive-stdio.js", ["--nope"]);
    expect([option.status, option.stderr]).toEqual([2, expect.stringContaining("unknown option --nope")]);
    expect(option.stderr).toContain("usage: drive-stdio.js");
    const empty = fs.mkdtempSync(path.join(tmp, "empty-"));
    const nobuild = drive("drive-stdio.js", ["--root", empty]);
    expect([nobuild.status, nobuild.stderr]).toEqual([2, expect.stringContaining('run "npm run build"')]);
    expect(nobuild.stderr).not.toMatch(/at .*\.js:\d+/);
    expect(drive("drive-stdio.js", ["--list"]).stdout.split("\n")).toContain("basic");
  });

  it("reports a server that never answers the handshake as a failed handshake, within the timeout it was given", () => {
    const fake = path.join(tmp, "silent-root");
    fs.mkdirSync(path.join(fake, "dist", "src"), { recursive: true });
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(fake, "dist", "src", "main.js"), 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); console.error("starting up, token abcdef-secret");');
    const started = Date.now();
    const ran = drive("drive-stdio.js", ["--root", fake, "--timeout-ms", "500", "--json"]);
    expect(ran.status).toBe(1);
    expect(ran.json.results[0].steps[0]).toMatchObject({ name: "handshake", ok: false });
    expect(ran.json.results[0].steps[0].problems.join(" ")).toContain("no answer to initialize within 500 ms");
    expect(ran.json.results[0].steps[0].problems.join(" ")).toContain("starting up");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("notices a server that does not leave when stdin closes (exit code 3) and one that prints on stdout", () => {
    const fake = path.join(tmp, "bad-root");
    fs.mkdirSync(path.join(fake, "dist", "src"), { recursive: true });
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(fake, "dist", "src", "main.js"), `
      console.log("banner on stdout");
      process.stdin.setEncoding("utf8"); let buf = "";
      process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) continue;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "x", capabilities: { tools: {} }, serverInfo: { name: "increadible", version: "1.2.3" } } : {} }) + "\\n"); } });
      process.stdin.on("end", () => process.exit(3));`);
    const scenario = writeScenario("ping-only.json", { name: "ping-only", steps: [{ name: "ping", method: "ping" }] });
    const ran = drive("drive-stdio.js", ["--root", fake, "--scenario", scenario, "--json"]);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["shutdown", "stdout is protocol only"]);
  });
});

describe("scripts/drive-http.js", () => {
  it("starts the server on a free loopback port with a random token, runs the scenario and ends the server with SIGTERM", () => {
    const ran = drive("drive-http.js", ["--root", server, "--json"]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(names(ran)).toEqual(expect.arrayContaining(["ready", "health", "auth: a request without the token is refused", "handshake", "metrics: the calls were counted", "shutdown"]));
    expect(ran.json.results[0].steps.length).toBe(22);
    expect(ran.stdout).not.toMatch(/[0-9a-f]{36}/); // the random token is 36 hex characters; it appears nowhere
    expect(ran.json.target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  describe("--url, against a server that is already running", () => {
    const start = async (token: string | null) => {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => { const p = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(p)); });
      });
      const data = fs.mkdtempSync(path.join(tmp, "remote-"));
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", PORT: String(port), HOST: "127.0.0.1", RULES_FILE: path.join(data, "r.yaml"), EXPERIMENTS_FILE: path.join(data, "e.yaml"), AB_DATA_FILE: path.join(data, "ab.jsonl"), AB_FSYNC: "false" };
      if (token) env.AUTH_TOKEN = token;
      const child = cp.spawn(process.execPath, [path.join(server, "dist", "src", "index.js")], { env, stdio: "ignore" });
      children.push(child);
      for (let i = 0; i < 100; i++) {
        const up = await new Promise<boolean>((resolve) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
        if (up) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { url: `http://127.0.0.1:${port}`, data };
    };

    it("skips the steps that write unless told otherwise, and sends the token from the named variable only", async () => {
      const { url, data } = await start("remote-token-4711");
      const ran = drive("drive-http.js", ["--url", url, "--token-env", "DRIVE_TOKEN", "--json"], { DRIVE_TOKEN: "remote-token-4711" });
      expect(ran.status).toBe(0);
      const skipped = ran.json.results[0].steps.filter((s: any) => s.skipped).map((s: any) => s.name);
      expect(skipped).toEqual(["A/B: create an experiment", "A/B: assign a variant", "A/B: record a measurement", "A/B: results count the measurement"]);
      const file = path.join(data, "ab.jsonl"); // the server creates it at start-up; nothing of the driver's may be in it
      expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").not.toContain("drive-");
      expect(ran.stdout + ran.stderr).not.toContain("remote-token-4711");
      const text = drive("drive-http.js", ["--url", url, "--token-env", "DRIVE_TOKEN"], { DRIVE_TOKEN: "remote-token-4711" });
      expect(text.stdout).toContain("PASS 17/17 (4 skipped: they write data)");
    });

    it("skips a step that writes whatever it writes (true, \"ab-data\", \"rules\"), and then has no calls to count in /metrics (mutation run 4)", async () => {
      const { url } = await start("remote-token-4714");
      const scenario = writeScenario("rules-only.json", { name: "rules-only", steps: [
        { name: "replace the rules", tool: "update_rules", writes: "rules", arguments: { rules: [] } },
        { name: "a measurement", tool: "record_metric", writes: "ab-data", arguments: { experiment_id: "x", variant_id: "A", metrics: { quality: 1 } } },
        { name: "a plain write", tool: "create_experiment", writes: true, arguments: { id: "x" } },
      ] });
      const ran = drive("drive-http.js", ["--url", url, "--token-env", "DRIVE_TOKEN", "--scenario", scenario, "--json"], { DRIVE_TOKEN: "remote-token-4714" });
      expect(ran.status).toBe(0);
      const steps = ran.json.results[0].steps;
      expect(steps.filter((s: any) => s.skipped).map((s: any) => s.name)).toEqual(["replace the rules", "a measurement", "a plain write"]);
      // no call was made, so there is nothing for the metrics step to count: it must not be added (and must not fail)
      expect(steps.map((s: any) => s.name)).not.toContain("metrics: the calls were counted");
    });

    it("writes only with --allow-writes", async () => {
      const { url, data } = await start("remote-token-4712");
      const ran = drive("drive-http.js", ["--url", url, "--token-env", "DRIVE_TOKEN", "--allow-writes", "--json"], { DRIVE_TOKEN: "remote-token-4712" });
      expect(ran.status).toBe(0);
      expect(ran.json.results[0].steps.some((s: any) => s.skipped)).toBe(false);
      expect(fs.readFileSync(path.join(data, "ab.jsonl"), "utf8")).toContain("drive-");
    });

    it("fails the handshake with a wrong token, and says the answer was a 401", async () => {
      const { url } = await start("remote-token-4713");
      const ran = drive("drive-http.js", ["--url", url, "--token-env", "DRIVE_TOKEN", "--json"], { DRIVE_TOKEN: "not-the-token" });
      expect(ran.status).toBe(1);
      expect(failing(ran)).toEqual(["handshake"]);
      expect(ran.json.results[0].steps.find((s: any) => s.name === "handshake").problems[0]).toMatch(/HTTP 401/);
    });

    it("fails when nothing listens, after the ready timeout it was given", () => {
      const started = Date.now();
      const ran = drive("drive-http.js", ["--url", "http://127.0.0.1:9", "--ready-timeout-ms", "400", "--json"]);
      expect(ran.status).toBe(1);
      expect(failing(ran)).toEqual(["ready"]);
      // the given timeout is the one that applies (the default is 15 s): the report names it and the run is far shorter than the default
      expect(ran.json.results[0].steps.find((s: any) => s.name === "ready").problems[0]).toContain("within 400 ms");
      expect(Date.now() - started).toBeLessThan(10000);
    });

    it("refuses options that belong to the other mode, and a token variable that is not set", () => {
      expect(drive("drive-http.js", ["--url", "http://127.0.0.1:1", "--data-dir", tmp]).status).toBe(2);
      expect(drive("drive-http.js", ["--token-env", "X"]).stderr).toContain("belong to --url");
      const unset = drive("drive-http.js", ["--url", "http://127.0.0.1:1", "--token-env", "DRIVE_UNSET"]);
      expect([unset.status, unset.stderr]).toEqual([2, expect.stringContaining("DRIVE_UNSET names a variable that is not set")]);
      expect(drive("drive-http.js", ["--url", "ftp://x"]).stderr).toContain("must be http or https");
    });
  });

  it("notices when the server's tool-call counter stays at zero (the metrics check reads the counter)", () => {
    const ran = broken("server.js", 'increadible_tool_calls_total{tool="${t}"} ${n}', 'increadible_tool_calls_total{tool="${t}"} 0', () => drive("drive-http.js", ["--root", server, "--json"]));
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["metrics: the calls were counted"]);
  });

  it("notices when the server stops refusing a request without the token (the auth check is not decoration)", () => {
    const ran = broken("index.js", 'json(401, { error: "Unauthorized" })', 'json(200, { error: "Unauthorized" })', () => drive("drive-http.js", ["--root", server, "--json"]));
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("auth: a request without the token is refused");
  });
});

describe("scripts/drive-probe.js", () => {
  it("passes on the server as it is, with the four recorded deviations marked KNOWN and three observations marked INFO", () => {
    const ran = drive("drive-probe.js", ["--root", server, "--json"]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(names(ran)).toEqual(probe.CHECKS.map((c: any) => c.id));
    const byStatus = (status: string) => ran.json.results[0].steps.filter((s: any) => s.status === status).map((s: any) => s.name);
    expect(byStatus("KNOWN")).toEqual(["stdio.date-shaped-version-is-echoed", "http.get-mcp-is-404", "http.origin-is-not-validated", "http.protocol-version-header-is-ignored"]);
    expect(byStatus("INFO")).toEqual(["stdio.big-line-is-answered", "http.host-is-not-validated", "http.content-type-is-not-checked"]);
    // each deviation says what the specification asks, for which revision, and where
    for (const step of ran.json.results[0].steps.filter((s: any) => s.status === "KNOWN")) expect(step.notes[0]).toMatch(/Source \(revision \d{4}-\d{2}-\d{2}\): https:\/\/modelcontextprotocol\.io\/specification\//);
    expect(ran.json.results[0].steps.find((s: any) => s.name === "stdio.date-shaped-version-is-echoed").notes[0]).toContain("/basic/lifecycle#version-negotiation");
  });

  it("lists the checks and takes one transport at a time", () => {
    expect(drive("drive-probe.js", ["--list"]).stdout.trim().split("\n").length).toBe(probe.CHECKS.length);
    const http = drive("drive-probe.js", ["--root", server, "--transport", "http", "--json"]);
    expect(names(http).every((n: string) => n.startsWith("http."))).toBe(true);
    expect(drive("drive-probe.js", ["--transport", "tcp"]).status).toBe(2);
  });

  describe("breaks the server on purpose, one thing at a time; the probe must name exactly that", () => {
    const cases: Array<{ what: string; file: string; from: string; to: string; transport: string; fails: string[] }> = [
      { what: "401 becomes 403", file: "index.js", from: 'json(401, { error: "Unauthorized" })', to: 'json(403, { error: "Unauthorized" })', transport: "http", fails: ["http.metrics-need-the-token", "http.mcp-needs-the-token"] },
      { what: "413 becomes 400", file: "index.js", from: 'refuse(413, "payload_too_large"', to: 'refuse(400, "payload_too_large"', transport: "http", fails: ["http.oversize-body"] },
      { what: "stdio parse error becomes -32600", file: "index.js", from: 'send({ jsonrpc: "2.0", id: null, error: { code: -32700', to: 'send({ jsonrpc: "2.0", id: null, error: { code: -32600', transport: "stdio", fails: ["stdio.parse-error"] },
      { what: "GET /mcp answers 405 (a recorded deviation is fixed: the record must be updated)", file: "index.js", from: 'json(404, { error: "Not found" });', to: 'json(req.method === "GET" && pathname === "/mcp" ? 405 : 404, { error: "Not found" });', transport: "http", fails: ["http.get-mcp-is-404"] },
    ];
    for (const c of cases) {
      it(c.what, () => {
        const ran = broken(c.file, c.from, c.to, () => drive("drive-probe.js", ["--root", server, "--transport", c.transport, "--json"]));
        expect(ran.status).toBe(1);
        expect(failing(ran)).toEqual(c.fails);
        const step = ran.json.results[0].steps.find((s: any) => s.name === c.fails[0]);
        expect(step.problems.length).toBeGreaterThan(0);
        expect(step.notes[0]).toMatch(/^expected: /); // a failure says what was expected
      });
    }
  });
});

describe("scripts/drive-bundle.js", () => {
  jest.setTimeout(240_000);
  const bundle = path.join(tmp, "bundle", `${pkg.name}-${pkg.version}.mcpb`);
  beforeAll(() => {
    fs.mkdirSync(path.dirname(bundle));
    mcpb.build(bundle);
  }, 240_000);

  it("unpacks the package into a folder with a space in its name, starts the server with the manifest's own command and environment, and checks where the data went", () => {
    const ran = drive("drive-bundle.js", ["--bundle", bundle, "--json"]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(names(ran)).toEqual(expect.arrayContaining(["bundle is a well-formed package", "handshake", "shutdown", "data landed in the chosen folder", "no lock file left behind"]));
    expect(failing(ran)).toEqual([]);
    expect(ran.json.server).toMatchObject({ name: "increadible", version: pkg.version });
    expect(ran.json.notes.join("\n")).toMatch(/unpacked to: .*Claude Extensions\/increadible/);
    expect(ran.json.notes.join("\n")).toContain("AB_FSYNC=true"); // the manifest's default for durable_writes
  });

  it("applies the settings it is given like the runtime does: booleans from true/false, unknown names refused", () => {
    const off = drive("drive-bundle.js", ["--bundle", bundle, "--setting", "durable_writes=false", "--json"]);
    expect(off.status).toBe(0);
    expect(off.json.notes.join("\n")).toContain("AB_FSYNC=false");
    const live = drive("drive-bundle.js", ["--bundle", bundle, "--setting", "contact=owner@example.test", "--json"]);
    expect(live.stdout).not.toContain("owner@example.test"); // the contact is shown as (set), never its value
    const unknown = drive("drive-bundle.js", ["--bundle", bundle, "--setting", "nope=1"]);
    expect([unknown.status, unknown.stderr]).toEqual([2, expect.stringContaining('--setting nope: the manifest has no such setting')]);
    const bad = drive("drive-bundle.js", ["--bundle", bundle, "--setting", "durable_writes=maybe"]);
    expect([bad.status, bad.stderr]).toEqual([2, expect.stringContaining("is a boolean: use true or false")]);
  });

  it("refuses a damaged package without starting anything (a flipped byte inside a file)", () => {
    const bytes = fs.readFileSync(bundle);
    const at = bytes.indexOf(Buffer.from("increadible")) + 400; // somewhere inside the first stored or compressed entries
    const damaged = Buffer.from(bytes);
    damaged[at] ^= 0xff;
    const file = path.join(tmp, "damaged.mcpb");
    fs.writeFileSync(file, damaged);
    const ran = drive("drive-bundle.js", ["--bundle", file, "--json"]);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["bundle is a well-formed package"]);
    expect(names(ran)).toEqual(["bundle is a well-formed package"]); // nothing else ran
  });

  it("fails 'data landed' when a scenario says it writes and nothing was written (the check can fail)", () => {
    const scenario = writeScenario("liar.json", { name: "liar", steps: [{ name: "reads only", tool: "get_rule_stats", writes: true }] });
    const ran = drive("drive-bundle.js", ["--bundle", bundle, "--scenario", scenario, "--json"]);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["data landed in the chosen folder"]);
  });

  it("substitutes the manifest variables as the runtime does and refuses what it cannot resolve", () => {
    const config = { data_directory: "/d", durable_writes: true };
    expect(bundleDriver.substitute("${__dirname}${/}dist", "/home", config)).toBe(`/home${path.sep}dist`);
    expect(bundleDriver.substitute("${user_config.data_directory}${/}x ${user_config.durable_writes}", "/h", config)).toBe(`/d${path.sep}x true`);
    expect(() => bundleDriver.substitute("${user_config.nope}", "/h", config)).toThrow(/has no value/);
    expect(() => bundleDriver.substitute("${other}", "/h", config)).toThrow(/has no value/);
    const manifest = { user_config: { data_directory: { type: "directory", required: true }, durable_writes: { type: "boolean", default: true }, note: { type: "string", default: "" } } };
    expect(bundleDriver.resolveUserConfig(manifest, { data_directory: "/x" })).toEqual({ data_directory: "/x", durable_writes: true, note: "" });
    expect(bundleDriver.resolveUserConfig(manifest, { data_directory: "/x", durable_writes: "false" }).durable_writes).toBe(false);
    expect(() => bundleDriver.resolveUserConfig(manifest, {})).toThrow(/requires the setting "data_directory"/);
  });

  it("will not write a file outside the install folder, whatever the package says", () => {
    const home = fs.mkdtempSync(path.join(tmp, "unpack-"));
    expect(() => bundleDriver.unpack([{ name: "../escape.txt", data: Buffer.from("x") }], home)).toThrow(/outside the install folder/);
    expect(fs.existsSync(path.join(home, "..", "escape.txt"))).toBe(false);
    bundleDriver.unpack([{ name: "a/b/c.txt", data: Buffer.from("ok") }], home);
    expect(fs.readFileSync(path.join(home, "a", "b", "c.txt"), "utf8")).toBe("ok");
  });
});

/**
 * What the independent review of this change found (PR #69): each test below reproduces one finding on the code as it was and passes now.
 * The ids (T-nn tester, SEC-nn security, D-nn documentation) are the review's.
 */
describe("the review's findings", () => {
  const ping = writeScenario("ping-only-2.json", { name: "ping-only", steps: [{ name: "ping", method: "ping" }] });
  const slow = writeScenario("slow.json", { name: "slow", steps: Array.from({ length: 40 }, (_, i) => ({ name: `ping ${i}`, method: "ping" })) });

  describe("options and scenario files are checked before anything is started (T-03, T-06, T-08, T-13, T-16)", () => {
    it("refuses a timeout that is not a whole number of milliseconds, with exit code 2, a message, no stack, and no work directory left", () => {
      const tmpdir = privateTmp();
      for (const [script, extra] of [["drive-stdio.js", ["--root", server]], ["drive-http.js", ["--root", server]], ["drive-probe.js", ["--root", server]]] as Array<[string, string[]]>) {
        for (const bad of ["abc", "NaN", "-5", "0", "1.5", "99999999999999", ""]) {
          const ran = drive(script, [...extra, "--timeout-ms", bad], { TMPDIR: tmpdir });
          expect({ script, bad, status: ran.status, stack: /node:events|at .*\.js:\d+/.test(ran.stderr) }).toEqual({ script, bad, status: 2, stack: false });
          expect(ran.stderr).toContain("--timeout-ms must be a whole number from 1 to 2147483647");
        }
      }
      expect(drive("drive-http.js", ["--url", "http://127.0.0.1:9", "--ready-timeout-ms", "0"], { TMPDIR: tmpdir }).status).toBe(2);
      expect(pending(tmpdir)).toEqual([]);
    });

    it("leaves no work directory behind when the command line is wrong", () => {
      const tmpdir = privateTmp();
      const missing = path.join(tmp, "does-not-exist.json");
      expect(drive("drive-stdio.js", ["--root", server, "--scenario", missing], { TMPDIR: tmpdir }).status).toBe(2);
      expect(drive("drive-http.js", ["--root", server, "--env", "1BAD=x"], { TMPDIR: tmpdir }).status).toBe(2);
      expect(drive("drive-bundle.js", ["--bundle", path.join(tmp, "no-such.mcpb")], { TMPDIR: tmpdir }).status).toBe(2);
      expect(pending(tmpdir)).toEqual([]);
    });

    it("says one thing, with exit code 2, when the build is missing for the probe (not one failed check per check)", () => {
      const empty = fs.mkdtempSync(path.join(tmp, "nobuild-"));
      fs.writeFileSync(path.join(empty, "package.json"), '{"version":"1.2.3"}');
      const ran = drive("drive-probe.js", ["--root", empty]);
      expect([ran.status, ran.stdout]).toEqual([2, ""]);
      expect(ran.stderr).toContain('run "npm run build"');
    });

    it("names the scenario file in every error about it, and does not let a file called 'basic' hide the shipped scenario", () => {
      const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
      fs.writeFileSync(path.join(cwd, "basic"), "this is not a scenario");
      fs.mkdirSync(path.join(cwd, "basic2"));
      fs.writeFileSync(path.join(cwd, "broken.json"), "{ not json");
      const run = (args: string[]) => cp.spawnSync(process.execPath, [path.join(root, "scripts", "drive-stdio.js"), "--root", server, ...args], { encoding: "utf8", cwd, env: { PATH: process.env.PATH ?? "" } });
      expect(run(["--scenario", "basic"]).status).toBe(0); // the shipped one, whatever is in the current directory
      const broken = run(["--scenario", "./broken.json"]);
      expect([broken.status, broken.stderr]).toEqual([2, expect.stringContaining(path.join(cwd, "broken.json"))]);
      expect(broken.stderr).toContain("not valid JSON");
      expect(run(["--scenario", path.join(cwd, "basic2")]).stderr).toContain("basic2"); // a directory: the message names it
    });
  });

  describe("expectations that can never be evaluated are refused when the file is read (T-04, D-03)", () => {
    const cases: Array<[string, object, RegExp]> = [
      ["json on a method step", { name: "s", method: "ping", expect: { json: { a: 1 } } }, /"json" applies to a tool step/],
      ["contains on a method step", { name: "s", method: "ping", expect: { contains: "x" } }, /"contains" applies to a tool step/],
      ["tool_error on a method step", { name: "s", method: "ping", expect: { tool_error: true } }, /"tool_error" applies to a tool step/],
      ["message_contains without rpc_error", { name: "s", method: "ping", expect: { message_contains: "x" } }, /"message_contains" needs "rpc_error"/],
      ["json next to rpc_error", { name: "s", method: "no/such", expect: { rpc_error: -32601, json: { a: 1 } } }, /"json" cannot go with "rpc_error"/],
      ["save next to rpc_error", { name: "s", method: "no/such", save: { a: "b" }, expect: { rpc_error: -32601 } }, /"save" cannot go with "rpc_error"/],
      ["tools_include on another method", { name: "s", method: "ping", expect: { tools_include: ["a"] } }, /"tools_include" applies to the method "tools\/list"/],
      ["params on a tool step", { name: "s", tool: "t", params: {} }, /"params" belongs to a method step/],
      ["arguments on a method step", { name: "s", method: "ping", arguments: {} }, /"arguments" belongs to a tool step/],
      ["a regular expression that does not compile", { name: "s", tool: "t", expect: { json: { a: { $matches: "(" } } } }, /not a regular expression/],
      ["rpc_error that is not a number", { name: "s", method: "ping", expect: { rpc_error: "-32601" } }, /"rpc_error" must be an integer code/],
      ["tool_error that is not a boolean", { name: "s", tool: "t", expect: { tool_error: "yes" } }, /"tool_error" must be true or false/],
    ];
    for (const [what, step, message] of cases) {
      it(`${what}`, () => {
        const file = writeScenario("invalid.json", { name: "invalid", steps: [step] });
        const ran = drive("drive-stdio.js", ["--root", server, "--scenario", file]);
        expect([ran.status, ran.stdout]).toEqual([2, ""]);
        expect(ran.stderr).toMatch(message);
        expect(ran.stderr).toContain("step 1 (s)");
      });
    }
  });

  describe("an interrupted driver leaves nothing behind (T-02, SEC-03)", () => {
    it("http: SIGTERM to the driver mid-run ends the server it started and removes its work directory, exit code 143", async () => {
      const tmpdir = privateTmp();
      const fake = fakeRoot("interrupt-http", { "index.js": FAKE_HTTP });
      const run = driveAsync("drive-http.js", ["--root", fake, "--scenario", slow, "--env", "FAKE_DELAY=250"], { TMPDIR: tmpdir });
      await waitFor("the server's pid file", () => fs.existsSync(path.join(tmpdir, "fake-http.pid")));
      const pid = Number(fs.readFileSync(path.join(tmpdir, "fake-http.pid"), "utf8"));
      await new Promise((r) => setTimeout(r, 700)); // inside the scenario
      expect(alive(pid)).toBe(true);
      expect(pending(tmpdir).length).toBe(1);
      run.child.kill("SIGTERM");
      const ended = await run.exit;
      expect(ended.code).toBe(143);
      await waitFor("the server to be gone", () => !alive(pid), 5000);
      expect(pending(tmpdir)).toEqual([]);
    }, 60_000);

    it("stdio: SIGINT to the driver mid-run ends the server and removes the work directory, exit code 130", async () => {
      const tmpdir = privateTmp();
      const fake = fakeRoot("interrupt-stdio", { "main.js": FAKE_STDIO });
      const run = driveAsync("drive-stdio.js", ["--root", fake, "--scenario", slow, "--env", "FAKE_DELAY=250"], { TMPDIR: tmpdir });
      await waitFor("the server's pid file", () => fs.existsSync(path.join(tmpdir, "fake-stdio.pid")));
      const pid = Number(fs.readFileSync(path.join(tmpdir, "fake-stdio.pid"), "utf8"));
      await new Promise((r) => setTimeout(r, 700));
      run.child.kill("SIGINT");
      const ended = await run.exit;
      expect(ended.code).toBe(130);
      await waitFor("the server to be gone", () => !alive(pid), 5000);
      expect(pending(tmpdir)).toEqual([]);
    }, 60_000);

    it("stdio: SIGHUP (the terminal closed) cleans up too, exit code 129 (CR-06, R-05)", async () => {
      const tmpdir = privateTmp();
      const fake = fakeRoot("interrupt-hup", { "main.js": FAKE_STDIO });
      const run = driveAsync("drive-stdio.js", ["--root", fake, "--scenario", slow, "--env", "FAKE_DELAY=250"], { TMPDIR: tmpdir });
      await waitFor("the server's pid file", () => fs.existsSync(path.join(tmpdir, "fake-stdio.pid")));
      const pid = Number(fs.readFileSync(path.join(tmpdir, "fake-stdio.pid"), "utf8"));
      await new Promise((r) => setTimeout(r, 700));
      run.child.kill("SIGHUP");
      expect((await run.exit).code).toBe(129);
      await waitFor("the server to be gone", () => !alive(pid), 5000);
      expect(pending(tmpdir)).toEqual([]);
    }, 60_000);

    it("http: a server that ignores SIGTERM and SIGINT is ended all the same (R-06)", async () => {
      const tmpdir = privateTmp();
      const fake = fakeRoot("interrupt-stubborn", { "index.js": FAKE_HTTP });
      const run = driveAsync("drive-http.js", ["--root", fake, "--scenario", slow, "--env", "FAKE_DELAY=250", "--env", "FAKE_STUBBORN=1"], { TMPDIR: tmpdir });
      await waitFor("the server's pid file", () => fs.existsSync(path.join(tmpdir, "fake-http.pid")));
      const pid = Number(fs.readFileSync(path.join(tmpdir, "fake-http.pid"), "utf8"));
      await new Promise((r) => setTimeout(r, 700));
      expect(alive(pid)).toBe(true);
      run.child.kill("SIGTERM");
      expect((await run.exit).code).toBe(143);
      await waitFor("the stubborn server to be gone", () => !alive(pid), 5000);
      expect(pending(tmpdir)).toEqual([]);
    }, 60_000);

    it("keeps the work directory when --keep was given, even when interrupted", async () => {
      const tmpdir = privateTmp();
      const fake = fakeRoot("interrupt-keep", { "main.js": FAKE_STDIO });
      const run = driveAsync("drive-stdio.js", ["--root", fake, "--scenario", slow, "--env", "FAKE_DELAY=250", "--keep"], { TMPDIR: tmpdir });
      await waitFor("the server's pid file", () => fs.existsSync(path.join(tmpdir, "fake-stdio.pid")));
      await new Promise((r) => setTimeout(r, 500));
      run.child.kill("SIGTERM");
      await run.exit;
      expect(pending(tmpdir).length).toBe(1);
    }, 60_000);
  });

  describe("text from a server is scrubbed wherever the driver prints it (SEC-01, SEC-07)", () => {
    it("stdio: a secret the server echoes in an error, and an escape sequence, do not reach the report", () => {
      const fake = fakeRoot("echo-stdio", { "main.js": FAKE_STDIO });
      const scenario = writeScenario("tool-call.json", { name: "tool-call", steps: [{ name: "tool", tool: "anything" }] });
      const secret = "zz-echoed-secret-5150";
      for (const extra of [[], ["--json"]]) {
        const ran = drive("drive-stdio.js", ["--root", fake, "--scenario", scenario, "--env", `FAKE_SECRET=${secret}`, "--env", `GATEWAY_KEY_ALPHA=${secret}`, ...extra]);
        expect(ran.status).toBe(1); // the tool error was not expected
        expect(ran.stdout + ran.stderr).not.toContain(secret);
        expect(ran.stdout + ran.stderr).not.toContain("\u001b");
        expect(ran.stdout).toContain("<hidden>");
      }
    });

    it("http: the random token, echoed back by the server in an error message, is hidden", () => {
      const fake = fakeRoot("echo-http", { "index.js": FAKE_HTTP });
      const ran = drive("drive-http.js", ["--root", fake, "--scenario", ping, "--env", "FAKE_ECHO=1"]);
      expect(ran.status).toBe(1);
      expect(ran.stdout).toContain("cannot use Bearer <hidden>");
      expect(ran.stdout + ran.stderr).not.toMatch(/[0-9a-f]{36}/);
    });

    it("http --url: a token from --token-env that the server echoes back is hidden too", async () => {
      const tmpdir = privateTmp();
      const fake = fakeRoot("echo-url", { "index.js": FAKE_HTTP });
      const port = await new Promise<number>((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
      });
      const child = cp.spawn(process.execPath, [path.join(fake, "dist", "src", "index.js")], { env: { PATH: process.env.PATH ?? "", PORT: String(port), TMPDIR: tmpdir, FAKE_ECHO: "1" }, stdio: "ignore" });
      children.push(child);
      await waitFor("the fake server", () => fs.existsSync(path.join(tmpdir, "fake-http.pid")));
      const ran = drive("drive-http.js", ["--url", `http://127.0.0.1:${port}`, "--token-env", "DRIVE_TOKEN", "--scenario", ping], { DRIVE_TOKEN: "remote-echo-token-9001" });
      expect(ran.status).toBe(1);
      expect(ran.stdout).toContain("cannot use Bearer <hidden>");
      expect(ran.stdout + ran.stderr).not.toContain("remote-echo-token-9001");
    });
  });

  describe("the drivers never switch live calls on (T-01, SEC-02, D-01)", () => {
    it("refuses GATEWAY_LIVE_APIS in --env and live_apis in --setting, with exit code 2 and without printing the value", () => {
      const value = "hackernews";
      for (const [script, args] of [["drive-stdio.js", ["--root", server, "--env", `GATEWAY_LIVE_APIS=${value}`]], ["drive-http.js", ["--root", server, "--env", `GATEWAY_LIVE_APIS=${value}`]]] as Array<[string, string[]]>) {
        const ran = drive(script, args);
        expect([ran.status, ran.stdout]).toEqual([2, ""]);
        expect(ran.stderr).toContain("switches on calls to real providers");
        expect(ran.stderr).not.toContain(value + "\n");
      }
      const bundle = drive("drive-bundle.js", ["--bundle", path.join(tmp, "no-such.mcpb"), "--setting", `live_apis=${value}`]);
      expect([bundle.status, bundle.stderr]).toEqual([2, expect.stringContaining("switches on calls to real providers")]);
    });

    it("allows an empty value (the manifest's own default) and other GATEWAY_ settings", () => {
      expect(drive("drive-stdio.js", ["--root", server, "--env", "GATEWAY_LIVE_APIS=", "--env", "GATEWAY_CONTACT=someone@example.test", "--json"]).status).toBe(0);
    });
  });

  describe("small mismatches between options and documents (CR-09)", () => {
    it("takes --ready-timeout-ms in the self-contained mode as well", () => {
      expect(drive("drive-http.js", ["--root", server, "--ready-timeout-ms", "30000", "--scenario", ping]).status).toBe(0);
      expect(drive("drive-http.js", ["--root", server, "--ready-timeout-ms", "abc"]).status).toBe(2);
    });

  });

  describe("a token over plain http (R-16)", () => {
    it("warns when the token would go to another machine over http, and not for this machine or https", () => {
      const run = (url: string) => drive("drive-http.js", ["--url", url, "--token-env", "DRIVE_TOKEN", "--ready-timeout-ms", "300", "--timeout-ms", "300"], { DRIVE_TOKEN: "plain-http-token-1234" });
      expect(run("http://203.0.113.9:9").stdout).toContain("warning: the token is sent over plain http to an address that is not this machine");
      expect(run("http://127.0.0.1:9").stdout).not.toContain("warning: the token is sent");
      expect(run("http://localhost:9").stdout).not.toContain("warning: the token is sent");
      expect(run("https://203.0.113.9:9").stdout).not.toContain("warning: the token is sent");
      expect(run("http://203.0.113.9:9").stdout).not.toContain("plain-http-token-1234");
    }, 60_000);
  });

  describe("--url takes an address and nothing else (T-17)", () => {
    it("refuses a path prefix and credentials, and does not print the password", () => {
      const prefix = drive("drive-http.js", ["--url", "http://127.0.0.1:1/some/prefix"]);
      expect([prefix.status, prefix.stderr]).toEqual([2, expect.stringContaining("address only")]);
      const creds = drive("drive-http.js", ["--url", "http://user:hunter2-password@127.0.0.1:1"]);
      expect([creds.status, creds.stderr]).toEqual([2, expect.stringContaining("must not carry a user name or password")]);
      expect(creds.stdout + creds.stderr).not.toContain("hunter2-password");
      expect(drive("drive-http.js", ["--url", "not a url"]).status).toBe(2);
    });
  });

  describe("the HTTP driver's own checks can fail (the second breakage run's survivors)", () => {
    it("fails the shutdown check when the server leaves with a nonzero code on SIGTERM", () => {
      const ran = broken("index.js", 'process.on("SIGTERM", () => shutdown("SIGTERM"));', 'process.on("SIGTERM", () => process.exit(5));', () => drive("drive-http.js", ["--root", server, "--json"]));
      expect(ran.status).toBe(1);
      expect(failing(ran)).toEqual(["shutdown"]);
      expect(ran.json.results[0].steps.find((s: any) => s.name === "shutdown").problems[0]).toBe("the server left with code 5 after SIGTERM, expected 0");
    });

    it("has no metrics step for a scenario that calls no tool, and checks that THIS run moved the counter otherwise", () => {
      const quiet = drive("drive-http.js", ["--root", server, "--scenario", ping, "--json"]);
      expect(quiet.status).toBe(0);
      expect(names(quiet)).not.toContain("metrics: the calls were counted");
    });

    it("reports the failing check as 'different' and not with what a passing one would have shown (T-14)", () => {
      const ran = broken("index.js", 'json(401, { error: "Unauthorized" })', 'json(200, { error: "Unauthorized" })', () => drive("drive-http.js", ["--root", server, "--json"]));
      const step = ran.json.results[0].steps.find((s: any) => s.name === "auth: a request without the token is refused");
      expect([step.ok, step.summary]).toEqual([false, "different"]);
    });
  });

  describe("the bundle driver (T-05, D-02, SEC-04 and the survivors)", () => {
    const bundle = path.join(tmp, "bundle2", `${pkg.name}-${pkg.version}.mcpb`);
    beforeAll(() => {
      fs.mkdirSync(path.dirname(bundle));
      mcpb.build(bundle);
    }, 240_000);

    it("creates nothing in the folder it was given when a setting is wrong (it was in an earlier block, where this package did not exist yet and the test passed for the wrong reason: round 3)", () => {
      const parent = fs.mkdtempSync(path.join(tmp, "ordering-"));
      const data = path.join(parent, "not-created-yet");
      const ran = drive("drive-bundle.js", ["--bundle", bundle, "--data-dir", data, "--setting", "nope=1"]);
      expect(ran.status).toBe(2);
      expect(ran.stderr).toContain("the manifest has no such setting"); // refused for the setting, not because the package was missing
      expect(fs.existsSync(data)).toBe(false);
    });

    it("never unpacks into the folder the user gave for the data, and a reused folder cannot hide a damaged package", () => {
      const data = fs.mkdtempSync(path.join(tmp, "reused-data-"));
      const first = drive("drive-bundle.js", ["--bundle", bundle, "--data-dir", data, "--json"]);
      expect(first.status).toBe(0);
      expect(fs.readdirSync(data).sort()).toEqual(["ab-data.jsonl"]); // data only: no "Claude Extensions", no package files
      const bytes = fs.readFileSync(bundle);
      const damaged = Buffer.from(bytes);
      damaged[bytes.indexOf(Buffer.from("increadible")) + 400] ^= 0xff;
      const file = path.join(tmp, "damaged-again.mcpb");
      fs.writeFileSync(file, damaged);
      const second = drive("drive-bundle.js", ["--bundle", file, "--data-dir", data, "--json"]);
      expect(second.status).toBe(1);
      expect(failing(second)).toEqual(["bundle is a well-formed package"]);
    });

    it("accepts a scenario of its own that writes data under another id (the check does not hard-code the shipped scenario's ids)", () => {
      const scenario = writeScenario("own-ids.json", { name: "own-ids", steps: [
        { name: "create", tool: "create_experiment", writes: true, arguments: { id: "mine-1-${run_id}", name: "n", hypothesis: "h", variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }], metrics: [{ id: "q", name: "q", type: "continuous", aggregation: "mean" }] }, expect: { json: { status: "success" } } },
      ] });
      const ran = drive("drive-bundle.js", ["--bundle", bundle, "--scenario", scenario, "--json"]);
      expect(ran.status).toBe(0);
    });

    it("shows a setting the manifest marks sensitive, or whose name says so, only as (set)", () => {
      const shown = bundleDriver.describeSettings({ user_config: { api_secret: { type: "string" }, plain: { type: "string" }, odd: { type: "string", sensitive: true }, contact: { type: "string" } } }, { api_secret: "s3cret-value", plain: "visible", odd: "also-hidden", contact: "me@example.test" });
      expect(shown).toEqual(["api_secret=(set)", 'plain="visible"', "odd=(set)", "contact=(set)"]);
    });

    describe("dataChecks, the checks after a clean exit", () => {
      const dir = fs.mkdtempSync(path.join(tmp, "datachecks-"));
      const writes = { name: "s", steps: [{ name: "w", tool: "t", writes: true, arguments: { id: "x-${run_id}" } }] };
      const noRunId = { name: "s", steps: [{ name: "w", tool: "t", writes: true }] };
      const reads = { name: "s", steps: [{ name: "r", tool: "t" }] };
      const file = (name: string, content?: string) => { const f = path.join(dir, name); if (content !== undefined) fs.writeFileSync(f, content); return f; };
      const verdict = (steps: any[]) => Object.fromEntries(steps.map((s) => [s.name, s.ok]));

      it("fails when a scenario that writes left no file, an empty file, or a file without this run", () => {
        expect(verdict(bundleDriver.dataChecks(file("missing.jsonl"), writes, "RUN1"))["data landed in the chosen folder"]).toBe(false);
        expect(verdict(bundleDriver.dataChecks(file("empty.jsonl", ""), writes, "RUN1"))["data landed in the chosen folder"]).toBe(false);
        const other = bundleDriver.dataChecks(file("other.jsonl", '{"id":"x-OTHER"}\n'), writes, "RUN1");
        expect(verdict(other)["data landed in the chosen folder"]).toBe(false);
        expect(other[0].problems[0]).toMatch(/does not contain this run \(RUN1\)/);
      });

      it("fails an empty file on its own account too: a scenario that does not use the run id has no other way to notice that nothing was written (round 3)", () => {
        const empty = bundleDriver.dataChecks(file("empty-noid.jsonl", ""), noRunId, "RUN1");
        expect(verdict(empty)["data landed in the chosen folder"]).toBe(false);
        expect(empty[0].problems[0]).toMatch(/is empty/);
      });

      it("holds the file to this run's id only when a step that WRITES uses it (R-08: the id may appear in a read step, such as a gateway call)", () => {
        const mixed = { name: "s", steps: [{ name: "call", tool: "c", arguments: { driver_run: "${run_id}" } }, { name: "w", tool: "t", writes: true, arguments: { id: "fixed-id" } }] };
        const steps = bundleDriver.dataChecks(file("mixed.jsonl", '{"id":"fixed-id"}\n'), mixed, "RUN1");
        expect(steps[0].ok).toBe(true);
      });

      it("passes with this run in the file, with any content when the scenario does not use the run id, and with nothing to write", () => {
        expect(verdict(bundleDriver.dataChecks(file("mine.jsonl", '{"id":"x-RUN1"}\n'), writes, "RUN1"))["data landed in the chosen folder"]).toBe(true);
        expect(verdict(bundleDriver.dataChecks(file("any.jsonl", "{}\n"), noRunId, "RUN1"))["data landed in the chosen folder"]).toBe(true);
        expect(verdict(bundleDriver.dataChecks(file("none.jsonl"), reads, "RUN1"))["data landed in the chosen folder"]).toBe(true);
      });

      it("fails when the lock file is still there", () => {
        const data = file("locked.jsonl", '{"id":"x-RUN1"}\n');
        expect(verdict(bundleDriver.dataChecks(data, writes, "RUN1"))["no lock file left behind"]).toBe(true);
        fs.writeFileSync(`${data}.lock`, "pid");
        const steps = bundleDriver.dataChecks(data, writes, "RUN1");
        expect(verdict(steps)["no lock file left behind"]).toBe(false);
        expect(steps[1].problems[0]).toContain("still exists after a clean exit");
      });
    });
  });
});
