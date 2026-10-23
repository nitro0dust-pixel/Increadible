#!/usr/bin/env node
/**
 * Runs every driver against every shipped scenario, side by side, and prints one table and one verdict: the deterministic part of the
 * multi-agent workflow (docs/DRIVERS-WORKFLOW.md), usable on its own, in CI or by hand.
 *   node scripts/drive-all.js [--only stdio,http,probe,bundle] [--scenario a,b] [--concurrency N] [--timeout-s N]
 *                             [--root DIR] [--bundle FILE] [--expect FILE | --no-expect] [--json] [--list]
 * Jobs: stdio, http and bundle once per scenario (all of scripts/drive-scenarios/ unless --scenario names some), and the probe once. Each job is one
 * driver process with its own port and work directory, started with --json; nothing is shared between them. Besides the drivers' own verdicts it
 * holds each job to the number of steps written in scripts/drive-expected.json (a driver that quietly runs fewer steps is a failure), and it fails
 * when a job leaves one of the drivers' work directories behind. Exit code: 0 every job passed, 1 a check failed (or a job timed out or left
 * something behind), 2 nothing could be judged (a build or package is missing, bad options, or every job failed to start).
 * Zero dependencies; the shared parts are in scripts/drive-lib.js. Needs `npm run build` (and `npm run mcpb` for the bundle jobs).
 */
"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("./drive-lib.js");

const USAGE = [
  "usage: drive-all.js [--only stdio,http,probe,bundle] [--scenario a,b] [--concurrency N] [--timeout-s N]",
  "                    [--root DIR] [--bundle FILE] [--expect FILE | --no-expect] [--json] [--list]",
].join("\n");
const DRIVERS = ["stdio", "http", "probe", "bundle"];
const DEFAULT_EXPECTED = path.join(__dirname, "drive-expected.json");
const MAX_OUTPUT = 16 * 1024 * 1024;

/** A comma-separated option as a list of non-empty names. */
function names(text, what, allowed) {
  const list = String(text).split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new lib.UsageError(`${what} needs at least one name`);
  if (allowed) for (const n of list) if (!allowed.includes(n)) throw new lib.UsageError(`${what}: "${n}" is not one of ${allowed.join(", ")}`);
  return [...new Set(list)];
}

/** The jobs to run: [{ id, driver, scenario, args }]. The probe has no scenario. */
function planJobs({ only = DRIVERS, scenarios, root, bundle } = {}) {
  const shipped = lib.listScenarios();
  const chosen = scenarios || shipped;
  for (const s of chosen) if (!shipped.includes(s)) throw new lib.UsageError(`--scenario: "${s}" is not a shipped scenario (${shipped.join(", ")})`);
  const jobs = [];
  for (const driver of DRIVERS) {
    if (!only.includes(driver)) continue;
    if (driver === "probe") {
      jobs.push({ id: "probe", driver, scenario: null, args: ["--json", ...(root ? ["--root", root] : [])] });
      continue;
    }
    for (const scenario of chosen) {
      const args = ["--scenario", scenario, "--json"];
      if (root && driver !== "bundle") args.push("--root", root);
      if (bundle && driver === "bundle") args.push("--bundle", bundle);
      jobs.push({ id: `${driver}:${scenario}`, driver, scenario, args });
    }
  }
  return jobs;
}

