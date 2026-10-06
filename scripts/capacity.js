#!/usr/bin/env node
/**
 * Capacity test for the A/B data file: how big can it get before restarts, memory or queries become a problem?
 *   node scripts/capacity.js [--sizes 50000,200000,400000] [--json out.json]
 * For each size N: fill a data file with N measurements through the server, stop it, restart it on the same file and measure
 *   - the file size and the bytes per measurement,
 *   - the restart replay time (spawn to /health) and the peak RSS reached while replaying,
 *   - RSS once idle, and per-measurement memory,
 *   - the time one get_experiment_results takes (server-side histogram) and how much a burst of them delays /health.
 * Loopback, one machine: it shows how cost scales with N, not what a production node would do.
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const ROOT = process.env.INCREADIBLE_ROOT || path.join(__dirname, ".."); // INCREADIBLE_ROOT: test another checkout
const sizes = (process.argv.includes("--sizes") ? process.argv[process.argv.indexOf("--sizes") + 1] : "50000,200000,400000").split(",").map(Number);
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

const call = (name, args) => (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const EXPERIMENT = { id: "cap", name: "cap", hypothesis: "h", metrics: [{ id: "q", name: "q", type: "c", aggregation: "mean" }], variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }] };
const record = (id) => call("record_metric", { experiment_id: "cap", variant_id: id % 2 ? "A" : "B", metrics: { q: 10 + (id % 7) } })(id);

function post(agent, port, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", agent, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve(res.statusCode === 200 && d.includes('"result"') && !d.includes('"isError":true')));
    });
    req.on("error", () => resolve(false)); req.end(body);
  });
}
const get = (port, p) => new Promise((resolve) => { const t = performance.now(); http.get({ host: "127.0.0.1", port, path: p, agent: false }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ status: r.statusCode, body: d, ms: performance.now() - t })); }).on("error", () => resolve({ status: 0, body: "", ms: performance.now() - t })); });
const status = (pid, key) => { try { return Number(new RegExp(`${key}:\\s+(\\d+) kB`).exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024; } catch { return NaN; } };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };

function spawnServer(dir, file) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, "dist/src/index.js")], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RULES_FILE: path.join(dir, "rules.yaml"), EXPERIMENTS_FILE: path.join(dir, "experiments.yaml"), AB_DATA_FILE: file }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => (stderr += d));
  const t0 = performance.now();
  const ready = (async () => { for (;;) { if (child.exitCode !== null) throw new Error(`server exited: ${stderr.split("\n").slice(-4).join(" | ")}`); const r = await get(port, "/health"); if (r.status === 200) return (performance.now() - t0) / 1000; await new Promise((r2) => setTimeout(r2, 25)); } })();
  const stop = () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once("exit", resolve); child.kill("SIGTERM"); });
  return { child, port, ready, stop, stderr: () => stderr };
}

async function fill(port, n) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  await post(agent, port, call("create_experiment", EXPERIMENT)(0));
  let next = 1; const t0 = performance.now(); let errors = 0;
  await Promise.all(Array.from({ length: 32 }, async () => { while (next <= n) { const id = next++; if (!(await post(agent, port, record(id)))) errors++; } }));
  agent.destroy();
  return { seconds: (performance.now() - t0) / 1000, errors };
}

async function toolMean(port, tool) {
  const t = (await get(port, "/metrics")).body;
  const num = (s) => Number(new RegExp(`increadible_tool_call_duration_seconds_${s}\\{tool="${tool}"\\} (\\S+)`).exec(t)?.[1] ?? NaN);
  return { sum: num("sum"), count: num("count") };
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, "dist/src/index.js"))) throw new Error("run `npm run build` first");
  const out = { machine: { node: process.version, cpus: os.cpus().length, memGb: Math.round(os.totalmem() / 2 ** 30) }, sizes: [] };
  console.log("| measurements | file MiB | bytes each | fill req/s | restart replay s | peak RSS replaying MiB | idle RSS MiB | peak RSS after queries MiB | memory per measurement B | results call ms | /health p50 / p99 / max ms during a burst of results calls |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const n of sizes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-cap-")); const file = path.join(dir, "ab.jsonl");
    try {
      let s = spawnServer(dir, file); await s.ready;
      const baselineRss = status(s.child.pid, "VmRSS");
      const f = await fill(s.port, n); await s.stop();
      const bytes = fs.statSync(file).size;

      s = spawnServer(dir, file); const replay = await s.ready;
      // The server says how many measurements it restored: the data must really be N, or every figure below would describe something else.
      const restoredMatch = /Restored (\d+) experiments and (\d+) measurements/.exec(s.stderr());
      const restored = restoredMatch ? Number(restoredMatch[2]) : NaN;
      if (restored !== n) throw new Error(`expected ${n} measurements after the restart, the server restored ${restoredMatch ? restored : "none (no 'Restored' line)"}`);
      const peak = status(s.child.pid, "VmHWM"); const idle = status(s.child.pid, "VmRSS");
      // one query, then a burst of queries from 8 workers while /health is polled every 20 ms
      const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
      const q = call("get_experiment_results", { experiment_id: "cap" });
      for (let i = 0; i < 5; i++) await post(agent, s.port, q(i));
      const m0 = await toolMean(s.port, "get_experiment_results");
      for (let i = 0; i < 20; i++) await post(agent, s.port, q(i));
      const m1 = await toolMean(s.port, "get_experiment_results");
      const resultsMs = ((m1.sum - m0.sum) / (m1.count - m0.count)) * 1000;
      let stopBurst = false; const health = [];
      const burst = Promise.all(Array.from({ length: 8 }, async () => { while (!stopBurst) await post(agent, s.port, q(0)); }));
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) { health.push((await get(s.port, "/health")).ms); await new Promise((r) => setTimeout(r, 20)); }
      stopBurst = true; await burst; agent.destroy(); const peakAfter = status(s.child.pid, "VmHWM"); await s.stop();

      const row = { measurements: n, fileMb: bytes / 2 ** 20, bytesEach: bytes / n, fillRps: n / f.seconds, fillErrors: f.errors, replaySeconds: replay, restoredMeasurements: restored, peakRssMb: peak, idleRssMb: idle, peakRssAfterQueriesMb: peakAfter, baselineRssMb: baselineRss, bytesPerMeasurementInMemory: ((idle - baselineRss) * 2 ** 20) / n, resultsCallMs: resultsMs, healthP50: pct(health, 50), healthP99: pct(health, 99), healthMax: Math.max(...health) };
      out.sizes.push(row);
      const f1 = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
      console.log(`| ${n} | ${f1(row.fileMb)} | ${f1(row.bytesEach, 0)} | ${f1(row.fillRps, 0)} | ${f1(row.replaySeconds, 2)} | ${f1(row.peakRssMb, 0)} | ${f1(row.idleRssMb, 0)} | ${f1(row.peakRssAfterQueriesMb, 0)} | ${f1(row.bytesPerMeasurementInMemory, 0)} | ${f1(row.resultsCallMs, 2)} | ${f1(row.healthP50, 1)} / ${f1(row.healthP99, 1)} / ${f1(row.healthMax, 0)} |`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
