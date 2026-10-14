/**
 * The shared part of the request drivers (scripts/drive-stdio.js, drive-http.js, drive-probe.js, drive-bundle.js): start the
 * built server the way a client does, send JSON-RPC, check the answers against a scenario file, print a report, stop the server.
 * Zero dependencies; nothing here is imported by the server. How to run each driver: docs/DRIVERS.md.
 *
 * What the library does NOT do: it never prints a secret. The environment it hands the server is printed as names (and values only
 * for the few settings that are not sensitive), and every text that leaves it (report, server stderr, responses) has the secrets it
 * knows about replaced by <hidden>.
 */
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCENARIO_DIR = path.join(__dirname, "drive-scenarios");
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const WORKDIR_PREFIX = "increadible-drive-";

/** Variables a child process inherits from the caller. Nothing else is passed on, so no token of the caller's reaches the server. */
const INHERITED_ENV = ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL"];
/** Settings whose value may be printed; every other variable is shown as "(set)". */
const PRINTABLE_ENV = new Set(["PORT", "HOST", "AB_FSYNC", "AB_LAZY_OPEN", "GATEWAY_LIVE_APIS", "ALLOW_UNAUTHENTICATED", "RATE_LIMIT_PER_MINUTE"]);
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)/i;

// ---------------------------------------------------------------- environment and secrets

function baseEnv(extra) {
  const env = {};
  for (const name of INHERITED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

/** One line per variable: the name, and the value only where it is not sensitive. A path to a file in the work directory is printed by the caller. */
function describeEnv(env, printable = PRINTABLE_ENV) {
  return Object.keys(env).sort().map((name) => (printable.has(name) && !SECRET_NAME.test(name) ? `${name}=${env[name]}` : `${name} (set)`));
}

/** The values of the variables that look like secrets (or that the caller names), for redact(). Short values are not worth hiding and would mangle the text. */
function secretValues(env, extra = []) {
  const values = Object.entries(env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => String(value));
  return [...values, ...extra].filter((v) => v.length >= 4);
}

function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets || []) out = out.split(secret).join("<hidden>");
  return out;
}

// ---------------------------------------------------------------- work directory

/** A fresh directory for the data files of one run. Only a directory this function made (by its prefix) is ever removed. */
function makeWorkdir(parent = os.tmpdir()) {
  return fs.mkdtempSync(path.join(parent, WORKDIR_PREFIX));
}

function removeWorkdir(dir) {
  if (!dir || !path.basename(dir).startsWith(WORKDIR_PREFIX)) throw new Error(`refusing to remove a directory this driver did not create: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The data-file settings the server needs, all inside one directory. AB_FSYNC off keeps a driver run fast; the bundle driver uses the manifest's own values instead. */
function dataEnv(dir) {
  return {
    RULES_FILE: path.join(dir, "rules.yaml"),
    EXPERIMENTS_FILE: path.join(dir, "experiments.yaml"),
    AB_DATA_FILE: path.join(dir, "ab-data.jsonl"),
    AB_FSYNC: "false",
    AB_LAZY_OPEN: "true",
  };
}

function entryPoint(root, name) {
  const file = path.join(root, "dist", "src", name);
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: run "npm run build" in ${root} first`);
  return file;
}

// ---------------------------------------------------------------- a managed child process

const OUTPUT_LIMIT = 256 * 1024;

