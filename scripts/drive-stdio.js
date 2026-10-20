#!/usr/bin/env node
/**
 * Drives the built server over stdio, the way Claude Desktop runs it: starts dist/src/main.js with its own data directory, performs the
 * handshake, runs a scenario of real tool calls, closes stdin and checks that the server left cleanly with stdout carrying only protocol.
 *   node scripts/drive-stdio.js [--scenario basic] [--root DIR] [--data-dir DIR] [--env NAME=VALUE]... [--json] [--keep] [--timeout-ms N] [--list]
 * Exit code: 0 every check passed, 1 a check failed, 2 the driver could not run. Run `npm run build` first. How to read the report: docs/DRIVERS.md.
 * Zero dependencies; the shared parts are in scripts/drive-lib.js.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./drive-lib.js");

const USAGE = "usage: drive-stdio.js [--scenario NAME|FILE] [--root DIR] [--data-dir DIR] [--env NAME=VALUE]... [--json] [--keep] [--timeout-ms N] [--list]";

async function main(argv) {
  const opts = lib.parseArgs(argv, { string: ["scenario", "root", "data-dir", "env", "timeout-ms"], boolean: ["json", "keep", "list", "help"], repeat: ["env"] });
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.list) { console.log(lib.listScenarios().join("\n")); return 0; }
  if (opts._.length) throw new lib.UsageError(`unexpected argument "${opts._[0]}"`);

  // everything that can be wrong with the command line is found before anything is started or created
  const timeoutMs = opts["timeout-ms"] !== undefined ? lib.parseInteger("timeout-ms", opts["timeout-ms"]) : 20000;
  const extra = lib.parseEnvPairs(opts.env);
  lib.assertNoLive(extra, "--env");
  const root = path.resolve(opts.root || lib.REPO_ROOT);
  const entry = lib.entryPoint(root, "main.js");
  const scenario = lib.loadScenario(opts.scenario || "basic");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

  const own = !opts["data-dir"];
  const dir = own ? lib.makeWorkdir() : path.resolve(opts["data-dir"]);
  try {
    if (!own) fs.mkdirSync(dir, { recursive: true });
    else if (opts.keep) lib.keepWorkdir(dir);
    const env = lib.baseEnv({ ...lib.dataEnv(dir), ...extra });
    const secrets = lib.secretValues(env);
    const run = await lib.driveStdio({
      args: [entry], env, cwd: root, scenario, secrets, expectVersion: version, requestTimeoutMs: timeoutMs,
      vars: { run_id: lib.newRunId() },
    });
    const notes = [`node: ${process.version}`, `data directory: ${dir}${own ? (opts.keep ? " (kept)" : " (removed afterwards)") : ""}`, `server environment: ${lib.describeEnv(env).join(", ")}`];
    const ok = run.results.every((r) => r.ok);
    if (opts.json) console.log(JSON.stringify({ driver: "stdio", ok, target: entry, server: run.serverInfo, notes, results: run.results, serverStderr: run.stderr }, null, 2));
    else {
      console.log(lib.formatReport({ driver: "stdio", target: entry, results: run.results, notes }));
      if (!ok && run.stderr) console.log(`\nserver stderr (last lines):\n${run.stderr}`);
    }
    return ok ? 0 : 1;
  } finally {
    if (own && !opts.keep) lib.tryRemoveWorkdir(dir);
  }
}

module.exports = { main, USAGE };

if (require.main === module) lib.runCli("drive-stdio", USAGE, main);
