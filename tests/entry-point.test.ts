import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * The process entry point (`src/index.ts`, the block that runs only when the file is started): what it does with the environment it
 * is started in. Jest cannot reach it in-process, and `scripts/smoke.sh` covers its main paths; the mutation-testing pass of the audit
 * showed that these were in neither: a whitespace-only AUTH_TOKEN, the warning for an unauthenticated server beyond loopback, the
 * listening message, the options handed to the HTTP server, and the event-loop monitor being started. Each test starts the real
 * compiled server as a separate process, so what is checked is what a deployment gets.
 */

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-entry-"));
const entry = path.join(tmp, "dist", "src", "index.js");
const mainEntry = path.join(tmp, "dist", "src", "main.js");
const abModule = path.join(tmp, "dist", "features", "08-ab-testing", "src", "mcp-server.js");
const children: ChildProcess[] = [];

beforeAll(() => {
  // Compile the project the way `npm run build` does, into a scratch directory that can find the dependencies.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(tmp, "node_modules"), "dir");
  const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(tmp, "dist")], { cwd: root, encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`the build for the entry-point tests failed:\n${tsc.stdout}${tsc.stderr}`);
}, 120_000);
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

interface Running {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
}

/** Starts the server with exactly these variables (nothing from the surrounding environment) and resolves when it is listening. */
function start(env: Record<string, string>, args: string[] = [], file: string = entry): Promise<Running> {
  const child = spawn(process.execPath, [file, ...args], {
    env: { PATH: process.env.PATH ?? "", RULES_FILE: path.join(tmp, "rules.yaml"), EXPERIMENTS_FILE: path.join(tmp, "experiments.yaml"), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let stderr = "";
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start within 15 s:\n${stderr}`)), 15_000);
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
      if (/increadible listening on/.test(stderr)) {
        clearTimeout(timer);
        resolve({ child, stderr: () => stderr, exited });
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`the server exited before it listened:\n${stderr}`));
    });
  });
}

function request(port: number, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: { "content-type": "application/json", ...headers }, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("AUTH_TOKEN", () => {
  it("is ignored when it is only spaces: the server runs without authentication, as for an empty one", async () => {
    const port = await freePort();
    await start({ PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: "   " });
    expect((await request(port, "POST", "/mcp", PING)).status).toBe(200);
  });

  it("is required, as given, when it is set: no token and a wrong token are refused, the right one is served", async () => {
    const port = await freePort();
    await start({ PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: "s3cret" });
    expect((await request(port, "POST", "/mcp", PING)).status).toBe(401);
    expect((await request(port, "POST", "/mcp", PING, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await request(port, "POST", "/mcp", PING, { authorization: "Bearer s3cret" })).status).toBe(200);
    expect((await request(port, "GET", "/health")).status).toBe(200); // probes never need it
  });
});

describe("ALLOWED_ORIGINS", () => {
  const ORIGIN = (value: string) => ({ authorization: "Bearer s3cret", origin: value });

  it("lets a listed Origin through and refuses every other one in the real process; a request with no Origin is not affected", async () => {
    const port = await freePort();
    await start({ PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: "s3cret", ALLOWED_ORIGINS: "https://app.example.com, http://localhost:3000" });
    expect((await request(port, "POST", "/mcp", PING, ORIGIN("https://app.example.com"))).status).toBe(200);
    expect((await request(port, "POST", "/mcp", PING, ORIGIN("http://localhost:3000"))).status).toBe(200);
    expect((await request(port, "POST", "/mcp", PING, ORIGIN("http://evil.example"))).status).toBe(403);
    expect((await request(port, "POST", "/mcp", PING, ORIGIN("https://app.example.com:8443"))).status).toBe(403);
    expect((await request(port, "POST", "/mcp", PING, { authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it("refuses every Origin when it is not set (also on a server started without a token)", async () => {
    const port = await freePort();
    await start({ PORT: String(port), HOST: "127.0.0.1" });
    expect((await request(port, "POST", "/mcp", PING, { origin: "http://localhost:3000" })).status).toBe(403);
    expect((await request(port, "POST", "/mcp", PING)).status).toBe(200);
  });

  it("names each entry it ignores at start-up, keeps the valid ones, and still starts", async () => {
    const port = await freePort();
    const server = await start({ PORT: String(port), HOST: "127.0.0.1", ALLOWED_ORIGINS: "*, https://app.example.com/path, https://ok.example, null" });
    for (const entry of ["*", "https://app.example.com/path", "null"]) expect(server.stderr()).toContain(`Ignoring ALLOWED_ORIGINS entry "${entry}" is not an origin`);
    expect(server.stderr()).not.toContain('"https://ok.example"');
    expect((await request(port, "POST", "/mcp", PING, { origin: "https://ok.example" })).status).toBe(200);
    expect((await request(port, "POST", "/mcp", PING, { origin: "https://app.example.com" })).status).toBe(403); // the entry with a path was not taken as its origin
  });
});

describe("what the server says when it starts", () => {
  it("names the address it listens on", async () => {
    const port = await freePort();
    const server = await start({ PORT: String(port), HOST: "127.0.0.1" });
    expect(server.stderr()).toContain(`increadible listening on http://127.0.0.1:${port}`);
  });

  it("says whether the gateway's User-Agent carries a contact (the Claude Desktop setting arrives as GATEWAY_CONTACT), never the contact", async () => {
    const without = await start({ PORT: String(await freePort()), HOST: "127.0.0.1" });
    expect(without.stderr()).toContain("User-Agent contact: not set (GATEWAY_CONTACT; in Claude Desktop, the setting Contact for providers)");
    const withContact = await start({ PORT: String(await freePort()), HOST: "127.0.0.1", GATEWAY_CONTACT: "probe@example.org" });
    expect(withContact.stderr()).toContain("User-Agent contact: set");
    expect(withContact.stderr()).not.toContain("probe@example.org");
  });

  it("listens on port 3000 when started with --http and no PORT", async () => {
    const taken = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(true));
      probe.listen(3000, "127.0.0.1", () => probe.close(() => resolve(false)));
    });
    if (taken) {
      console.warn("port 3000 is in use on this machine: the default-port check was not run");
      return;
    }
    const server = await start({ HOST: "127.0.0.1" }, ["--http"]);
    expect(server.stderr()).toContain("increadible listening on http://127.0.0.1:3000");
    expect((await request(3000, "GET", "/health")).status).toBe(200);
  });

  it("warns when it serves beyond this machine without authentication, and only then", async () => {
    const warning = (host: string) => `WARNING: serving on ${host} without authentication (ALLOW_UNAUTHENTICATED is set)`;
    const open = await start({ PORT: String(await freePort()), HOST: "0.0.0.0", ALLOW_UNAUTHENTICATED: "1" });
    expect(open.stderr()).toContain(warning("0.0.0.0"));
    const withToken = await start({ PORT: String(await freePort()), HOST: "0.0.0.0", AUTH_TOKEN: "t" });
    expect(withToken.stderr()).not.toContain("WARNING");
    const loopback = await start({ PORT: String(await freePort()), HOST: "127.0.0.1" });
    expect(loopback.stderr()).not.toContain("WARNING");
    const named = await start({ PORT: String(await freePort()), HOST: "localhost", ALLOW_UNAUTHENTICATED: "1" });
    expect(named.stderr()).not.toContain("WARNING"); // localhost is this machine
  });

  it("refuses to start open beyond this machine, says why, and exits with 1", async () => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", PORT: String(await freePort()), HOST: "0.0.0.0", RULES_FILE: path.join(tmp, "rules.yaml"), EXPERIMENTS_FILE: path.join(tmp, "experiments.yaml") }, stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += c));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(/Refusing to listen on 0\.0\.0\.0 without AUTH_TOKEN/);
  });
});

