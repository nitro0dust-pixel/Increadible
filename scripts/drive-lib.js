/**
 * The shared part of the request drivers (scripts/drive-stdio.js, drive-http.js, drive-probe.js, drive-bundle.js): start the
 * built server the way a client does, send JSON-RPC, check the answers against a scenario file, print a report, stop the server.
 * Zero dependencies; nothing here is imported by the server. How to run each driver: docs/DRIVERS.md.
 *
 * Secrets: the environment it hands the server is printed as names (and values only for the few settings that are not sensitive), and
 * every text the library prints that came from a server (stderr, answers, problems) has the secrets it KNOWS about (the values of
 * variables whose names look secret, the random token, a token given with --token-env; four characters or more) replaced by <hidden>,
 * and control characters other than tab and line breaks replaced by "?", so a server cannot steer the terminal. A secret it was not
 * told about cannot be hidden.
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

/** Control characters other than tab, line feed and carriage return: what an escape sequence is made of. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Control characters (also the C1 range some terminals obey) replaced by "?". Applied to everything a server sent before it is printed. */
function scrub(text) {
  return String(text).replace(CONTROL, "?");
}

/** Each secret as it is, and as it reads inside a JSON string (a server may echo it escaped), longest first so a longer secret is not left half visible. */
function secretForms(secrets) {
  const forms = new Set();
  for (const secret of secrets || []) {
    if (!secret) continue;
    forms.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.add(escaped);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Hides the secrets it is told about and scrubs control characters. Redact BEFORE cutting a text short: a cut can split a secret so that it no longer matches. */
function redact(text, secrets) {
  let out = String(text);
  for (const secret of secretForms(secrets)) out = out.split(secret).join("<hidden>");
  return scrub(out);
}

/** redact() over every string (and key) of a value, so a secret that needs escaping in JSON cannot corrupt the structure. */
function redactDeep(value, secrets) {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets), redactDeep(v, secrets)]));
  return value;
}

// ---------------------------------------------------------------- what a run has open: children and work directories

const live = { processes: new Set(), dirs: new Set() };

/** Last resort, synchronous: end every server this run started and remove every work directory it made. Runs when the driver exits for any reason. */
function cleanupNow() {
  const procs = [...live.processes];
  for (const proc of procs) { try { proc.child.kill("SIGTERM"); } catch { /* already gone */ } }
  if (procs.length) {
    // nothing can be awaited in an exit handler: give SIGTERM a moment, then make sure (a server that ignores SIGTERM must not be left running)
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); } catch { /* no wait available */ }
    for (const proc of procs) { try { proc.child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
  live.processes.clear();
  for (const dir of live.dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  live.dirs.clear();
}

let handlersInstalled = false;
/** Called by runCli only (never on import, so tests that import the library keep their own signal handling). */
function installCleanupHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", cleanupNow);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGHUP", () => process.exit(129)); // the terminal was closed or the ssh connection dropped
}

// ---------------------------------------------------------------- work directory

/** A fresh directory for the data files of one run. Only a directory this function made (by its prefix) is ever removed. */
function makeWorkdir(parent = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(parent, WORKDIR_PREFIX));
  live.dirs.add(dir);
  return dir;
}

