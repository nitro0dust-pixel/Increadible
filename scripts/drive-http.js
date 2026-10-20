#!/usr/bin/env node
/**
 * Drives the server over HTTP. Two modes:
 *   self-contained (default): starts dist/src/index.js on a free loopback port with a random bearer token and its own data directory,
 *       checks /ready, /health, the refusal of a request without the token, the handshake, a scenario, /metrics and the SIGTERM shutdown;
 *   --url URL: drives a server that is already running (a container, a Railway service, a port-forward). The token is read from the
 *       environment variable named by --token-env, never from the command line. Steps that write data (A/B) are skipped unless --allow-writes.
 *   node scripts/drive-http.js [--scenario basic] [--root DIR] [--data-dir DIR] [--env NAME=VALUE]... [--json] [--keep] [--timeout-ms N]
 *   node scripts/drive-http.js --url http://127.0.0.1:3000 [--token-env NAME] [--allow-writes] [--scenario basic] [--json]
 * Exit code: 0 every check passed, 1 a check failed, 2 the driver could not run. Run `npm run build` first for the self-contained mode. docs/DRIVERS.md.
 */
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./drive-lib.js");

const USAGE = [
  "usage: drive-http.js [--scenario NAME|FILE] [--root DIR] [--data-dir DIR] [--env NAME=VALUE]... [--json] [--keep] [--timeout-ms N]",
  "       drive-http.js --url URL [--token-env NAME] [--allow-writes] [--scenario NAME|FILE] [--json] [--timeout-ms N]",
  "       (--ready-timeout-ms N, how long to wait for /ready, takes both modes; the default is 15000)",
].join("\n");

/** One HTTP check as a report step; what it saw is the summary only when it held. */
async function httpStep(name, fn) {
  const started = Date.now();
  const problems = [];
  let summary = "ok";
  try {
    const out = await fn(problems);
    if (typeof out === "string") summary = out;
  } catch (error) {
    problems.push(error.message);
    summary = "no answer";
  }
  return lib.driverStep(name, problems, problems.length ? (summary === "no answer" ? summary : "different") : summary, Date.now() - started);
}

/** The sum of increadible_tool_calls_total over all tools, from the text /metrics serves. */
function toolCalls(text) {
  let sum = 0;
  for (const m of text.matchAll(/^increadible_tool_calls_total\{[^}]*\} (\d+(?:\.\d+)?)/gm)) sum += Number(m[1]);
  return sum;
}

