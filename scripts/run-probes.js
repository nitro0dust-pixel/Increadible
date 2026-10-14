#!/usr/bin/env node
/**
 * Sends each keyless API's health probe once and appends the outcome to a probe history (gated catalog, gate 4 and the evidence
 * record: `docs/GATEWAY-GATED-CATALOG.md`, section 3). Run it on a machine that can reach the providers (the authoring sandbox
 * cannot), by hand or from a scheduler (cron, Task Scheduler); nothing in the server runs it or reads the file.
 *
 *   npm ci && npm run build
 *   GATEWAY_CONTACT=you@example.org node scripts/run-probes.js [--history FILE] [--where "<machine>"] [api ...]
 *   node scripts/run-probes.js report [--history FILE]
 *
 * (PowerShell: `$env:GATEWAY_CONTACT = "you@example.org"` first.)
 *
 * Each probe goes through the gateway's own live path (the compiled `dist/`, with the User-Agent the server would send), and its
 * answer is judged by the same check as the contract tests (`probes.ts`). One JSON line per probe is appended to the history
 * (default `probe-history.jsonl` in the current directory): when, where, the API, passed or not, the latency, the HTTP status and
 * the problems found. Never the answer's body, the User-Agent or a credential: only APIs with `auth: "none"` are probed.
 * `report` reads the history and prints, per API, the runs, the failures, the failures in a row at the end and the median latency.
 * Exit status of a run: 0 when every probe passed, 1 otherwise; 2 for a usage error.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist", "features", "09-api-gateway", "src");
const DEFAULT_HISTORY = "probe-history.jsonl";

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { command: "run", history: DEFAULT_HISTORY, where: "not stated", ids: [] };
  let rest = argv;
  if (rest[0] === "report") {
    args.command = "report";
    rest = rest.slice(1);
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--history" || a === "--where") {
      if (i + 1 >= rest.length || rest[i + 1].trim() === "") throw new UsageError(`${a} needs a value`);
      const value = rest[++i].trim();
      if (a === "--history") args.history = value;
      else args.where = value.slice(0, 120);
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (args.command === "report") throw new UsageError(`report takes no API ids: ${a}`);
    else args.ids.push(a);
  }
  return args;
}

/** The catalog entries to probe: keyless, with a probe; all of them, or the ids asked for (each must qualify). */
function chooseEntries(catalog, ids) {
  const probed = catalog.filter((e) => e.gate.probe && e.definition.auth === "none");
  for (const id of ids) {
    const entry = catalog.find((e) => e.definition.id === id);
    if (!entry) throw new UsageError(`unknown API ${id}`);
    if (entry.definition.auth !== "none") throw new UsageError(`${id} needs a credential: only keyless APIs are probed`);
    if (!entry.gate.probe) throw new UsageError(`${id} has no probe in catalog.ts`);
  }
  return ids.length > 0 ? probed.filter((e) => ids.includes(e.definition.id)) : probed;
}

/**
 * Sends the probes and returns one history line per probe. `modules` are the gateway's catalog, gateway class and probe check
 * (from `dist/` when run, from the sources in the tests); `fetchImpl` is the fetch the gateway uses; `now` gives the wall clock
 * for the record and `clock` a monotonic one for the latency.
 */
async function runProbes({ modules, entries, userAgent, where, fetchImpl, now = () => new Date(), clock = () => performance.now() }) {
  const { UniversalAPIGateway, probeProblems } = modules;
  const realFetch = globalThis.fetch;
  let status = null;
  globalThis.fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    status = response.status;
    return response;
  };
  const lines = [];
  try {
    for (const { definition, gate } of entries) {
      const id = definition.id;
      status = null;
      // No retry (a retry would hide the failure the probe is there to see) and no rate limit (one call); a fresh gateway per
      // probe, so no cache or cooldown carries over.
      const gateway = new UniversalAPIGateway({ liveApis: [id], userAgent, retries: 0, defaultRateLimit: 0 });
      const at = now().toISOString();
      const started = clock();
      let problems;
      try {
        const result = await gateway.callAPI(id, gate.probe.endpoint, gate.probe.params);
        problems = result.source === "live" ? probeProblems(id, result.data) : [`${id}: the answer was not live`];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems = [message.startsWith(`${id}:`) ? message : `${id}: ${message}`];
      }
      const latency = Math.round(clock() - started);
      lines.push({ api: id, at, where, ok: problems.length === 0, latency_ms: latency, http_status: status, problems });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return lines;
}

/** Appends history lines; the file is created when missing and never rewritten. */
function appendHistory(file, lines) {
  if (lines.length === 0) return;
  fs.appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

/** Reads a history file: every line must be a probe record; a bad line is reported with its number, never skipped silently. */
function readHistory(file) {
  const text = fs.readFileSync(file, "utf8");
  const records = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      throw new Error(`${file}, line ${i + 1}: not JSON`);
    }
    if (typeof r !== "object" || r === null || typeof r.api !== "string" || typeof r.ok !== "boolean" || typeof r.at !== "string") {
      throw new Error(`${file}, line ${i + 1}: not a probe record`);
    }
    records.push(r);
  });
  return records;
}