describe("the settings handed to the HTTP server", () => {
  it("applies RATE_LIMIT_PER_MINUTE to POST /mcp and not to the probes", async () => {
    const port = await freePort();
    await start({ PORT: String(port), HOST: "127.0.0.1", RATE_LIMIT_PER_MINUTE: "2" });
    expect([(await request(port, "POST", "/mcp", PING)).status, (await request(port, "POST", "/mcp", PING)).status]).toEqual([200, 200]);
    expect((await request(port, "POST", "/mcp", PING)).status).toBe(429);
    expect((await request(port, "GET", "/health")).status).toBe(200);
  });

  it("applies HTTP_HEADERS_TIMEOUT_MS: a client that never finishes its headers is cut off within a second, not after 10 s", async () => {
    const port = await freePort();
    await start({ PORT: String(port), HOST: "127.0.0.1", HTTP_HEADERS_TIMEOUT_MS: "400", HTTP_REQUEST_TIMEOUT_MS: "800" });
    const started = Date.now();
    const closedAfter = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n")); // no blank line: headers never end
      socket.on("data", () => undefined);
      const failsafe = setTimeout(() => {
        socket.destroy();
        reject(new Error("the connection was still open after 5 s"));
      }, 5_000);
      socket.on("close", () => {
        clearTimeout(failsafe);
        resolve(Date.now() - started);
      });
      socket.on("error", () => undefined);
    });
    expect(closedAfter).toBeLessThan(3_000);
  });

  it("drains on SIGTERM for SHUTDOWN_DRAIN_MS, answering /ready 503 meanwhile, and then exits 0", async () => {
    const port = await freePort();
    const server = await start({ PORT: String(port), HOST: "127.0.0.1", SHUTDOWN_DRAIN_MS: "1500", SHUTDOWN_TIMEOUT_MS: "5000" });
    expect((await request(port, "GET", "/ready")).status).toBe(200);
    const signalled = Date.now();
    server.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    expect((await request(port, "GET", "/ready")).status).toBe(503); // draining: still serving, but not ready
    expect(await server.exited).toBe(0);
    expect(Date.now() - signalled).toBeGreaterThanOrEqual(1_200); // it waited for the drain
    expect(server.stderr()).toContain("SIGTERM: draining for 1500 ms, then closing (connections are cut 5000 ms after that)");
  });
});