function removeWorkdir(dir) {
  if (!dir || !path.basename(dir).startsWith(WORKDIR_PREFIX)) throw new Error(`refusing to remove a directory this driver did not create: ${dir}`);
  live.dirs.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** removeWorkdir for a finally block: a failure to remove (a file still open on Windows) is a warning on stderr, never a reason to lose the verdict. */
function tryRemoveWorkdir(dir) {
  try { removeWorkdir(dir); } catch (error) { console.error(`warning: could not remove ${dir}: ${error.message}`); }
}

/** The user asked to keep this directory (--keep): an interrupted run must not remove it either. */
function keepWorkdir(dir) {
  live.dirs.delete(dir);
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
const MAX_LINE = 64 * 1024 * 1024;

class ManagedProcess {
  constructor({ command = process.execPath, args = [], env, cwd, secrets = [] }) {
    this.secrets = secrets;
    this.stderr = "";
    this.exit = null; // { code, signal } once the process has ended
    this.child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    live.processes.add(this);
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error) => { this.stderr += `spawn error: ${error.message}\n`; this.exit = this.exit || { code: null, signal: null }; live.processes.delete(this); resolve(this.exit); });
      this.child.once("close", (code, signal) => { this.exit = { code, signal }; live.processes.delete(this); resolve(this.exit); });
    });
    this.child.stdin.on("error", () => { /* the server ended first: the answer to a write is its exit, reported by exited */ });
    // decoded as UTF-8 by a stream decoder, so a character split across two reads stays whole
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-OUTPUT_LIMIT); });
    this.child.stdout.on("data", (chunk) => { if (this.onStdout) this.onStdout(chunk); });
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
    return redact(this.stderr, this.secrets).slice(-maxBytes);
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
    if (this.buffer.length > MAX_LINE && this.buffer.indexOf("\n") < 0) { // a line that never ends is not kept in memory
      this.nonJsonLines.push(`a line longer than ${MAX_LINE} characters without a line break (first part: ${redact(this.buffer.slice(0, 80), this.secrets)})`);
      this.buffer = "";
      return;
    }
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
        this.unmatched.push(redactDeep(message, this.secrets));
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
    if (answer.error) throw new Error(`initialize failed: ${scrub(answer.error.code)} ${scrub(answer.error.message)}`);
    if (!isPlainObject(answer.result)) throw new Error("initialize was answered without a result object");
    this.notify("notifications/initialized");
    return answer.result;
  }

  stop(graceMs) { return this.proc.stop({ stdinFirst: true, graceMs }); }
}

// ---------------------------------------------------------------- HTTP client