class ManagedProcess {
  constructor({ command = process.execPath, args = [], env, cwd, secrets = [] }) {
    this.secrets = secrets;
    this.stdout = "";
    this.stderr = "";
    this.exit = null; // { code, signal } once the process has ended
    this.child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error) => { this.stderr += `spawn error: ${error.message}\n`; this.exit = this.exit || { code: null, signal: null }; resolve(this.exit); });
      this.child.once("close", (code, signal) => { this.exit = { code, signal }; resolve(this.exit); });
    });
    this.child.stdin.on("error", () => { /* the server ended first: the answer to a write is its exit, reported by exited */ });
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-OUTPUT_LIMIT); });
    this.child.stdout.on("data", (chunk) => { if (this.onStdout) this.onStdout(chunk); else this.stdout = (this.stdout + chunk).slice(-OUTPUT_LIMIT); });
  }

  get pid() { return this.child.pid; }

  /** Ends the process, politely first. stdin first for a stdio server (that is how a client says goodbye), SIGTERM otherwise, SIGKILL last. Returns how it ended. */
  async stop({ stdinFirst = false, graceMs = 3000 } = {}) {
    // the timer is cleared when the process ends first: a timer left running would hold the driver open for the whole grace period
    const waitFor = (ms) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
    if (this.exit) return { how: "already exited", ...this.exit };
    if (stdinFirst) {
      this.child.stdin.end();
      if (await waitFor(graceMs)) return { how: "stdin closed", ...this.exit };
    }
    this.child.kill("SIGTERM");
    if (await waitFor(graceMs)) return { how: "SIGTERM", ...this.exit };
    this.child.kill("SIGKILL");
    await waitFor(graceMs);
    return { how: "SIGKILL", ...(this.exit || { code: null, signal: "SIGKILL" }) };
  }

  stderrText(maxBytes = 4000) {
    return redact(this.stderr.slice(-maxBytes), this.secrets);
  }
}

// ---------------------------------------------------------------- stdio client