/** Reads the expected step counts: { "stdio:basic": 19, ... }. Returns {} for no file (--no-expect). */
function loadExpected(file) {
  if (file === null) return {};
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new Error(`${file}: ${error.code === "ENOENT" ? "no such file" : error.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.jobs || typeof parsed.jobs !== "object") throw new Error(`${file}: expected { "jobs": { "stdio:basic": 19, ... } }`);
  for (const [id, n] of Object.entries(parsed.jobs)) if (!Number.isInteger(n) || n < 1) throw new Error(`${file}: "${id}" must be a whole number of steps, 1 or more`);
  return parsed.jobs;
}

/** What one finished driver process says: the status and the facts a table needs. */
function judge(job, finished, expected) {
  const base = { id: job.id, driver: job.driver, scenario: job.scenario, ms: finished.ms, exit: finished.code, steps: 0, passed: 0, failing: [], problems: [], status: "CANNOT RUN", note: "" };
  if (finished.timedOut) return { ...base, status: "TIMEOUT", note: `no verdict within ${finished.timeoutS} s` };
  let json;
  try { json = JSON.parse(finished.stdout); } catch { /* not JSON: the driver did not get to report */ }
  const shaped = json && Array.isArray(json.results) && json.results.length > 0 && json.results.every((r) => r && Array.isArray(r.steps));
  const steps = shaped ? json.results.flatMap((r) => r.steps) : null; // every result of the report counts, not only the first
  if (!steps) {
    const first = (finished.stderr || "").trim().split("\n")[0];
    const said = !json && finished.stdout && finished.stdout.trim() ? `stdout is not a report: "${finished.stdout.trim().slice(0, 60)}"` : "";
    return { ...base, note: lib.scrub([first, said].filter(Boolean).join("; ") || `exit code ${finished.code}`).slice(0, 200) };
  }
  const failing = steps.filter((s) => !s.ok);
  const out = { ...base, steps: steps.length, passed: steps.length - failing.length, failing: failing.map((s) => s.name), problems: failing.map((s) => `${s.name}: ${(s.problems && s.problems[0]) || s.summary || "failed"}`) };
  if (finished.code === 2) return { ...out, status: "CANNOT RUN", note: "the driver exited with code 2" };
  if (steps.length === 0) return { ...out, status: "FAIL", note: "the report holds no step: nothing was checked" };
  if (failing.length > 0 || finished.code !== 0 || json.ok !== true) return { ...out, status: "FAIL", note: finished.code !== 0 && failing.length === 0 ? `exit code ${finished.code} with no failing step` : "" };
  const wanted = expected[job.id];
  if (wanted !== undefined && wanted !== steps.length) return { ...out, status: "FAIL", problems: [`expected ${wanted} steps (scripts/drive-expected.json), got ${steps.length}`], note: "step count differs" };
  return { ...out, status: "PASS", note: wanted === undefined ? "no expected count" : "" };
}

/** Work directories of the drivers present in the temporary folder. */
function pendingDirs(dir = os.tmpdir()) {
  try { return fs.readdirSync(dir).filter((f) => f.startsWith(lib.WORKDIR_PREFIX)); } catch { return []; }
}

/** The overall verdict and exit code from the judged jobs and what was left behind. */
function verdictOf(results, leftBehind = []) {
  if (results.length === 0) return { code: 2, verdict: "CANNOT RUN" }; // no job: nothing was checked
  const failed = results.filter((r) => r.status === "FAIL" || r.status === "TIMEOUT");
  const cannot = results.filter((r) => r.status === "CANNOT RUN");
  if (failed.length > 0 || leftBehind.length > 0) return { code: 1, verdict: "FAIL" };
  if (cannot.length > 0) return { code: cannot.length === results.length ? 2 : 1, verdict: cannot.length === results.length ? "CANNOT RUN" : "FAIL" };
  return { code: 0, verdict: "PASS" };
}

/** The drivers started and not yet finished: when drive-all itself is interrupted they are ended with it, not left running. */
const running = new Set();
/** A signal for the driver and everything it started (its server): each driver runs in a process group of its own, so a driver that ignores SIGTERM cannot leave its server running. */
function killTree(child, signal) {
  if (process.platform !== "win32") { try { process.kill(-child.pid, signal); return; } catch { /* no such group: fall back to the driver alone */ } }
  try { child.kill(signal); } catch { /* already gone */ }
}
function endChildren() {
  for (const child of running) killTree(child, "SIGTERM");
  if (running.size) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); } catch { /* no wait available */ } // a driver ends its own server and work directory on SIGTERM
    for (const child of running) killTree(child, "SIGKILL");
  }
  running.clear();
}

/** Runs one driver as a process: stdout kept up to a limit, stderr's tail, a deadline with SIGTERM and then SIGKILL. */
function runProcess(job, { timeoutS, node = process.execPath, tmp }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = lib.baseEnv(tmp ? { TMPDIR: tmp, TEMP: tmp, TMP: tmp } : {}); // the driver makes its work directory in the folder this run owns
    const child = cp.spawn(node, [path.join(__dirname, `drive-${job.driver}.js`), ...job.args], { cwd: lib.REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    running.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    const term = setTimeout(() => { timedOut = true; killTree(child, "SIGTERM"); setTimeout(() => killTree(child, "SIGKILL"), 5000).unref(); }, timeoutS * 1000);
    child.on("error", (error) => { clearTimeout(term); running.delete(child); resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, ms: Date.now() - started, timedOut }); });
    child.on("close", (code) => { clearTimeout(term); running.delete(child); resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut, timeoutS }); });
  });
}

/** Runs the jobs with at most `concurrency` at a time; results come back in the order of the jobs. */
async function runAll(jobs, { concurrency, timeoutS, expected, run = runProcess, tmp }) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const finished = await run(jobs[index], { timeoutS, tmp });
      results[index] = judge(jobs[index], { ...finished, timeoutS }, expected);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

function formatTable(results, leftBehind, summary) {
  const rows = results.map((r) => [r.id, r.status, r.steps ? `${r.passed}/${r.steps}` : "-", `${r.ms} ms`, r.note]);
  const widths = [0, 1, 2, 3].map((c) => Math.max(...rows.map((row) => String(row[c]).length), ["job", "result", "steps", "time"][c].length));
  const line = (cells) => cells.map((cell, c) => (c < 4 ? String(cell).padEnd(widths[c]) : cell)).join("  ").trimEnd();
  const out = [line(["job", "result", "steps", "time", "note"]), ...rows.map(line)];
  for (const r of results) for (const p of r.problems.slice(0, 5)) out.push(`  ${r.id}: ${p}`);
  if (leftBehind.length) out.push(`left behind by a driver (removed afterwards): ${leftBehind.join(", ")}`);
  const passed = results.filter((r) => r.status === "PASS").length;
  out.push("", `${summary.verdict}: ${passed} of ${results.length} jobs passed`);
  return lib.scrub(out.join("\n"));
}

async function main(argv) {
  const opts = lib.parseArgs(argv, { string: ["only", "scenario", "concurrency", "timeout-s", "root", "bundle", "expect"], boolean: ["json", "list", "no-expect", "help"] });
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts._.length) throw new lib.UsageError(`unexpected argument "${opts._[0]}"`);
  if (opts.expect && opts["no-expect"]) throw new lib.UsageError("--expect and --no-expect exclude each other");
  const only = opts.only ? names(opts.only, "--only", DRIVERS) : DRIVERS;
  const scenarios = opts.scenario ? names(opts.scenario, "--scenario") : undefined;
  const concurrency = opts.concurrency !== undefined ? lib.parseInteger("concurrency", opts.concurrency) : Math.max(1, Math.min(4, os.cpus().length));
  const timeoutS = opts["timeout-s"] !== undefined ? lib.parseInteger("timeout-s", opts["timeout-s"], { max: 86400 }) : 180;
  const root = opts.root ? path.resolve(opts.root) : undefined;
  const bundle = opts.bundle ? path.resolve(opts.bundle) : undefined;
  const jobs = planJobs({ only, scenarios, root, bundle });
  if (opts.list) { console.log(jobs.map((j) => j.id).join("\n")); return 0; }
  const expected = loadExpected(opts["no-expect"] ? null : opts.expect ? path.resolve(opts.expect) : DEFAULT_EXPECTED);

  // what must exist before anything is started; a missing build is "could not run", not a failed check
  const missing = [];
  const entries = new Set();
  if (only.includes("stdio") || only.includes("probe")) entries.add("main.js");
  if (only.includes("http") || only.includes("probe")) entries.add("index.js");
  for (const entry of entries) { try { lib.entryPoint(root || lib.REPO_ROOT, entry); } catch (error) { missing.push(error.message); } }
  if (only.includes("bundle")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(lib.REPO_ROOT, "package.json"), "utf8"));
    const file = bundle || path.join(lib.REPO_ROOT, "dist", "mcpb", `${pkg.name}-${pkg.version}.mcpb`);
    if (!fs.existsSync(file)) missing.push(`${file} does not exist: run "npm run mcpb", pass --bundle FILE, or leave the bundle out with --only`);
  }
  if (missing.length) throw new Error(missing.join("\n"));

  // the drivers get a temporary folder of this run's own, so what one of them leaves behind is found (and blamed on it) without mistaking another run's work directories for it
  const tmp = lib.makeWorkdir();
  process.on("exit", endChildren);
  try {
    const results = await runAll(jobs, { concurrency, timeoutS, expected, tmp });
    const leftBehind = pendingDirs(tmp);
    const summary = verdictOf(results, leftBehind);
    if (opts.json) console.log(JSON.stringify({ driver: "all", ok: summary.code === 0, verdict: summary.verdict, jobs: results, leftBehind }, null, 2));
    else console.log(formatTable(results, leftBehind, summary));
    return summary.code;
  } finally {
    lib.tryRemoveWorkdir(tmp);
  }
}

module.exports = { main, USAGE, DRIVERS, planJobs, loadExpected, judge, verdictOf, runAll, runProcess, pendingDirs, formatTable, endChildren, running };

if (require.main === module) lib.runCli("drive-all", USAGE, main);
