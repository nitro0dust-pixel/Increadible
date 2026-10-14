#!/usr/bin/env node
/**
 * Load test for the compiled server (needs `npm run build`). No dependencies.
 *
 *   node scripts/loadtest.js [--duration 8] [--warmup 2] [--concurrency 1,16,64] [--rate-fraction 0.5]
 *                            [--scenarios routing,ab-fsync] [--json results.json] [--list]
 *
 * For every scenario it starts a fresh server on loopback and measures two ways:
 *  - closed loop: N connections, each sends its next request when the previous one is answered. This finds the throughput
 *    ceiling; the latencies at that point include queueing and say little about normal operation.
 *  - open loop: requests are issued at a fixed rate (a fraction of the best closed-loop throughput) and each latency is
 *    counted from the moment the request was *due*, so a slow server cannot hide its queue (no coordinated omission).
 *
 * What the numbers are: one machine, one client process on the same host as the server. They show relative costs
 * (for example fsync on or off) and a baseline for alert thresholds. They are not a statement about any production
 * hardware, network or load balancer. The server's own CPU use is reported so a client-bound run can be recognised.
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const ROOT = process.env.INCREADIBLE_ROOT || path.join(__dirname, ".."); // INCREADIBLE_ROOT: test another checkout
const CLK_TCK = 100; // Linux USER_HZ

function parseArgs(argv) {
  const out = { duration: 8, warmup: 2, concurrency: [1, 16, 64], rateFraction: 0.5, scenarios: null, json: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--duration") out.duration = Number(argv[++i]);
    else if (a === "--warmup") out.warmup = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = argv[++i].split(",").map(Number);
    else if (a === "--rate-fraction") out.rateFraction = Number(argv[++i]);
    else if (a === "--scenarios") out.scenarios = argv[++i].split(",");
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--list") out.list = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const toolCall = (name, args) => (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const EXPERIMENT = {
  id: "load", name: "load", hypothesis: "h",
  metrics: [{ id: "q", name: "q", type: "c", aggregation: "mean" }],
  variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
};
const recordMetric = (id) => toolCall("record_metric", { experiment_id: "load", variant_id: id % 2 ? "A" : "B", metrics: { q: 10 + (id % 7) } })(id);

const SCENARIOS = {
  routing: { title: "routing: apply_routing_rules", tool: "apply_routing_rules", env: () => ({}), setup: async () => toolCall("apply_routing_rules", { task_type: "qa", task_complexity: "low" }) },
  gateway: { title: "gateway: get_api_stats", tool: "get_api_stats", env: () => ({}), setup: async () => toolCall("get_api_stats", {}) },
  "ab-memory": { title: "A/B record_metric, memory only", tool: "record_metric", env: () => ({}), setup: async (port) => { await rpc(port, toolCall("create_experiment", EXPERIMENT)(0)); return recordMetric; } },
  "ab-file": { title: "A/B record_metric, data file, fsync off", tool: "record_metric", env: (dir) => ({ AB_DATA_FILE: path.join(dir, "ab.jsonl") }), setup: async (port) => { await rpc(port, toolCall("create_experiment", EXPERIMENT)(0)); return recordMetric; } },
  "ab-fsync": { title: "A/B record_metric, data file, AB_FSYNC=1", tool: "record_metric", env: (dir) => ({ AB_DATA_FILE: path.join(dir, "ab.jsonl"), AB_FSYNC: "1" }), setup: async (port) => { await rpc(port, toolCall("create_experiment", EXPERIMENT)(0)); return recordMetric; } },
  "ab-results": {
    title: "A/B get_experiment_results (10 000 samples)", tool: "get_experiment_results", env: () => ({}),
    setup: async (port) => {
      await rpc(port, toolCall("create_experiment", EXPERIMENT)(0));
      await closedLoop(port, 32, null, recordMetric, 10_000); // preload
      return toolCall("get_experiment_results", { experiment_id: "load" });
    },
  },
};

// ---- HTTP client -------------------------------------------------------------------------------------------------
function post(agent, port, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", agent, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(res.statusCode === 200 && data.includes('"result"') && !data.includes('"isError":true')));
    });
    req.on("error", () => resolve(false));
    req.end(body);
  });
}
const rpc = (port, body) => post(new http.Agent({ keepAlive: false }), port, body);

/** N workers, each sends the next request as soon as the previous is answered; stops after `seconds` or `maxRequests`. */
async function closedLoop(port, concurrency, seconds, makeBody, maxRequests = Infinity) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const lat = [];
  let errors = 0, next = 1;
  const end = seconds == null ? Infinity : performance.now() + seconds * 1000;
  const t0 = performance.now();
  const worker = async () => {
    while (performance.now() < end && next <= maxRequests) {
      const id = next++;
      const s = performance.now();
      if (!(await post(agent, port, makeBody(id)))) errors++;
      lat.push(performance.now() - s);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  agent.destroy();
  return { lat, errors, seconds: (performance.now() - t0) / 1000 };
}

/** Requests issued at `rate` per second; each latency runs from the moment the request was due. */
async function openLoop(port, rate, seconds, makeBody) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const lat = [];
  const total = Math.floor(rate * seconds);
  let errors = 0, sent = 0, done = 0;
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const due = Math.min(total, Math.floor(((performance.now() - start) * rate) / 1000));
      while (sent < due) {
        const intended = start + (sent * 1000) / rate;
        const id = ++sent;
        post(agent, port, makeBody(id)).then((ok) => {
          lat.push(performance.now() - intended);
          if (!ok) errors++;
          if (++done === total) resolve();
        });
      }
      if (sent < total) setTimeout(tick, 1);
    };
    tick();
  });
  agent.destroy();
  return { lat, errors, seconds: (performance.now() - start) / 1000 };
}