/** A JSON-RPC client over a child's stdin/stdout: one JSON object per line, as Claude Desktop does it. */
class StdioClient {
  constructor({ args, command, env, cwd, requestTimeoutMs = 20000, secrets = [], protocolVersion = DEFAULT_PROTOCOL_VERSION }) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.protocolVersion = protocolVersion;
    this.secrets = secrets;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.nonJsonLines = []; // stdout lines that are not JSON: a protocol violation, since stdout belongs to the protocol
    this.unmatched = []; // JSON-RPC answers nobody is waiting for (a reply to a raw line, to a string id, an answer to nothing)
    this._unmatchedWaiter = null;
    this.serverMessages = []; // messages that carry a method (notifications or requests from the server)
    this.proc = new ManagedProcess({ command, args, env, cwd, secrets });
    this.proc.onStdout = (chunk) => this._onStdout(chunk);
    this.proc.exited.then(() => this._rejectAll(new Error(`the server exited (${this._exitText()}) before answering`)));
  }

  _exitText() {
    const e = this.proc.exit || {};
    return e.signal ? `signal ${e.signal}` : `code ${e.code}`;
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let at;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim() === "") continue;
      let message;
      try { message = JSON.parse(line); } catch { this.nonJsonLines.push(redact(line, this.secrets).slice(0, 300)); continue; }
      if (message && typeof message === "object" && message.method !== undefined) { this.serverMessages.push(message); continue; }
      const waiter = message && this.pending.get(message.id);
      if (waiter) { this.pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); } else {
        this.unmatched.push(JSON.parse(redact(line, this.secrets)));
        if (this._unmatchedWaiter) this._unmatchedWaiter();
      }
    }
  }

  _rejectAll(error) {
    for (const [id, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(error); this.pending.delete(id); }
  }

  /** Writes one raw line (for tests that send what a client should not). */
  sendRaw(text) {
    this.proc.child.stdin.write(`${text}\n`);
  }

  /** Waits for `count` answers that no request is waiting for (up to timeoutMs) and returns what arrived, emptying the list. */
  async takeUnmatched(count, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (this.unmatched.length < count && Date.now() < deadline) {
      await new Promise((resolve) => { this._unmatchedWaiter = resolve; setTimeout(resolve, 25); });
    }
    this._unmatchedWaiter = null;
    return this.unmatched.splice(0);
  }

  /** The id of the next request, so a caller can send it by hand. */
  allocateId() {
    return ++this.nextId;
  }

  _wait(id, label, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer to ${label} within ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** Sends a request and resolves with the JSON-RPC message that answers it (a result or an error). */
  request(method, params, timeoutMs) {
    if (this.proc.exit) return Promise.reject(new Error(`the server has exited (${this._exitText()})`));
    const id = this.allocateId();
    const answer = this._wait(id, method, timeoutMs);
    this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    return answer;
  }

  rpc(method, params) { return this.request(method, params); }

  notify(method, params) {
    this.sendRaw(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
  }

  /** The two-step start every client makes. Returns the initialize result. */
  async initialize(clientInfo = { name: "increadible-drive", version: "1" }) {
    const answer = await this.request("initialize", { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo });
    if (answer.error) throw new Error(`initialize failed: ${answer.error.code} ${answer.error.message}`);
    this.notify("notifications/initialized");
    return answer.result;
  }

  stop(graceMs) { return this.proc.stop({ stdinFirst: true, graceMs }); }
}

// ---------------------------------------------------------------- HTTP client

class HttpClient {
  constructor({ baseUrl, token, timeoutMs = 20000, secrets = [], protocolVersion = DEFAULT_PROTOCOL_VERSION }) {
    this.base = new URL(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.secrets = secrets;
    this.protocolVersion = protocolVersion;
    this.nextId = 0;
  }

  /** One HTTP exchange. Never throws on a status; throws on a network failure or a timeout. */
  request(method, pathname, { headers = {}, body, auth = true } = {}) {
    const url = new URL(pathname, this.base);
    const lib = url.protocol === "https:" ? https : http;
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const sent = { Connection: "close", ...headers };
    if (payload) sent["Content-Length"] = payload.length;
    if (auth && this.token) sent.Authorization = `Bearer ${this.token}`;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, headers: sent, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = redact(Buffer.concat(chunks).toString("utf8"), this.secrets);
          let json;
          try { json = JSON.parse(text); } catch { /* not JSON: text is what there is */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on("error", reject);
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`no answer to ${method} ${url.pathname} within ${this.timeoutMs} ms`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** POST one JSON-RPC request to /mcp. Resolves with the JSON-RPC message; throws if the answer is not one (a 401, a 404, an HTML page). */
  async rpc(method, params) {
    const id = ++this.nextId;
    const res = await this.request("POST", "/mcp", { headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) });
    if (res.json && res.json.jsonrpc === "2.0") return res.json;
    throw new Error(`HTTP ${res.status} without a JSON-RPC body: ${res.text.slice(0, 160)}`);
  }

  async notify(method, params) {
    return this.request("POST", "/mcp", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) });
  }

  async initialize(clientInfo = { name: "increadible-drive", version: "1" }) {
    const answer = await this.rpc("initialize", { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo });
    if (answer.error) throw new Error(`initialize failed: ${answer.error.code} ${answer.error.message}`);
    await this.notify("notifications/initialized");
    return answer.result;
  }

  /** Waits until GET /ready answers 200, or throws after timeoutMs. */
  async waitReady(timeoutMs = 15000, alive = () => true) {
    const deadline = Date.now() + timeoutMs;
    let last = "no answer";
    while (Date.now() < deadline) {
      if (!alive()) throw new Error("the server exited before it was ready");
      try {
        const res = await this.request("GET", "/ready", { auth: false });
        if (res.status === 200) return;
        last = `HTTP ${res.status}`;
      } catch (error) { last = error.message; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`/ready did not answer 200 within ${timeoutMs} ms (last: ${last})`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

// ---------------------------------------------------------------- scenarios

const STEP_KEYS = new Set(["name", "method", "params", "tool", "arguments", "expect", "save", "writes"]);
const EXPECT_KEYS = new Set(["rpc_error", "message_contains", "tool_error", "contains", "json", "result", "tools_include"]);
const MATCHERS = new Set(["$type", "$gte", "$lte", "$includes", "$matches", "$exists"]);

/** Throws, naming the file and the step, when a scenario would silently check nothing (a misspelled key, a step with no name). */
function validateScenario(scenario, where = "scenario") {
  const fail = (message) => { throw new Error(`${where}: ${message}`); };
  if (!scenario || typeof scenario !== "object") fail("not an object");
  if (typeof scenario.name !== "string" || scenario.name === "") fail('"name" is required');
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) fail('"steps" must be a non-empty array');
  const seen = new Set();
  scenario.steps.forEach((step, index) => {
    const at = `step ${index + 1}`;
    if (!step || typeof step !== "object") fail(`${at}: not an object`);
    if (typeof step.name !== "string" || step.name === "") fail(`${at}: "name" is required`);
    if (seen.has(step.name)) fail(`${at}: the name "${step.name}" is used twice`);
    seen.add(step.name);
    for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) fail(`${at} (${step.name}): unknown key "${key}"`);
    if ((step.method === undefined) === (step.tool === undefined)) fail(`${at} (${step.name}): exactly one of "method" and "tool" is required`);
    if (step.writes !== undefined && typeof step.writes !== "boolean") fail(`${at} (${step.name}): "writes" must be true or false`);
    const expect = step.expect || {};
    for (const key of Object.keys(expect)) if (!EXPECT_KEYS.has(key)) fail(`${at} (${step.name}): unknown expectation "${key}"`);
    for (const group of ["json", "result"]) {
      for (const [path_, wanted] of Object.entries(expect[group] || {})) {
        if (wanted && typeof wanted === "object" && !Array.isArray(wanted) && Object.keys(wanted).some((k) => k.startsWith("$")) && !Object.keys(wanted).every((k) => MATCHERS.has(k))) {
          fail(`${at} (${step.name}): unknown matcher in ${group}.${path_}`);
        }
      }
    }
  });
  return scenario;
}

function loadScenario(nameOrPath) {
  const file = fs.existsSync(nameOrPath) ? nameOrPath : path.join(SCENARIO_DIR, nameOrPath.endsWith(".json") ? nameOrPath : `${nameOrPath}.json`);
  if (!fs.existsSync(file)) throw new Error(`no scenario "${nameOrPath}" (looked for ${file})`);
  return validateScenario(JSON.parse(fs.readFileSync(file, "utf8")), path.basename(file));
}

function listScenarios() {
  return fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
}

/** "a.b.0.c" over objects and arrays. */
function getPath(value, dotted) {
  let current = value;
  for (const part of String(dotted).split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function typeOf(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** A literal compares by value (JSON equality); an object of $-keys is a matcher. Returns null when it matches, else the reason. */
function matchValue(actual, wanted) {
  const isMatcher = wanted && typeof wanted === "object" && !Array.isArray(wanted) && Object.keys(wanted).length > 0 && Object.keys(wanted).every((k) => k.startsWith("$"));
  if (!isMatcher) return JSON.stringify(actual) === JSON.stringify(wanted) ? null : `expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`;
  for (const [key, arg] of Object.entries(wanted)) {
    let ok;
    if (key === "$exists") ok = (actual !== undefined) === arg;
    else if (key === "$type") ok = typeOf(actual) === arg;
    else if (key === "$gte") ok = typeof actual === "number" && actual >= arg;
    else if (key === "$lte") ok = typeof actual === "number" && actual <= arg;
    else if (key === "$includes") ok = Array.isArray(actual) ? actual.some((x) => JSON.stringify(x) === JSON.stringify(arg)) : typeof actual === "string" && actual.includes(arg);
    else if (key === "$matches") ok = typeof actual === "string" && new RegExp(arg).test(actual);
    else return `unknown matcher ${key}`;
    if (!ok) return `expected ${key} ${JSON.stringify(arg)}, got ${JSON.stringify(actual)}`;
  }
  return null;
}

/** Replaces ${name} in every string of a value. A string that is exactly ${name} keeps the variable's own type. */
function substitute(value, vars) {
  if (typeof value === "string") {
    const whole = /^\$\{([A-Za-z0-9_]+)\}$/.exec(value);
    const lookup = (name) => { if (!(name in vars)) throw new Error(`unknown variable \${${name}} (no earlier step saved it)`); return vars[name]; };
    return whole ? lookup(whole[1]) : value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => String(lookup(name)));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

function toolText(result) {
  const first = result && Array.isArray(result.content) ? result.content[0] : undefined;
  return first && typeof first.text === "string" ? first.text : undefined;
}

/** Runs the steps of a scenario against a client (anything with rpc(method, params)). Never throws for a failed step; the step records the problems. */
async function runScenario(client, scenario, { secrets = [], onStep, vars: initialVars = {}, skipWrites = false } = {}) {
  const vars = { ...initialVars };
  const steps = [];
  for (const step of scenario.steps) {
    const started = Date.now();
    if (skipWrites && step.writes === true) {
      const skipped = { name: step.name, ok: true, skipped: true, ms: 0, summary: "skipped", problems: [], response: undefined };
      steps.push(skipped);
      if (onStep) onStep(skipped);
      continue;
    }
    const problems = [];
    let message;
    let summary = "";
    try {
      const method = step.tool !== undefined ? "tools/call" : step.method;
      const params = step.tool !== undefined ? { name: step.tool, arguments: substitute(step.arguments ?? {}, vars) } : substitute(step.params ?? {}, vars);
      message = await client.rpc(method, params);
      const expect = substitute(step.expect || {}, vars); // the expectations may name a variable too (the run id, a saved value)
      let base; // what json/save look at: the parsed text of a tool answer, or the result itself
      if (expect.rpc_error !== undefined) {
        if (!message.error) problems.push(`expected JSON-RPC error ${expect.rpc_error}, got a result`);
        else {
          summary = `error ${message.error.code}`;
          if (message.error.code !== expect.rpc_error) problems.push(`expected JSON-RPC error ${expect.rpc_error}, got ${message.error.code} (${message.error.message})`);
          if (expect.message_contains !== undefined && !String(message.error.message).includes(expect.message_contains)) problems.push(`error message does not contain "${expect.message_contains}": ${message.error.message}`);
        }
      } else if (message.error) {
        problems.push(`unexpected JSON-RPC error ${message.error.code}: ${message.error.message}`);
        summary = `error ${message.error.code}`;
      } else {
        const result = message.result;
        base = result;
        if (step.tool !== undefined || method === "tools/call") {
          const isError = result && result.isError === true;
          const wantError = expect.tool_error === true;
          summary = isError ? "tool error" : "ok";
          if (isError !== wantError) problems.push(wantError ? "expected a tool error (isError true), got a success" : `unexpected tool error: ${String(toolText(result)).slice(0, 200)}`);
          const text = toolText(result);
          if (expect.contains !== undefined && !(text || "").includes(expect.contains)) problems.push(`tool text does not contain "${expect.contains}": ${String(text).slice(0, 200)}`);
          if (expect.json !== undefined || (step.save && !isError)) {
            try { base = JSON.parse(text); } catch { problems.push(`tool text is not JSON: ${String(text).slice(0, 120)}`); base = undefined; }
          }
          if (isError && expect.json === undefined) base = undefined;
          if (expect.json && base !== undefined) {
            for (const [p, wanted] of Object.entries(expect.json)) { const why = matchValue(getPath(base, p), wanted); if (why) problems.push(`json.${p}: ${why}`); }
          }
        } else summary = "ok";
        for (const [p, wanted] of Object.entries(expect.result || {})) { const why = matchValue(getPath(result, p), wanted); if (why) problems.push(`result.${p}: ${why}`); }
        if (expect.tools_include) {
          const names = ((result && result.tools) || []).map((t) => t.name);
          const missing = expect.tools_include.filter((n) => !names.includes(n));
          if (missing.length) problems.push(`tools/list lacks: ${missing.join(", ")}`);
        }
        if (step.save && base !== undefined) {
          for (const [name, p] of Object.entries(step.save)) {
            const value = getPath(base, p);
            if (value === undefined) problems.push(`save ${name}: nothing at ${p}`); else vars[name] = value;
          }
        } else if (step.save) problems.push("save: there is nothing to save from this answer");
      }
    } catch (error) {
      problems.push(redact(error.message, secrets));
      summary = summary || "no answer";
    }
    const entry = { name: step.name, ok: problems.length === 0, ms: Date.now() - started, summary, problems, response: message === undefined ? undefined : JSON.parse(redact(JSON.stringify(message), secrets)) };
    steps.push(entry);
    if (onStep) onStep(entry);
  }
  return { scenario: scenario.name, ok: steps.every((s) => s.ok), steps };
}

// ---------------------------------------------------------------- report

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** A table of the steps, then one line per problem and a verdict. Plain text: it is read in a terminal. */
function formatReport({ driver, target, results, notes = [] }) {
  const lines = [`driver: ${driver}`, `target: ${target}`];
  for (const note of notes) lines.push(note);
  let failed = 0;
  let total = 0;
  let skipped = 0;
  for (const result of results) {
    lines.push("", `scenario: ${result.scenario}`);
    const width = Math.max(4, ...result.steps.map((s) => s.name.length));
    result.steps.forEach((s, i) => {
      if (s.skipped) skipped += 1; else total += 1;
      if (!s.ok) failed += 1;
      lines.push(`  ${pad(i + 1, 3)} ${pad(s.name, width)}  ${s.skipped ? "SKIP" : !s.ok ? "FAIL" : s.status || "PASS"}  ${pad(s.summary, 22)} ${s.skipped ? "" : `${s.ms} ms`}`.trimEnd());
      for (const problem of s.problems) lines.push(`        - ${problem}`);
      for (const note of s.notes || []) lines.push(`        . ${note}`);
    });
  }
  const known = results.reduce((n, r) => n + r.steps.filter((s) => s.ok && s.status === "KNOWN").length, 0);
  const tail = `${skipped ? ` (${skipped} skipped: they write data)` : ""}${known ? ` (${known} KNOWN: recorded deviations from the MCP spec, behaviour unchanged)` : ""}`;
  lines.push("", failed === 0 ? `PASS ${total}/${total}${tail}` : `FAIL ${failed} of ${total} steps${tail}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- a whole stdio run

/** A step the driver itself adds around a scenario (handshake, shutdown, clean stdout). Same shape as a scenario step's result. */
function driverStep(name, problems, summary, ms = 0, status, notes) {
  return { name, ok: problems.length === 0, ms, summary, problems, response: undefined, ...(status ? { status } : {}), ...(notes ? { notes } : {}) };
}

function handshakeStep(init, expectVersion, ms) {
  const problems = [];
  const info = init && init.serverInfo;
  if (!info || info.name !== "increadible") problems.push(`serverInfo.name should be "increadible", got ${JSON.stringify(info && info.name)}`);
  if (expectVersion !== undefined && (!info || info.version !== expectVersion)) problems.push(`serverInfo.version should be ${expectVersion}, got ${JSON.stringify(info && info.version)}`);
  if (typeof (init && init.protocolVersion) !== "string") problems.push("no protocolVersion in the initialize result");
  if (!init || !init.capabilities || typeof init.capabilities.tools !== "object") problems.push("capabilities.tools is missing");
  return driverStep("handshake", problems, problems.length ? "wrong" : `${info.name} ${info.version}`, ms);
}

/**
 * Starts a server on stdio, performs the handshake, runs the scenario, ends the server the way a client does and checks how it ended.
 * One function for the stdio driver and the bundle driver, so both are held to the same checks.
 */
async function driveStdio({ command, args, env, cwd, scenario, vars, skipWrites = false, secrets = [], requestTimeoutMs = 20000, expectVersion, protocolVersion, onStep }) {
  const client = new StdioClient({ command, args, env, cwd, requestTimeoutMs, secrets, protocolVersion });
  const steps = [];
  let serverInfo;
  try {
    const started = Date.now();
    let handshakeOk = false;
    try {
      const init = await client.initialize();
      serverInfo = init.serverInfo;
      const step = handshakeStep(init, expectVersion, Date.now() - started);
      steps.push(step);
      handshakeOk = step.ok;
    } catch (error) {
      steps.push(driverStep("handshake", [redact(error.message, secrets), `server stderr: ${client.proc.stderrText(600) || "(empty)"}`], "no handshake", Date.now() - started));
    }
    if (handshakeOk) steps.push(...(await runScenario(client, scenario, { secrets, vars, skipWrites, onStep })).steps);
  } finally {
    const ended = await client.stop(4000);
    const problems = [];
    if (ended.how !== "stdin closed") problems.push(`the server did not leave when stdin closed (it needed ${ended.how})`);
    else if (ended.code !== 0) problems.push(`the server left with code ${ended.code}, expected 0`);
    steps.push(driverStep("shutdown", problems, problems.length ? "not clean" : "exit 0 on stdin close"));
    const stray = [...client.nonJsonLines.map((line) => `stdout line that is not JSON: ${line}`), ...client.unmatched.map((m) => `an answer nobody asked for: ${JSON.stringify(m).slice(0, 200)}`)];
    steps.push(driverStep("stdout is protocol only", stray, stray.length ? `${stray.length} stray` : "clean"));
  }
  return { results: [{ scenario: scenario.name, ok: steps.every((s) => s.ok), steps }], serverInfo, stderr: client.proc.stderrText() };
}

// ---------------------------------------------------------------- command line

/** --name value, --flag; anything else is an error. spec: { string: [...], boolean: [...] }. */
function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const name = arg.slice(2);
    if ((spec.boolean || []).includes(name)) out[name] = true;
    else if ((spec.string || []).includes(name)) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      const value = argv[(i += 1)];
      if ((spec.repeat || []).includes(name)) (out[name] = out[name] || []).push(value); else out[name] = value;
    } else throw new UsageError(`unknown option --${name}`);
  }
  return out;
}

/** KEY=VALUE pairs given with --env, as an object. The names are checked; the values are never printed. */
function parseEnvPairs(pairs = [], flag = "--env") {
  const env = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const name = at < 0 ? "" : pair.slice(0, at);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError(`${flag} expects NAME=VALUE, got "${pair.split("=")[0]}"`);
    env[name] = pair.slice(at + 1);
  }
  return env;
}

class UsageError extends Error {}

/** Runs a driver's main(argv) and turns its answer into the exit code: 0 all passed, 1 a check failed, 2 the driver could not run. */
async function runCli(name, usage, main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`${name}: ${error.message}`);
    if (error instanceof UsageError) console.error(usage);
    process.exitCode = 2;
  }
}

/** A short unique id for one run, used in the names of what a scenario creates. */
function newRunId() {
  return `${Date.now().toString(36)}${process.pid.toString(36)}`;
}

module.exports = {
  REPO_ROOT, SCENARIO_DIR, DEFAULT_PROTOCOL_VERSION, WORKDIR_PREFIX, INHERITED_ENV, SECRET_NAME,
  baseEnv, describeEnv, secretValues, redact,
  makeWorkdir, removeWorkdir, dataEnv, entryPoint,
  ManagedProcess, StdioClient, HttpClient, freePort,
  validateScenario, loadScenario, listScenarios, getPath, matchValue, substitute, runScenario, formatReport,
  driverStep, handshakeStep, driveStdio,
  parseArgs, parseEnvPairs, UsageError, runCli, newRunId,
};
