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
      const ran = drive("drive-http.js", ["--url", "http://127.0.0.1:9", "--ready-timeout-ms", "400", "--json"]);
      expect(ran.status).toBe(1);
      expect(failing(ran)).toEqual(["ready"]);
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
  it("passes on the server as it is, with the five recorded deviations marked KNOWN and nothing else", () => {
    const ran = drive("drive-probe.js", ["--root", server, "--json"]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(names(ran)).toEqual(probe.CHECKS.map((c: any) => c.id));
    const byStatus = (status: string) => ran.json.results[0].steps.filter((s: any) => s.status === status).map((s: any) => s.name);
    expect(byStatus("KNOWN")).toEqual([
      "stdio.unknown-version-is-echoed", "stdio.big-line-is-answered", "http.get-mcp-is-404", "http.origin-and-host-are-not-validated", "http.protocol-version-header-is-ignored",
    ]);
    expect(byStatus("INFO")).toEqual(["http.content-type-is-not-checked"]);
    for (const step of ran.json.results[0].steps.filter((s: any) => s.status === "KNOWN")) expect(step.notes[0].length).toBeGreaterThan(40); // each deviation says what it is
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