// ---- measurement helpers ------------------------------------------------------------------------------------------
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN);
function summarize(run) {
  const sorted = Float64Array.from(run.lat).sort();
  return {
    requests: run.lat.length, errors: run.errors, rps: run.lat.length / run.seconds,
    p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.length ? sorted[sorted.length - 1] : NaN,
  };
}
function procCpuSeconds(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // fields after "(comm)": state is f[0], utime f[11], stime f[12]
    return (Number(f[11]) + Number(f[12])) / CLK_TCK;
  } catch { return NaN; }
}
function rssMb(pid) {
  try { return Number(/VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024; } catch { return NaN; }
}
async function serverToolMeanMs(port, tool) {
  const text = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/metrics", agent: false }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve(d)); }));
  const get = (suffix) => Number(new RegExp(`increadible_tool_call_duration_seconds_${suffix}\\{tool="${tool}"\\} (\\S+)`).exec(text)?.[1] ?? NaN);
  return { sum: get("sum"), count: get("count") };
}

/**
 * A port nothing listens on, chosen by the operating system. A random port could be taken: in 20000-40000 it overlaps the
 * outgoing-connection range (32768-60999 on Linux), and a server that loses the race exits with EADDRINUSE (seen once in CI).
 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
/** Why a server exited: its first error line (an uncaught error's message), not Node's trailer, then the last lines. */
const exitReason = (stderr) => {
  const lines = stderr.split("\n").filter((l) => l.trim() !== "");
  const first = lines.find((l) => /Error|EADDRINUSE|Refusing/.test(l));
  return [first, ...lines.slice(-3)].filter(Boolean).join(" | ");
};

async function startServer(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-load-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "dist/src/index.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RULES_FILE: path.join(dir, "rules.yaml"), EXPERIMENTS_FILE: path.join(dir, "experiments.yaml"), ...scenario.env(dir) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${exitReason(stderr)}`);
    if (await new Promise((r) => http.get({ host: "127.0.0.1", port, path: "/health", agent: false }, (res) => { res.resume(); r(res.statusCode === 200); }).on("error", () => r(false)))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { child, port, dir, stop };
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) { for (const [k, v] of Object.entries(SCENARIOS)) console.log(`${k.padEnd(11)} ${v.title}`); return; }
  if (!fs.existsSync(path.join(ROOT, "dist/src/index.js"))) throw new Error("dist/ missing: run `npm run build` first");
  const names = args.scenarios ?? Object.keys(SCENARIOS);
  const results = { machine: { node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, loadavg: os.loadavg().map((n) => Number(n.toFixed(2))), startedAt: new Date().toISOString() }, settings: { duration: args.duration, warmup: args.warmup, concurrency: args.concurrency, rateFraction: args.rateFraction }, runs: [] };
  console.log(`# Load test: ${results.machine.node}, ${results.machine.cpus} x ${results.machine.cpuModel}, load average at start ${results.machine.loadavg.join(" ")}\n`);

  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario: ${name} (try --list)`);
    console.log(`## ${scenario.title}\n`);
    console.log("| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |");
    console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    let best = 0;
    const row = (mode, load, s, extra) => {
      console.log(`| ${mode} | ${load} | ${fmt(s.rps, 0)} | ${fmt(s.p50, 3)} | ${fmt(s.p95, 3)} | ${fmt(s.p99, 3)} | ${fmt(s.max, 2)} | ${s.errors} | ${extra.cpu} | ${extra.mean} | ${extra.rss} |`);
      results.runs.push({ scenario: name, mode, load, ...s, serverCpuPct: extra.cpuPct, serverMeanMs: extra.meanMs, rssMb: extra.rssMb });
    };
    const measure = async (mode, load, drive) => {
      const server = await startServer(scenario);
      try {
        const makeBody = await scenario.setup(server.port);
        await closedLoop(server.port, 16, args.warmup, makeBody); // warm-up: JIT, connections, caches
        const before = await serverToolMeanMs(server.port, scenario.tool);
        const cpu0 = procCpuSeconds(server.child.pid);
        const t0 = performance.now();
        const run = await drive(server.port, makeBody);
        const wall = (performance.now() - t0) / 1000;
        const cpu = (procCpuSeconds(server.child.pid) - cpu0) / wall;
        const after = await serverToolMeanMs(server.port, scenario.tool);
        const meanMs = ((after.sum - before.sum) / (after.count - before.count)) * 1000;
        const s = summarize(run);
        row(mode, load, s, { cpu: `${fmt(cpu * 100, 0)}%`, cpuPct: cpu * 100, mean: fmt(meanMs, 4), meanMs, rss: fmt(rssMb(server.child.pid), 0), rssMb: rssMb(server.child.pid) });
        return s;
      } finally {
        await server.stop();
      }
    };
    for (const c of args.concurrency) {
      const s = await measure("closed", `${c} conn`, (port, makeBody) => closedLoop(port, c, args.duration, makeBody));
      best = Math.max(best, s.rps);
    }
    const rate = Math.max(1, Math.round(best * args.rateFraction));
    await measure("open", `${rate}/s (${Math.round(args.rateFraction * 100)}% of best)`, (port, makeBody) => openLoop(port, rate, args.duration, makeBody));
    console.log();
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(results, null, 2) + "\n");
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