describe("SIGINT, the signal of Ctrl-C", () => {
  it("ends the HTTP server cleanly, exit code 0, like SIGTERM", async () => {
    const server = await start({ PORT: String(await freePort()), HOST: "127.0.0.1" });
    server.child.kill("SIGINT");
    expect(await server.exited).toBe(0);
    expect(server.stderr()).toContain("SIGINT: draining for 0 ms");
  });

  it("ends a stdio session cleanly, exit code 0, and so does SIGTERM", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", RULES_FILE: path.join(tmp, "rules.yaml"), EXPERIMENTS_FILE: path.join(tmp, "experiments.yaml") }, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      child.stderr!.resume();
      await new Promise<void>((resolve) => {
        child.stdout!.once("data", () => resolve()); // it answered: the handlers are installed
        child.stdin!.write(JSON.stringify(PING) + "\n"); // and stdin stays open
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, sig) => resolve({ code, signal: sig })));
      child.kill(signal);
      expect(await exited).toEqual({ code: 0, signal: null });
    }
  });
});

describe("the event-loop monitor", () => {
  it("is running in HTTP mode: its histogram appears on /metrics", async () => {
    const port = await freePort();
    await start({ PORT: String(port), HOST: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 250)); // a few 10 ms ticks
    const metrics = (await request(port, "GET", "/metrics")).text;
    expect(metrics).toMatch(/increadible_event_loop_delay_seconds_count [1-9]/);
  });
});

describe("stdio mode (no PORT, no --http)", () => {
  it("answers on stdout, stays quiet on stderr about listening, and exits 0 when its input ends", async () => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", RULES_FILE: path.join(tmp, "rules.yaml"), EXPERIMENTS_FILE: path.join(tmp, "experiments.yaml") }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => (stdout += c));
    child.stderr!.on("data", (c) => (stderr += c));
    child.stdin!.end(JSON.stringify(PING) + "\n");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(stderr).not.toContain("listening");
  });
});

/**
 * src/main.ts is what the Claude Desktop bundle starts. src/index.ts starts the server only when it is the program
 * (`require.main === module`); a launcher that loads it with require() gets a process that loads everything, never reads a line,
 * and answers nothing: the client's first request times out after 60 s. main.ts always starts the server.
 */
