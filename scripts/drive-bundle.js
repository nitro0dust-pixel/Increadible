#!/usr/bin/env node
/**
 * Drives the Claude Desktop package (.mcpb) the way Claude Desktop installs and starts it: checks the zip, unpacks it into a folder with a
 * space in its path, reads the manifest, resolves ${__dirname}, ${/} and ${user_config.*} with the manifest's own defaults plus the settings
 * given, starts the server with exactly the manifest's command, arguments and environment, runs a scenario over stdio, ends it, and checks
 * that the data landed in the chosen folder and that no lock file was left behind.
 *   node scripts/drive-bundle.js [--bundle FILE | --build] [--scenario basic] [--setting KEY=VALUE]... [--data-dir DIR] [--node PATH] [--json] [--keep]
 * Without --bundle it takes dist/mcpb/<name>-<version>.mcpb; --build makes it first (needs `npm ci`). Exit code: 0 every check passed,
 * 1 a check failed, 2 the driver could not run. What this does NOT show: that Claude Desktop itself accepts the file (docs/INSTALL-CLAUDE-DESKTOP.md).
 */
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./drive-lib.js");
const mcpb = require("./mcpb.js");

const USAGE = "usage: drive-bundle.js [--bundle FILE | --build] [--scenario NAME|FILE] [--setting KEY=VALUE]... [--data-dir DIR] [--node PATH] [--json] [--keep]";

/** ${__dirname}, ${/} and ${user_config.KEY}, as the runtime resolves them. A name it does not know is an error, not an empty string. */
function substitute(text, home, userConfig) {
  return String(text).replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (name === "__dirname") return home;
    if (name === "/") return path.sep;
    const key = name.replace(/^user_config\./, "");
    if (!name.startsWith("user_config.") || !(key in userConfig)) throw new Error(`the manifest uses \${${name}}, which has no value`);
    return String(userConfig[key]);
  });
}

/** The manifest's defaults first, then what the user set; booleans from "true"/"false". Missing required settings and unknown names are errors. */
function resolveUserConfig(manifest, settings) {
  const declared = manifest.user_config || {};
  const out = {};
  for (const [key, spec] of Object.entries(declared)) if (spec.default !== undefined) out[key] = spec.default;
  for (const [key, value] of Object.entries(settings)) {
    const spec = declared[key];
    if (!spec) throw new lib.UsageError(`--setting ${key}: the manifest has no such setting (it has: ${Object.keys(declared).join(", ")})`);
    if (spec.type === "boolean") {
      if (value !== "true" && value !== "false") throw new lib.UsageError(`--setting ${key} is a boolean: use true or false`);
      out[key] = value === "true";
    } else out[key] = value;
  }
  for (const [key, spec] of Object.entries(declared)) if (spec.required && (out[key] === undefined || out[key] === "")) throw new lib.UsageError(`the manifest requires the setting "${key}" (give it with --setting ${key}=VALUE)`);
  return out;
}

