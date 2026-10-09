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
function start(env: Record<string, string>, args: string[] = []): Promise<Running> {
  const child = spawn(process.execPath, [entry, ...args], {
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

describe("what the server says when it starts", () => {
  it("names the address it listens on", async () => {
    const port = await freePort();
    const server = await start({ PORT: String(port), HOST: "127.0.0.1" });
    expect(server.stderr()).toContain(`increadible listening on http://127.0.0.1:${port}`);
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