describe("src/main.ts, the entry of the Claude Desktop bundle", () => {
  const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

  /** Runs `file` the way a launcher would: not as the program, but loaded by another script with require(). */
  function viaLauncher(file: string, input: string) {
    return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "require(process.argv[1])", file], {
        env: { PATH: process.env.PATH ?? "", RULES_FILE: path.join(tmp, "rules.yaml"), EXPERIMENTS_FILE: path.join(tmp, "experiments.yaml") },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c) => (stdout += c));
      child.stderr!.on("data", (c) => (stderr += c));
      const failsafe = setTimeout(() => reject(new Error(`no exit within 10 s (stdout: ${stdout})`)), 10_000);
      child.once("exit", (code) => {
        clearTimeout(failsafe);
        resolve({ stdout, stderr, code });
      });
      child.stdin!.end(input);
    });
  }

  it("serves stdio when a launcher loads it with require(), and says on stderr that it is ready", async () => {
    const r = await viaLauncher(mainEntry, JSON.stringify(INITIALIZE) + "\n");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).result.serverInfo.name).toBe("increadible");
    expect(r.stderr).toContain(`increadible ${require("../package.json").version}: ready on stdio`); // the banner names the version that is running
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("is the reason it exists: index.js loaded the same way answers nothing", async () => {
    const r = await viaLauncher(entry, JSON.stringify(INITIALIZE) + "\n");
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("ready on stdio");
  });

  it("answers once, not twice, when it is the program itself (the index.js guard must stay quiet when main.js started the server)", async () => {
    const child = spawn(process.execPath, [mainEntry], { env: { PATH: process.env.PATH ?? "", RULES_FILE: path.join(tmp, "rules.yaml"), EXPERIMENTS_FILE: path.join(tmp, "experiments.yaml") }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout!.on("data", (c) => (stdout += c));
    child.stderr!.resume();
    child.stdin!.end(JSON.stringify(INITIALIZE) + "\n");
    expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("starts the HTTP server like index.js when PORT is set", async () => {
    const port = await freePort();
    const running = await start({ PORT: String(port), HOST: "127.0.0.1" }, [], mainEntry);
    expect((await request(port, "GET", "/health")).status).toBe(200);
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
  });
});

/**
 * The data file lock in a real process. A loop that retries without sleeping or a deadline cannot be tested in-process: it would
 * freeze the test runner too. So each case runs in a child process with a time limit, and "it hung" is a failed test, not a stuck one.
 */
describe("the A/B data file lock, in a child process with a time limit", () => {
  const script = (name: string, body: string) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, body);
    return file;
  };

  it("gives up with a clear error, within its deadline and without hammering the file system, when a stale lock cannot be removed (another program has it open on Windows)", () => {
    const file = script("lock-deadline.js", `
      const fs = require("fs"), path = require("path"), os = require("os");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-deadline-"));
      const data = path.join(dir, "ab-data.jsonl");
      fs.writeFileSync(data + ".lock", JSON.stringify({ pid: 2147483000, host: os.hostname(), started: "x", token: "t" }));
      const old = new Date(Date.now() - 60000); fs.utimesSync(data + ".lock", old, old); // a dead holder, long ago: stale
      const real = fs.renameSync;
      let attempts = 0;
      fs.renameSync = (from, to) => { if (String(from).endsWith(".lock")) { attempts++; const e = new Error("EPERM: operation not permitted, rename"); e.code = "EPERM"; throw e; } return real(from, to); };
      const { ABTestingFramework } = require(process.argv[2]);
      const t0 = Date.now();
      try { new ABTestingFramework(path.join(dir, "e.yaml"), data, { lockWaitMs: 300 }); console.log("opened"); }
      catch (e) { console.log("threw after " + (Date.now() - t0) + " ms, " + attempts + " attempts: " + e.message.slice(0, 240)); }
    `);
    const r = spawnSync(process.execPath, [file, abModule], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH ?? "" } });
    expect({ timedOut: r.status === null, stdout: r.stdout.trim().slice(0, 300) }).toEqual({ timedOut: false, stdout: expect.stringMatching(/^threw after \d+ ms, \d+ attempts: .*stale lock .*could not be removed/) });
    const [, ms, attempts] = /threw after (\d+) ms, (\d+) attempts/.exec(r.stdout)!.map(Number);
    expect(ms).toBeLessThan(1500); // the deadline was 300 ms: a pause of seconds between attempts would run far past it
    expect(attempts).toBeGreaterThanOrEqual(3); // it does retry (another starter may have been first), about once per 50 ms
    expect(attempts).toBeLessThan(40); // about one attempt per 50 ms in the 300 ms it was given: a loop that never sleeps would make thousands and pin a core
  });

  it.each([["linux", true], ["darwin", true], ["win32", false]])("flushes the data folder itself on %s: %s (Windows cannot flush a directory handle)", (platform, flushes) => {
    const file = script("dir-fsync.js", `
      const fs = require("fs"), path = require("path"), os = require("os");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dir-fsync-")); // before the platform is faked: os.tmpdir() would answer for Windows
      const opened = [];
      const real = fs.openSync;
      fs.openSync = function (p, ...rest) { try { if (fs.statSync(p).isDirectory()) opened.push(path.resolve(String(p))); } catch {} return real.call(fs, p, ...rest); };
      Object.defineProperty(process, "platform", { value: process.argv[3] });
      const { ABTestingFramework } = require(process.argv[2]);
      new ABTestingFramework(path.join(dir, "e.yaml"), path.join(dir, "ab-data.jsonl"), { fsync: true }).close();
      console.log(JSON.stringify({ flushedTheFolder: opened.includes(path.resolve(dir)) }));
    `);
    const r = spawnSync(process.execPath, [file, abModule, platform], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH ?? "" } });
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual({ flushedTheFolder: flushes });
  });
});