function unpack(entries, home) {
  for (const entry of entries) {
    const target = path.join(home, ...entry.name.split("/"));
    if (path.relative(home, target).startsWith("..")) throw new Error(`${entry.name}: would be written outside the install folder`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
}

function findBundle(opts) {
  if (opts.bundle) return path.resolve(opts.bundle);
  const pkg = JSON.parse(fs.readFileSync(path.join(lib.REPO_ROOT, "package.json"), "utf8"));
  const file = path.join(lib.REPO_ROOT, "dist", "mcpb", `${pkg.name}-${pkg.version}.mcpb`);
  if (opts.build) return mcpb.build().target;
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: run "npm run mcpb" first, or pass --build or --bundle FILE`);
  return file;
}

async function main(argv) {
  const opts = lib.parseArgs(argv, { string: ["bundle", "scenario", "setting", "data-dir", "node"], boolean: ["build", "json", "keep", "help"], repeat: ["setting"] });
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts._.length) throw new lib.UsageError(`unexpected argument "${opts._[0]}"`);
  if (opts.bundle && opts.build) throw new lib.UsageError("--bundle and --build exclude each other");
  const scenario = lib.loadScenario(opts.scenario || "basic");
  const bundleFile = findBundle(opts);
  const bytes = fs.readFileSync(bundleFile);

  const steps = [];
  const inspected = mcpb.inspect(bundleFile);
  steps.push(lib.driverStep("bundle is a well-formed package", inspected.problems, inspected.problems.length ? "problems" : `${inspected.entries.length} files, checksums match`));
  const notes = [`node: ${process.version}`, `bundle: ${bundleFile} (${bytes.length} bytes, sha256 ${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}...)`];
  let results;
  let serverInfo;
  let workdir;
  try {
    if (inspected.problems.length) {
      results = [{ scenario: scenario.name, ok: false, steps }];
    } else {
      workdir = opts["data-dir"] ? undefined : lib.makeWorkdir();
      const base = workdir || path.resolve(opts["data-dir"]);
      const home = path.join(base, "Claude Extensions", "increadible"); // a space in the path, as on macOS and Windows
      const dataDir = opts["data-dir"] ? path.resolve(opts["data-dir"]) : path.join(base, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      unpack(inspected.entries, home);
      const manifest = JSON.parse(fs.readFileSync(path.join(home, "manifest.json"), "utf8"));
      const settings = lib.parseEnvPairs(opts.setting, "--setting");
      if (manifest.user_config && manifest.user_config.data_directory && settings.data_directory === undefined) settings.data_directory = dataDir;
      const userConfig = resolveUserConfig(manifest, settings);
      const config = manifest.server.mcp_config;
      const manifestEnv = Object.fromEntries(Object.entries(config.env || {}).map(([k, v]) => [k, substitute(v, home, userConfig)]));
      const env = lib.baseEnv(manifestEnv);
      const command = config.command === "node" ? opts.node || process.execPath : config.command;
      const args = (config.args || []).map((a) => substitute(a, home, userConfig));
      const shown = Object.entries(userConfig).map(([k, v]) => (k === "contact" || /token|key|secret/i.test(k) ? `${k}=${v === "" ? '""' : "(set)"}` : `${k}=${JSON.stringify(v)}`));
      notes.push(`unpacked to: ${home}`, `manifest: ${manifest.name} ${manifest.version} (manifest_version ${manifest.manifest_version})`, `settings: ${shown.join(", ")}`, `command: ${path.basename(command)} ${args.map((a) => path.relative(home, a) || a).join(" ")}`, `server environment: ${lib.describeEnv(env).join(", ")}`);

      const runId = lib.newRunId();
      const run = await lib.driveStdio({ command, args, env, cwd: home, scenario, vars: { run_id: runId }, secrets: lib.secretValues(env), expectVersion: manifest.version });
      serverInfo = run.serverInfo;
      steps.push(...run.results[0].steps);
      if (!run.results[0].ok && run.stderr) notes.push(`server stderr (last lines): ${run.stderr.replace(/\n/g, " | ")}`);

      // after a clean exit: the data is where the user's folder setting said, and the single-writer lock is gone
      const dataFile = env.AB_DATA_FILE;
      const wrote = scenario.steps.some((s) => s.writes === true);
      if (dataFile) {
        const problems = [];
        if (wrote) {
          if (!fs.existsSync(dataFile)) problems.push(`${dataFile} was not created`);
          else if (!fs.readFileSync(dataFile, "utf8").includes(`drive-${runId}`)) problems.push(`${dataFile} does not contain the experiment of this run`);
        }
        steps.push(lib.driverStep("data landed in the chosen folder", problems, problems.length ? "missing" : wrote ? "ab-data.jsonl written" : "nothing to write"));
        const lock = `${dataFile}.lock`;
        steps.push(lib.driverStep("no lock file left behind", fs.existsSync(lock) ? [`${lock} still exists after a clean exit`] : [], fs.existsSync(lock) ? "left" : "removed"));
      }
      results = [{ scenario: scenario.name, ok: steps.every((s) => s.ok), steps }];
    }
  } finally {
    if (workdir && !opts.keep) lib.removeWorkdir(workdir);
    else if (workdir) notes.push(`kept: ${workdir}`);
  }
  const ok = results[0].ok;
  if (opts.json) console.log(JSON.stringify({ driver: "bundle", ok, target: bundleFile, server: serverInfo, notes, results }, null, 2));
  else console.log(lib.formatReport({ driver: "bundle", target: path.basename(bundleFile), results, notes }));
  return ok ? 0 : 1;
}

module.exports = { main, USAGE, substitute, resolveUserConfig, unpack };

if (require.main === module) lib.runCli("drive-bundle", USAGE, main);