/** The URL of a running server: an origin only. A path prefix would be dropped silently and credentials would end up in a report. */
function parseRemote(text) {
  let url;
  try { url = new URL(text); } catch { throw new lib.UsageError("--url is not a URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new lib.UsageError(`--url must be http or https, got ${url.protocol}`);
  if (url.username || url.password) throw new lib.UsageError("--url must not carry a user name or password: give the token with --token-env");
  if (url.pathname !== "/" || url.search || url.hash) throw new lib.UsageError("--url must be the server's address only (scheme, host, port): the drivers use its /mcp, /ready, /health and /metrics themselves");
  return url.origin;
}

async function main(argv) {
  const opts = lib.parseArgs(argv, {
    string: ["scenario", "root", "data-dir", "env", "timeout-ms", "ready-timeout-ms", "url", "token-env"],
    boolean: ["json", "keep", "help", "allow-writes"],
    repeat: ["env"],
  });
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts._.length) throw new lib.UsageError(`unexpected argument "${opts._[0]}"`);

  // everything that can be wrong with the command line is found before anything is started or created
  const scenario = lib.loadScenario(opts.scenario || "basic");
  const timeoutMs = opts["timeout-ms"] !== undefined ? lib.parseInteger("timeout-ms", opts["timeout-ms"]) : 20000;
  const readyMs = opts["ready-timeout-ms"] !== undefined ? lib.parseInteger("ready-timeout-ms", opts["ready-timeout-ms"]) : 15000;
  const remote = opts.url !== undefined;
  if (remote && scenario.scope === "own-server") throw new lib.UsageError(`the scenario "${scenario.name}" changes what the server holds beyond its own test data (its scope is "own-server"): it runs only against a server the driver starts itself, never with --url`);
  if (remote && (opts["data-dir"] || opts.env || opts.root || opts.keep)) throw new lib.UsageError("--data-dir, --env, --root and --keep belong to the self-contained mode; with --url the server is already running");
  if (!remote && (opts["token-env"] || opts["allow-writes"])) throw new lib.UsageError("--token-env and --allow-writes belong to --url");
  const extra = remote ? {} : lib.parseEnvPairs(opts.env);
  lib.assertNoLive(extra, "--env");

  const notes = [`node: ${process.version}`];
  let baseUrl;
  let token;
  let root;
  let entry;
  let version;
  if (remote) {
    baseUrl = parseRemote(opts.url);
    if (opts["token-env"]) {
      token = process.env[opts["token-env"]];
      if (!token) throw new lib.UsageError(`--token-env ${opts["token-env"]} names a variable that is not set or is empty`);
    }
    notes.push(`server: already running; token ${token ? `from ${opts["token-env"]}` : "none"}`, `writes: ${opts["allow-writes"] ? "allowed" : "skipped"}`);
    const host = new URL(baseUrl).hostname;
    if (token && baseUrl.startsWith("http:") && !["127.0.0.1", "localhost", "[::1]"].includes(host)) notes.push("warning: the token is sent over plain http to an address that is not this machine");
  } else {
    root = path.resolve(opts.root || lib.REPO_ROOT);
    entry = lib.entryPoint(root, "index.js");
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  }

  const own = !remote && !opts["data-dir"];
  const dir = remote ? undefined : own ? lib.makeWorkdir() : path.resolve(opts["data-dir"]);
  let proc;
  const steps = [];
  let serverInfo;
  let secrets = [];
  try {
    let env = {};
    if (!remote) {
      if (!own) fs.mkdirSync(dir, { recursive: true });
      else if (opts.keep) lib.keepWorkdir(dir);
      const port = await lib.freePort();
      token = crypto.randomBytes(18).toString("hex");
      baseUrl = `http://127.0.0.1:${port}`;
      env = lib.baseEnv({ ...lib.dataEnv(dir), ...extra, PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: token });
      secrets = lib.secretValues(env, [token]);
      proc = new lib.ManagedProcess({ args: [entry], env, cwd: root, secrets });
      notes.push(`server: started by the driver: ${entry}`, `data directory: ${dir}${own ? (opts.keep ? " (kept)" : " (removed afterwards)") : ""}`, `server environment: ${lib.describeEnv(env).join(", ")}`);
    } else if (token) secrets = [token];
    const client = new lib.HttpClient({ baseUrl, token, timeoutMs, secrets });

    steps.push(await httpStep("ready", async () => {
      await client.waitReady(readyMs, () => !proc || proc.exit === null);
      return "GET /ready 200";
    }));
    if (steps[0].ok) {
      steps.push(await httpStep("health", async (problems) => {
        const res = await client.request("GET", "/health", { auth: false });
        if (res.status !== 200) problems.push(`GET /health answered ${res.status}`);
        else if (!res.json || res.json.status !== "ok") problems.push(`GET /health body is not {"status":"ok"}: ${res.text.slice(0, 80)}`);
        return "GET /health 200";
      }));
      if (token) {
        steps.push(await httpStep("auth: a request without the token is refused", async (problems) => {
          const res = await client.request("POST", "/mcp", { auth: false, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
          if (res.status !== 401) problems.push(`expected 401, got ${res.status}`);
          return `HTTP ${res.status}`;
        }));
      }
      const started = Date.now();
      try {
        const init = await client.initialize();
        serverInfo = init.serverInfo;
        steps.push(lib.handshakeStep(init, version, Date.now() - started));
      } catch (error) {
        steps.push(lib.driverStep("handshake", [lib.redact(error.message, secrets)], "no handshake", Date.now() - started));
      }
      if (steps[steps.length - 1].ok) {
        const skipWrites = remote && !opts["allow-writes"];
        let before; // the tool-call counter before the scenario: the check is that THIS run's calls moved it
        if (token) { try { before = toolCalls((await client.request("GET", "/metrics")).text); } catch { before = undefined; } }
        const ran = await lib.runScenario(client, scenario, { secrets, vars: { run_id: lib.newRunId() }, skipWrites });
        steps.push(...ran.steps);
        const toolSteps = scenario.steps.filter((s) => (s.tool !== undefined || s.method === "tools/call") && !(skipWrites && lib.isWrite(s))).length;
        if (token && toolSteps > 0) {
          steps.push(await httpStep("metrics: the calls were counted", async (problems) => {
            const res = await client.request("GET", "/metrics");
            if (res.status !== 200) problems.push(`GET /metrics answered ${res.status}`);
            else if (before === undefined) problems.push("could not read /metrics before the scenario to compare with");
            else if (!(toolCalls(res.text) > before)) problems.push(`increadible_tool_calls_total did not grow during the scenario (before ${before}, after ${toolCalls(res.text)})`);
            return "GET /metrics 200";
          }));
        }
      }
    }
  } finally {
    if (proc) {
      const ended = await proc.stop({ stdinFirst: false, graceMs: 5000 });
      const problems = [];
      if (ended.how !== "SIGTERM") problems.push(`the server did not leave on SIGTERM (it needed ${ended.how})`);
      else if (ended.code !== 0) problems.push(`the server left with code ${ended.code} after SIGTERM, expected 0`);
      steps.push(lib.driverStep("shutdown", problems, problems.length ? "not clean" : "exit 0 on SIGTERM"));
    }
    if (own && !opts.keep) lib.tryRemoveWorkdir(dir);
  }
  const results = [{ scenario: scenario.name, ok: steps.every((s) => s.ok), steps }];
  const ok = results[0].ok;
  if (opts.json) console.log(JSON.stringify({ driver: "http", ok, target: baseUrl, server: serverInfo, notes, results, serverStderr: proc ? proc.stderrText() : undefined }, null, 2));
  else {
    console.log(lib.formatReport({ driver: "http", target: baseUrl, results, notes }));
    if (!ok && proc && proc.stderr) console.log(`\nserver stderr (last lines):\n${proc.stderrText()}`);
  }
  return ok ? 0 : 1;
}

module.exports = { main, USAGE, parseRemote, toolCalls };

if (require.main === module) lib.runCli("drive-http", USAGE, main);