class HttpClient {
  constructor({ baseUrl, token, timeoutMs = 20000, secrets = [], protocolVersion = DEFAULT_PROTOCOL_VERSION, maxBytes = 8 * 1024 * 1024 }) {
    this.base = new URL(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.secrets = secrets;
    this.protocolVersion = protocolVersion;
    this.nextId = 0;
  }

  /**
   * One HTTP exchange. Never throws on a status; throws on a network failure, on a timeout (a deadline for the whole exchange, not for
   * silence) and on an answer larger than maxBytes (a hostile server cannot fill the driver's memory).
   */
  request(method, pathname, { headers = {}, body, auth = true, timeoutMs = this.timeoutMs } = {}) {
    const url = new URL(pathname, this.base);
    const lib = url.protocol === "https:" ? https : http;
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const sent = { Connection: "close", ...headers };
    if (payload) sent["Content-Length"] = payload.length;
    if (auth && this.token) sent.Authorization = `Bearer ${this.token}`;
    return new Promise((resolve, reject) => {
      let timer;
      const fail = (error) => { clearTimeout(timer); reject(error); };
      const req = lib.request(url, { method, headers: sent, agent: false }, (res) => {
        const chunks = [];
        let size = 0;
        let overflow = null; // 'end' can still follow the destroy when the whole answer has already arrived: it must not turn into a result
        res.on("data", (c) => {
          size += c.length;
          if (overflow) return;
          if (size > this.maxBytes) { overflow = new Error(`the answer to ${method} ${url.pathname} is larger than ${this.maxBytes} bytes`); req.destroy(overflow); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          if (overflow) { fail(overflow); return; }
          clearTimeout(timer);
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          // parsed BEFORE the secrets are hidden (a secret that needs escaping in JSON would break the text), then hidden value by value
          try { json = redactDeep(JSON.parse(raw), this.secrets); } catch { /* not JSON: text is what there is */ }
          resolve({ status: res.statusCode, headers: res.headers, text: redact(raw, this.secrets), json });
        });
        res.on("error", fail);
        res.on("close", () => { if (!res.complete) fail(new Error(`the connection closed before the answer to ${method} ${url.pathname} was complete`)); });
      });
      req.on("error", fail); // before anything that can throw
      timer = setTimeout(() => req.destroy(new Error(`no answer to ${method} ${url.pathname} within ${timeoutMs} ms`)), timeoutMs);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** POST one JSON-RPC request to /mcp. Resolves with the JSON-RPC message; throws if the answer is not one (a 401, a 404, an HTML page). */
  async rpc(method, params) {
    const id = ++this.nextId;
    const res = await this.request("POST", "/mcp", { headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) });
    if (res.json && res.json.jsonrpc === "2.0") {
      if (res.json.id !== id) throw new Error(`the answer carries the id ${JSON.stringify(res.json.id)}, not ${id}: ${res.text.slice(0, 160)}`);
      return res.json;
    }
    throw new Error(`HTTP ${res.status} without a JSON-RPC body: ${res.text.slice(0, 160)}`);
  }

  async notify(method, params) {
    return this.request("POST", "/mcp", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) });
  }

  async initialize(clientInfo = { name: "increadible-drive", version: "1" }) {
    const answer = await this.rpc("initialize", { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo });
    if (answer.error) throw new Error(`initialize failed: ${scrub(answer.error.code)} ${scrub(answer.error.message)}`);
    if (!isPlainObject(answer.result)) throw new Error("initialize was answered without a result object");
    await this.notify("notifications/initialized");
    return answer.result;
  }

  /** Waits until GET /ready answers 200, or throws after timeoutMs (each attempt is held to the time that is left). */
  async waitReady(timeoutMs = 15000, alive = () => true) {
    const deadline = Date.now() + timeoutMs;
    let last = "no answer";
    while (Date.now() < deadline) {
      if (!alive()) throw new Error("the server exited before it was ready");
      try {
        const res = await this.request("GET", "/ready", { auth: false, timeoutMs: Math.max(50, Math.min(this.timeoutMs, deadline - Date.now())) });
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

const SCENARIO_KEYS = new Set(["name", "description", "steps"]);
const TYPE_NAMES = new Set(["string", "number", "boolean", "array", "object", "null"]);
const STEP_KEYS = new Set(["name", "method", "params", "tool", "arguments", "expect", "save", "writes"]);
const EXPECT_KEYS = new Set(["rpc_error", "message_contains", "tool_error", "contains", "json", "result", "tools_include"]);
const MATCHERS = new Set(["$type", "$gte", "$lte", "$includes", "$matches", "$exists"]);
const isToolStep = (step) => step.tool !== undefined || step.method === "tools/call";
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Throws, naming the file and the step, when a scenario would silently check nothing: a misspelled key, an expectation that this kind
 * of step can never evaluate (json on a method step, contains next to rpc_error), a value of the wrong type, a regular expression that
 * does not compile. A check that cannot fail is worse than no check, so none of these is let through.
 */
function validateScenario(scenario, where = "scenario") {
  const fail = (message) => { throw new Error(`${where}: ${message}`); };
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) fail("not an object");
  for (const key of Object.keys(scenario)) if (!SCENARIO_KEYS.has(key)) fail(`unknown key "${key}" (a scenario has: ${[...SCENARIO_KEYS].join(", ")})`);
  if (typeof scenario.name !== "string" || scenario.name === "") fail('"name" is required');
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) fail('"steps" must be a non-empty array');
  const seen = new Set();
  scenario.steps.forEach((step, index) => {
    const at = `step ${index + 1}`;
    if (!step || typeof step !== "object") fail(`${at}: not an object`);
    if (typeof step.name !== "string" || step.name === "") fail(`${at}: "name" is required`);
    if (seen.has(step.name)) fail(`${at}: the name "${step.name}" is used twice`);
    seen.add(step.name);
    const label = `${at} (${step.name})`;
    for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) fail(`${label}: unknown key "${key}"`);
    if ((step.method === undefined) === (step.tool === undefined)) fail(`${label}: exactly one of "method" and "tool" is required`);
    if (step.method !== undefined && typeof step.method !== "string") fail(`${label}: "method" must be a string`);
    if (step.tool !== undefined && typeof step.tool !== "string") fail(`${label}: "tool" must be a string`);
    if (step.tool !== undefined && step.params !== undefined) fail(`${label}: "params" belongs to a method step; a tool step takes "arguments"`);
    if (step.method !== undefined && step.arguments !== undefined) fail(`${label}: "arguments" belongs to a tool step; a method step takes "params"`);
    if (step.writes !== undefined && typeof step.writes !== "boolean") fail(`${label}: "writes" must be true or false`);
    if (step.save !== undefined && (!isPlainObject(step.save) || !Object.values(step.save).every((v) => typeof v === "string"))) fail(`${label}: "save" must map names to dotted paths`);
    if (step.expect !== undefined && !isPlainObject(step.expect)) fail(`${label}: "expect" must be an object`);
    const expect = step.expect || {};
    for (const key of Object.keys(expect)) if (!EXPECT_KEYS.has(key)) fail(`${label}: unknown expectation "${key}"`);
    if (expect.rpc_error !== undefined && !Number.isInteger(expect.rpc_error)) fail(`${label}: "rpc_error" must be an integer code`);
    if (expect.message_contains !== undefined && (typeof expect.message_contains !== "string" || expect.message_contains === "")) fail(`${label}: "message_contains" must be a non-empty string (an empty one is found in every text)`);
    if (expect.tool_error !== undefined && typeof expect.tool_error !== "boolean") fail(`${label}: "tool_error" must be true or false`);
    if (expect.contains !== undefined && (typeof expect.contains !== "string" || expect.contains === "")) fail(`${label}: "contains" must be a non-empty string (an empty one is found in every text)`);
    if (expect.tools_include !== undefined && (!Array.isArray(expect.tools_include) || expect.tools_include.length === 0 || !expect.tools_include.every((n) => typeof n === "string" && n !== ""))) fail(`${label}: "tools_include" must be a non-empty list of tool names`);
    for (const group of ["json", "result"]) {
      if (expect[group] !== undefined && (!isPlainObject(expect[group]) || Object.keys(expect[group]).length === 0)) fail(`${label}: "${group}" must map at least one dotted path to a value`);
      for (const [path_, wanted] of Object.entries(expect[group] || {})) {
        if (!isPlainObject(wanted) || !Object.keys(wanted).some((k) => k.startsWith("$"))) continue; // a plain value: compared as it is
        const where = `${label}: ${group}.${path_}`;
        if (!Object.keys(wanted).every((k) => MATCHERS.has(k))) fail(`${where}: unknown matcher (or a matcher mixed with plain keys)`);
        if (wanted.$type !== undefined && !TYPE_NAMES.has(wanted.$type)) fail(`${where}: $type must be one of ${[...TYPE_NAMES].join(", ")}`);
        for (const key of ["$gte", "$lte"]) if (wanted[key] !== undefined && !Number.isFinite(wanted[key])) fail(`${where}: ${key} must be a number`);
        if (wanted.$exists !== undefined && typeof wanted.$exists !== "boolean") fail(`${where}: $exists must be true or false`);
        if (wanted.$includes !== undefined && wanted.$includes === "") fail(`${where}: $includes must not be an empty string (it is found in every text)`);
        if (wanted.$matches !== undefined) {
          if (typeof wanted.$matches !== "string" || wanted.$matches === "") fail(`${where}: $matches must be a non-empty regular expression`);
          try { new RegExp(wanted.$matches); } catch (error) { fail(`${where}: $matches is not a regular expression (${error.message})`); }
        }
      }
    }
    // what each kind of step can evaluate
    if (expect.rpc_error !== undefined) {
      for (const key of ["tool_error", "contains", "json", "result", "tools_include"]) if (expect[key] !== undefined) fail(`${label}: "${key}" cannot go with "rpc_error" (an error answer has no result to check)`);
      if (step.save !== undefined) fail(`${label}: "save" cannot go with "rpc_error" (an error answer has nothing to save)`);
    } else if (expect.message_contains !== undefined) fail(`${label}: "message_contains" needs "rpc_error"`);
    if (!isToolStep(step)) {
      for (const key of ["tool_error", "contains", "json"]) if (expect[key] !== undefined) fail(`${label}: "${key}" applies to a tool step; a method step checks "result"`);
    }
    if (expect.tools_include !== undefined && step.method !== "tools/list") fail(`${label}: "tools_include" applies to the method "tools/list"`);
  });
  return scenario;
}

/** A name without a path separator or ".json" is a shipped scenario; anything else is a file path (never both: a file called "basic" cannot hide the shipped one). */
function loadScenario(nameOrPath) {
  const asPath = /[\\/]/.test(nameOrPath) || nameOrPath.endsWith(".json");
  const file = asPath ? path.resolve(nameOrPath) : path.join(SCENARIO_DIR, `${nameOrPath}.json`);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    throw new Error(error.code === "ENOENT" ? `no scenario "${nameOrPath}" (looked for ${file})` : `${file}: ${error.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`${file}: not valid JSON (${error.message})`); }
  return validateScenario(parsed, path.basename(file));
}

function listScenarios() {
  return fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
}

/** "a.b.0.c" over objects and arrays. */
function getPath(value, dotted) {
  let current = value;
  for (const part of String(dotted).split(".")) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function typeOf(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** JSON equality that does not depend on the order of an object's keys. */
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
}

/** A literal compares by value (JSON equality); an object of $-keys is a matcher. Returns null when it matches, else the reason. */
function matchValue(actual, wanted) {
  const isMatcher = wanted && typeof wanted === "object" && !Array.isArray(wanted) && Object.keys(wanted).length > 0 && Object.keys(wanted).every((k) => k.startsWith("$"));
  if (!isMatcher) return sameJson(actual, wanted) ? null : `expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`;
  for (const [key, arg] of Object.entries(wanted)) {
    let ok;
    if (key === "$exists") ok = (actual !== undefined) === arg;
    else if (key === "$type") ok = typeOf(actual) === arg;
    else if (key === "$gte") ok = typeof actual === "number" && actual >= arg;
    else if (key === "$lte") ok = typeof actual === "number" && actual <= arg;
    else if (key === "$includes") ok = Array.isArray(actual) ? actual.some((x) => sameJson(x, arg)) : typeof actual === "string" && actual.includes(arg);
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

/** What is wrong with a JSON-RPC answer as such, or null. Without this a step with no expectations passes on any answer at all. */
function malformed(message) {
  if (!isPlainObject(message)) return "the answer is not a JSON object";
  if (message.jsonrpc !== "2.0") return 'the answer does not say "jsonrpc": "2.0"';
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) return hasResult ? "the answer has both a result and an error" : "the answer has neither a result nor an error";
  if (hasResult && !isPlainObject(message.result)) return "the result is not an object";
  if (hasError && (!isPlainObject(message.error) || !Number.isInteger(message.error.code))) return "the error is not an object with an integer code";
  return null;
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
      const show = (text, n) => redact(String(text), secrets).slice(0, n); // hidden BEFORE it is cut, or the cut can leave half a secret
      const wrong = malformed(message);
      if (wrong) {
        problems.push(`${wrong}: ${show(JSON.stringify(message), 160)}`);
        summary = "malformed";
      } else if (expect.rpc_error !== undefined) {
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
          const isError = result.isError === true;
          const wantError = expect.tool_error === true;
          summary = isError ? "tool error" : "ok";
          if (!Array.isArray(result.content)) problems.push(`the tool answer has no content list: ${show(JSON.stringify(result), 160)}`);
          if (isError !== wantError) problems.push(wantError ? "expected a tool error (isError true), got a success" : `unexpected tool error: ${show(toolText(result), 200)}`);
          const text = toolText(result);
          if (expect.contains !== undefined && !(text || "").includes(expect.contains)) problems.push(`tool text does not contain "${expect.contains}": ${show(text, 200)}`);
          if (expect.json !== undefined || (step.save && !isError)) {
            try { base = JSON.parse(text); } catch { problems.push(`tool text is not JSON: ${show(text, 120)}`); base = undefined; }
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
    if (message === undefined && !problems.length) problems.push("the client returned no answer");
    // text that came from a server is scrubbed wherever it ends up: in a problem, in the summary, in the stored answer
    const entry = { name: step.name, ok: problems.length === 0, ms: Date.now() - started, summary: redact(summary, secrets), problems: problems.map((p) => redact(p, secrets)), response: message === undefined ? undefined : redactDeep(message, secrets) };
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
  return scrub(lines.join("\n"));
}

// ---------------------------------------------------------------- a whole stdio run

/** A step the driver itself adds around a scenario (handshake, shutdown, clean stdout). Same shape as a scenario step's result. */
function driverStep(name, problems, summary, ms = 0, status, notes) {
  // what a server said can end up in any of these (a version string, an answer): control characters never reach the terminal
  return { name, ok: problems.length === 0, ms, summary: scrub(summary), problems: problems.map(scrub), response: undefined, ...(status ? { status } : {}), ...(notes ? { notes: notes.map(scrub) } : {}) };
}

function handshakeStep(init, expectVersion, ms) {
  const problems = [];
  if (!isPlainObject(init)) return driverStep("handshake", ["initialize was answered without a result object"], "wrong", ms);
  const info = init.serverInfo;
  if (!isPlainObject(info) || info.name !== "increadible") problems.push(`serverInfo.name should be "increadible", got ${JSON.stringify(info && info.name)}`);
  if (expectVersion !== undefined && (!isPlainObject(info) || info.version !== expectVersion)) problems.push(`serverInfo.version should be ${expectVersion}, got ${JSON.stringify(info && info.version)}`);
  if (typeof (init && init.protocolVersion) !== "string") problems.push("no protocolVersion in the initialize result");
  if (!init || !init.capabilities || typeof init.capabilities.tools !== "object") problems.push("capabilities.tools is missing");
  return driverStep("handshake", problems, problems.length ? "wrong" : `${String(info.name)} ${String(info.version)}`, ms);
}

/**
 * Starts a server on stdio, performs the handshake, runs the scenario, ends the server the way a client does and checks how it ended.
 * One function for the stdio driver and the bundle driver, so both are held to the same checks.
 */
async function driveStdio({ command, args, env, cwd, scenario, vars, skipWrites = false, secrets = [], requestTimeoutMs = 20000, graceMs = 4000, expectVersion, protocolVersion, onStep }) {
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
    const ended = await client.stop(graceMs);
    const problems = [];
    if (ended.how !== "stdin closed") problems.push(`the server did not leave when stdin closed (it needed ${ended.how})`);
    else if (ended.code !== 0) problems.push(`the server left with code ${ended.code}, expected 0`);
    steps.push(driverStep("shutdown", problems, problems.length ? "not clean" : "exit 0 on stdin close"));
    const leftover = client.buffer.trim();
    const stray = [
      ...client.nonJsonLines.map((line) => `stdout line that is not JSON: ${line}`),
      ...client.unmatched.map((m) => `an answer nobody asked for: ${JSON.stringify(m).slice(0, 200)}`),
      ...(leftover ? [`stdout text without a line break at the end: ${redact(leftover, secrets).slice(0, 200)}`] : []),
    ];
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

/** A whole number option (milliseconds, a count): refuses text, zero, negatives and anything a timer cannot take, with exit code 2 instead of a stack trace. */
function parseInteger(name, text, { min = 1, max = 2147483647 } = {}) {
  const bad = () => new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  if (!/^\d+$/.test(String(text))) throw bad();
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw bad();
  return n;
}

/** These drivers never switch the gateway's live calls on: a live call goes to a real provider, which is Stage 4 and the owner's decision (docs/DRIVERS.md, section 10). */
function assertNoLive(env, source) {
  const live = Object.entries(env).find(([name]) => name.toUpperCase() === "GATEWAY_LIVE_APIS"); // Windows does not distinguish the case of a variable's name
  if (live && String(live[1] ?? "").trim() !== "") throw new UsageError(`${source}: GATEWAY_LIVE_APIS switches on calls to real providers, which these drivers do not make (live calls are Stage 4 and need the owner's decision)`);
}

/** Runs a driver's main(argv) and turns its answer into the exit code: 0 all passed, 1 a check failed, 2 the driver could not run. */
async function runCli(name, usage, main) {
  installCleanupHandlers();
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
  baseEnv, describeEnv, secretValues, scrub, redact, redactDeep, sameJson,
  makeWorkdir, removeWorkdir, tryRemoveWorkdir, keepWorkdir, dataEnv, entryPoint,
  cleanupNow, ManagedProcess, StdioClient, HttpClient, freePort,
  validateScenario, loadScenario, listScenarios, getPath, matchValue, substitute, runScenario, formatReport,
  driverStep, handshakeStep, driveStdio,
  parseArgs, parseEnvPairs, parseInteger, assertNoLive, UsageError, runCli, newRunId,
};
