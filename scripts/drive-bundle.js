#!/usr/bin/env node
/**
 * Drives the Claude Desktop package (.mcpb) the way Claude Desktop installs and starts it: checks the zip, unpacks it into a fresh folder
 * with a space in its path, reads the manifest, resolves ${__dirname}, ${/} and ${user_config.*} with the manifest's own defaults plus the
 * settings given, starts the server with exactly the manifest's command, arguments and environment, runs a scenario over stdio, ends it,
 * and checks that the data landed in the chosen folder and that no lock file was left behind.
 *   node scripts/drive-bundle.js [--bundle FILE | --build] [--scenario basic] [--setting KEY=VALUE]... [--data-dir DIR] [--node PATH] [--json] [--keep]
 * Without --bundle it takes dist/mcpb/<name>-<version>.mcpb; --build makes it first (needs `npm ci`). Exit code: 0 every check passed,
 * 1 a check failed, 2 the driver could not run. The package's code is RUN: open only a package you built or trust. What this does NOT show:
 * that Claude Desktop itself accepts the file (docs/INSTALL-CLAUDE-DESKTOP.md).
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

/** The settings as they are shown in the report: the value only where neither the manifest ("sensitive") nor the name says it is a secret, and not the contact. */
function describeSettings(manifest, userConfig) {
  const declared = manifest.user_config || {};
  return Object.entries(userConfig).map(([key, value]) => {
    const hidden = (declared[key] && declared[key].sensitive === true) || lib.SECRET_NAME.test(key) || key === "contact";
    return hidden ? `${key}=${value === "" ? '""' : "(set)"}` : `${key}=${JSON.stringify(value)}`;
  });
}