/** Per API, in file order: runs, failures, failures in a row at the end, last run, median latency of the passed probes. */
function summarize(records) {
  const byApi = new Map();
  for (const r of records) {
    if (!byApi.has(r.api)) byApi.set(r.api, []);
    byApi.get(r.api).push(r);
  }
  return [...byApi.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([api, rs]) => {
      let trailing = 0;
      for (let i = rs.length - 1; i >= 0 && !rs[i].ok; i--) trailing++;
      const latencies = rs.filter((r) => r.ok && Number.isFinite(r.latency_ms)).map((r) => r.latency_ms).sort((x, y) => x - y);
      const mid = Math.floor(latencies.length / 2);
      const median = latencies.length === 0 ? null : latencies.length % 2 ? latencies[mid] : Math.round((latencies[mid - 1] + latencies[mid]) / 2);
      return { api, runs: rs.length, failed: rs.filter((r) => !r.ok).length, failing_in_a_row: trailing, last: rs[rs.length - 1].at, median_latency_ms: median };
    });
}

function formatReport(summary) {
  if (summary.length === 0) return "run-probes: the history holds no probes";
  return summary
    .map((s) => `run-probes: ${s.api}: ${s.runs} runs, ${s.failed} failed, ${s.failing_in_a_row} failing in a row, last ${s.last}, median latency ${s.median_latency_ms === null ? "n/a" : `${s.median_latency_ms} ms`}`)
    .join("\n");
}

/** The gateway's compiled modules, so that a probe is exactly what the server sends. */
function loadDist() {
  if (!fs.existsSync(path.join(dist, "mcp-server.js"))) throw new UsageError("dist/ is missing: run npm ci && npm run build first");
  const { CATALOG } = require(path.join(dist, "catalog.js"));
  const { UniversalAPIGateway, userAgentFromEnv, hasContact } = require(path.join(dist, "mcp-server.js"));
  const { probeProblems } = require(path.join(dist, "probes.js"));
  return { CATALOG, UniversalAPIGateway, userAgentFromEnv, hasContact, probeProblems };
}

async function main(argv, load = loadDist, fetchImpl = globalThis.fetch) {
  const args = parseArgs(argv);
  if (args.command === "report") {
    if (!fs.existsSync(args.history)) throw new UsageError(`no history at ${args.history}`);
    console.log(formatReport(summarize(readHistory(args.history))));
    return 0;
  }
  const { CATALOG, UniversalAPIGateway, userAgentFromEnv, hasContact, probeProblems } = load();
  const userAgent = userAgentFromEnv();
  // Wikimedia asks every automated client for a User-Agent with contact details; never send its probes without one.
  if (!hasContact(userAgent)) throw new UsageError("set GATEWAY_CONTACT to an email address or http(s) URL (Wikimedia's User-Agent policy asks for one)");
  const entries = chooseEntries(CATALOG, args.ids);
  const lines = await runProbes({ modules: { UniversalAPIGateway, probeProblems }, entries, userAgent, where: args.where, fetchImpl });
  appendHistory(args.history, lines);
  for (const l of lines) {
    console.log(`run-probes: ${l.api}: ${l.ok ? "OK" : "FAILED"}, HTTP ${l.http_status ?? "none"}, ${l.latency_ms} ms${l.ok ? "" : `: ${l.problems.join("; ")}`}`);
  }
  const passed = lines.filter((l) => l.ok).length;
  console.log(`run-probes: ${passed} of ${lines.length} passed; appended to ${args.history}`);
  return passed === lines.length && lines.length > 0 ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`run-probes: ${error.message}`);
      if (error instanceof UsageError) {
        console.error('usage: GATEWAY_CONTACT=you@example.org node scripts/run-probes.js [--history FILE] [--where "<machine>"] [api ...]');
        console.error("       node scripts/run-probes.js report [--history FILE]");
        process.exit(2);
      }
      process.exit(1);
    },
  );
}

module.exports = { main, parseArgs, chooseEntries, runProbes, appendHistory, readHistory, summarize, formatReport, UsageError, DEFAULT_HISTORY };
