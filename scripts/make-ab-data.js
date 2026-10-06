#!/usr/bin/env node
/**
 * Writes an A/B data file (the JSON-lines log the server keeps) with one experiment and N measurements, much faster than
 * recording them through the server. Used by scripts/smoke.sh and scripts/probe-image.sh to start the server on a large file.
 *   node scripts/make-ab-data.js --file out.jsonl --measurements 400000 [--experiment cap] [--metric q]
 * Zero dependencies. Values cycle through a few numbers so both variants have a spread.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const file = arg("file");
const n = Number(arg("measurements", "0"));
const experiment = arg("experiment", "cap");
const metric = arg("metric", "q");
if (!file || !Number.isInteger(n) || n < 0) {
  console.error("usage: make-ab-data.js --file <path> --measurements <N> [--experiment <id>] [--metric <id>]");
  process.exit(2);
}

fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
const fd = fs.openSync(file, "w", 0o600);
try {
  const definition = {
    id: experiment, name: experiment, hypothesis: "generated", status: "setup", traffic_split: 0.5,
    variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
    metrics: [{ id: metric, name: metric, type: "continuous", aggregation: "mean" }],
  };
  fs.writeSync(fd, JSON.stringify({ type: "experiment", experiment: definition }) + "\n");
  const start = Date.UTC(2026, 0, 1);
  const BATCH = 20000;
  for (let from = 0; from < n; from += BATCH) {
    const lines = [];
    for (let i = from; i < Math.min(n, from + BATCH); i++) {
      lines.push(JSON.stringify({
        type: "measurement", experiment_id: experiment, variant_id: i % 2 ? "A" : "B",
        metrics: { [metric]: 10 + (i % 7) }, timestamp: new Date(start + i * 1000).toISOString(),
      }));
    }
    fs.writeSync(fd, lines.join("\n") + "\n");
  }
} finally {
  fs.closeSync(fd);
}
console.error(`wrote ${n} measurements to ${file} (${(fs.statSync(file).size / 1048576).toFixed(1)} MiB)`);