function unpack(entries, home) {
  for (const entry of entries) {
    const target = path.join(home, ...entry.name.split("/"));
    if (path.relative(home, target).startsWith("..")) throw new Error(`${entry.name}: would be written outside the install folder`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
}

/**
 * After a clean exit: the data is in the folder the setting named, and the single-writer lock is gone. When the scenario writes A/B data (`writes`
 * true or "ab-data") and a writing step uses ${run_id}, the data file must contain this run's id; when it writes without it, the file must exist
 * and not be empty. When it replaces the routing rules (`writes` "rules"), the rules file next to the data file must exist and not be empty.
 */
function dataChecks(dataFile, scenario, runId, rulesFile = path.join(path.dirname(dataFile), "rules.yaml")) {
  const kindOf = (s) => (s.writes === true ? "ab-data" : s.writes);
  const wroteAb = scenario.steps.some((s) => kindOf(s) === "ab-data");
  const wroteRules = scenario.steps.some((s) => kindOf(s) === "rules");
  // the data file can only be held to this run's id when a step that writes it uses the id (the id may appear in other steps, say a gateway call)
  const usesRunId = scenario.steps.some((s) => kindOf(s) === "ab-data" && JSON.stringify(s).includes("${run_id}"));
  const problems = [];
  if (wroteAb) {
    if (!fs.existsSync(dataFile)) problems.push(`${dataFile} was not created`);
    else if (fs.statSync(dataFile).size === 0) problems.push(`${dataFile} is empty`);
    else if (usesRunId && !fs.readFileSync(dataFile, "utf8").includes(runId)) problems.push(`${dataFile} does not contain this run (${runId})`);
  }
  if (wroteRules) {
    if (!fs.existsSync(rulesFile)) problems.push(`${rulesFile} was not created`);
    else if (fs.statSync(rulesFile).size === 0) problems.push(`${rulesFile} is empty`);
  }
  const wrote = wroteAb || wroteRules;
  const lock = `${dataFile}.lock`;
  return [
    lib.driverStep("data landed in the chosen folder", problems, problems.length ? "missing" : wrote ? [wroteAb && "ab-data.jsonl", wroteRules && "rules.yaml"].filter(Boolean).join(" and ") + " written" : "nothing to write"),
    lib.driverStep("no lock file left behind", fs.existsSync(lock) ? [`${lock} still exists after a clean exit`] : [], fs.existsSync(lock) ? "left" : "removed"),
  ];
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
  const settings = lib.parseEnvPairs(opts.setting, "--setting");
  lib.assertNoLive({ GATEWAY_LIVE_APIS: settings.live_apis ?? "" }, "--setting live_apis");
  const bundleFile = findBundle(opts);
  const bytes = fs.readFileSync(bundleFile);

  const steps = [];
  const inspected = mcpb.inspect(bundleFile);
  steps.push(lib.driverStep("bundle is a well-formed package", inspected.problems, inspected.problems.length ? "problems" : `${inspected.entries.length} files, checksums match`));
  const notes = [`node: ${process.version}`, `bundle: ${bundleFile} (${bytes.length} bytes, sha256 ${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}...)`];
  let results;
  let serverInfo;
  // the install always goes into a folder of the driver's own, never into the folder the user chose for the data
  const workdir = lib.makeWorkdir();
  try {
    if (opts.keep) lib.keepWorkdir(workdir);
    if (inspected.problems.length) {
      results = [{ scenario: scenario.name, ok: false, steps }];
    } else {
      const home = path.join(workdir, "Claude Extensions", "increadible"); // a space in the path, as on macOS and Windows
      const dataDir = opts["data-dir"] ? path.resolve(opts["data-dir"]) : path.join(workdir, "data");
      unpack(inspected.entries, home);
      const manifest = JSON.parse(fs.readFileSync(path.join(home, "manifest.json"), "utf8"));
      if (manifest.user_config && manifest.user_config.data_directory && settings.data_directory === undefined) settings.data_directory = dataDir;
      const userConfig = resolveUserConfig(manifest, settings);
      const config = manifest.server.mcp_config;
      const manifestEnv = Object.fromEntries(Object.entries(config.env || {}).map(([k, v]) => [k, substitute(v, home, userConfig)]));
      lib.assertNoLive(manifestEnv, "the manifest's environment");
      lib.assertFreshData([manifestEnv.RULES_FILE, manifestEnv.EXPERIMENTS_FILE, manifestEnv.AB_DATA_FILE], scenario);
      fs.mkdirSync(dataDir, { recursive: true }); // after the settings are known to be valid and the folder is known to be fit: a usage error creates nothing in the user's folder
      const env = lib.baseEnv(manifestEnv);
      const command = config.command === "node" ? opts.node || process.execPath : config.command;
      const args = (config.args || []).map((a) => substitute(a, home, userConfig));
      notes.push(`unpacked to: ${home}${opts.keep ? " (kept)" : " (removed afterwards)"}`, `manifest: ${manifest.name} ${manifest.version} (manifest_version ${manifest.manifest_version})`, `settings: ${describeSettings(manifest, userConfig).join(", ")}`, `command: ${path.basename(command)} ${args.map((a) => path.relative(home, a) || a).join(" ")}`, `server environment: ${lib.describeEnv(env).join(", ")}`);

      const runId = lib.newRunId();
      const run = await lib.driveStdio({ command, args, env, cwd: home, scenario, vars: { run_id: runId }, secrets: lib.secretValues(env), expectVersion: manifest.version });
      serverInfo = run.serverInfo;
      steps.push(...run.results[0].steps);
      if (!run.results[0].ok && run.stderr) notes.push(`server stderr (last lines): ${run.stderr.replace(/\n/g, " | ")}`);
      if (env.AB_DATA_FILE) steps.push(...dataChecks(env.AB_DATA_FILE, scenario, runId, env.RULES_FILE));
      results = [{ scenario: scenario.name, ok: steps.every((s) => s.ok), steps }];
    }
  } finally {
    if (!opts.keep) lib.tryRemoveWorkdir(workdir);
    else notes.push(`kept: ${workdir}`);
  }
  const ok = results[0].ok;
  if (opts.json) console.log(JSON.stringify({ driver: "bundle", ok, target: bundleFile, server: serverInfo, notes, results }, null, 2));
  else console.log(lib.formatReport({ driver: "bundle", target: path.basename(bundleFile), results, notes }));
  return ok ? 0 : 1;
}

module.exports = { main, USAGE, substitute, resolveUserConfig, describeSettings, dataChecks, unpack };

if (require.main === module) lib.runCli("drive-bundle", USAGE, main);
