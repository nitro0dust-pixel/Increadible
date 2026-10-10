#!/usr/bin/env node
/**
 * Builds the one-click Claude Desktop package (an .mcpb file) from the sources in this repository, and checks one.
 *
 *   node scripts/mcpb.js build [--out FILE]   compile the sources, install the production dependencies from the lockfile,
 *                                             and write dist/mcpb/increadible-<version>.mcpb (or FILE)
 *   node scripts/mcpb.js inspect FILE         list a bundle and check it: every checksum, no unsafe names, the manifest
 *   node scripts/mcpb.js problems             check mcpb/manifest.json against package.json (exit 1 on a problem)
 *
 * An .mcpb file is a zip with manifest.json at its root (the format is the vendor's; this script writes it with scripts/zip.js,
 * so no dependency is added to the project). The bundle is built from a clean staging directory, never from dist/ or from the
 * working copy's node_modules, and the same commit gives the same bytes: entries are sorted and the timestamps are fixed.
 * Claude Desktop accepting the file is NOT VERIFIED here (it needs the app); docs/INSTALL-CLAUDE-DESKTOP.md says what was checked.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const cp = require("child_process");
const { crc32, zip } = require("./zip.js");

const root = path.join(__dirname, "..");
const manifestFile = path.join(root, "mcpb", "manifest.json");
/** What Claude Desktop starts: src/main.ts always starts the server, where src/index.ts starts itself only when it is the program. */
const BUNDLE_ENTRY = "dist/src/main.js";

/** Never packed, whatever else is present (the vendor's own tool leaves out the same kinds of files). */
const EXCLUDE = [/(^|\/)\.DS_Store$/, /(^|\/)\.env(\.|$)/, /(^|\/)\.git(\/|$)/, /^node_modules\/\.bin(\/|$)/, /^node_modules\/\.cache(\/|$)/, /^node_modules\/\.package-lock\.json$/, /\.map$/];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The ${...} names a string uses. */
const variablesIn = (value) => [...JSON.stringify(value).matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);

/** Problems with the manifest as strings; empty when it is consistent with package.json. `toolNames` (optional) is what the server really lists. */
function problems(manifest = readJson(manifestFile), pkg = readJson(path.join(root, "package.json")), toolNames) {
  const found = [];
  const need = (ok, text) => ok || found.push(text);
  need(manifest.manifest_version === "0.2", `manifest_version is ${JSON.stringify(manifest.manifest_version)}; 0.2 is what is used and checked with the vendor's validator`);
  need(manifest.name === pkg.name, `name ${JSON.stringify(manifest.name)} differs from package.json ${JSON.stringify(pkg.name)}`);
  need(manifest.version === pkg.version, `version ${JSON.stringify(manifest.version)} differs from package.json ${JSON.stringify(pkg.version)}`);
  need(manifest.license === pkg.license, `license ${JSON.stringify(manifest.license)} differs from package.json ${JSON.stringify(pkg.license)}`);
  need(manifest.author && manifest.author.name === pkg.author, `author.name differs from package.json author ${JSON.stringify(pkg.author)}`);
  need(typeof manifest.description === "string" && manifest.description.length > 0, "description is missing");
  const server = manifest.server || {};
  need(server.type === "node", `server.type is ${JSON.stringify(server.type)}, expected "node"`);
  need(server.entry_point === BUNDLE_ENTRY, `server.entry_point ${JSON.stringify(server.entry_point)} must be ${JSON.stringify(BUNDLE_ENTRY)} (src/main.ts always starts the server)`);
  const config = server.mcp_config || {};
  need(config.command === "node", `mcp_config.command is ${JSON.stringify(config.command)}, expected "node"`);
  need(JSON.stringify(config.args) === JSON.stringify([`\${__dirname}/${BUNDLE_ENTRY}`]), "mcp_config.args must be exactly [\"${__dirname}/" + BUNDLE_ENTRY + "\"]");
  need((config.env || {}).AB_LAZY_OPEN === "true", "mcp_config.env.AB_LAZY_OPEN must be \"true\": a desktop client starts several copies, and the data file must not be needed to answer the handshake");
  const declared = Object.keys(manifest.user_config || {});
  for (const name of variablesIn(config)) {
    const known = name === "__dirname" || name === "/" || (name.startsWith("user_config.") && declared.includes(name.slice("user_config.".length)));
    need(known, `mcp_config uses \${${name}}, which is not __dirname, the path separator or a declared user_config entry`);
  }
  for (const [key, entry] of Object.entries(manifest.user_config || {})) {
    need(["string", "number", "boolean", "directory", "file"].includes(entry.type), `user_config.${key}.type ${JSON.stringify(entry.type)} is not a known type`);
    need(entry.title && entry.description, `user_config.${key} needs a title and a description`);
    need(!(entry.required && entry.default !== undefined), `user_config.${key} is required and has a default; pick one`);
    need(!entry.sensitive || entry.type === "string", `user_config.${key} is sensitive and not a string`);
    // The runtime substitutes only settings that have a value: an optional one left empty with no default stays as the literal
    // text "${user_config.KEY}" (@anthropic-ai/mcpb 2.1.2, getMcpConfigForManifest), and the server would read that as a value.
    const usedInConfig = variablesIn(config).includes(`user_config.${key}`);
    need(entry.required || entry.default !== undefined || !usedInConfig, `user_config.${key} is optional and used in mcp_config, so it needs a default (an empty one is substituted as is)`);
  }
  for (const [key, value] of Object.entries(config.env || {})) need(typeof value === "string", `mcp_config.env.${key} must be a string`);
  const engines = (pkg.engines && pkg.engines.node) || "";
  need(((manifest.compatibility && manifest.compatibility.runtimes && manifest.compatibility.runtimes.node) || "").replace(/\.0\.0$/, "") === engines, `compatibility.runtimes.node must match package.json engines.node ${JSON.stringify(engines)}`);
  need(Array.isArray(manifest.tools) && manifest.tools.every((t) => t.name && t.description), "every tool needs a name and a description");
  if (toolNames) {
    const listed = (manifest.tools || []).map((t) => t.name);
    need(JSON.stringify(listed) === JSON.stringify(toolNames), `tools ${JSON.stringify(listed)} differ from what the server lists ${JSON.stringify(toolNames)}`);
  }
  return found;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
/**
 * A shell only where one is required: Node refuses to start a Windows .cmd file (npm.cmd) without one. Everything else starts
 * directly, because a shell joins the command line unquoted and a path with a space ("C:\\Program Files\\nodejs\\node.exe") breaks.
 */
function spawnOptions(command, platform = process.platform) {
  return { shell: platform === "win32" && /\.cmd$/i.test(command) };
}
function run(command, args, cwd) {
  const r = cp.spawnSync(command, args, { cwd, encoding: "utf8", ...spawnOptions(command), maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${r.status}):\n${(r.stdout || "") + (r.stderr || "")}`.slice(0, 4000));
}

/** Every file under `dir` as [posix relative path, Buffer], sorted by path, minus the excluded ones. */
function files(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (EXCLUDE.some((re) => re.test(rel))) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push([rel, fs.readFileSync(full)]);
    }
  };
  walk(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function build(out) {
  const found = problems();
  if (found.length) throw new Error("mcpb/manifest.json has problems:\n- " + found.join("\n- "));
  const pkg = readJson(path.join(root, "package.json"));
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error("typescript is not installed: run `npm ci` first");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-stage-"));
  try {
    // 1. compile the committed sources (not whatever dist/ holds)
    run(process.execPath, [tsc, "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(stage, "dist")], root);
    // 2. the production dependencies, exactly as the lockfile pins them, with no install scripts
    fs.copyFileSync(path.join(root, "package.json"), path.join(stage, "package.json"));
    fs.copyFileSync(path.join(root, "package-lock.json"), path.join(stage, "package-lock.json"));
    run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], stage);
    fs.rmSync(path.join(stage, "package-lock.json"));
    // 3. the manifest and the license
    fs.copyFileSync(manifestFile, path.join(stage, "manifest.json"));
    fs.copyFileSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
    const entries = files(stage);
    const target = path.resolve(out || path.join(root, "dist", "mcpb", `${pkg.name}-${pkg.version}.mcpb`));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = zip(entries);
    fs.writeFileSync(target, bytes);
    return { target, files: entries.length, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Reads a zip through its central directory and checks it; returns { entries: [{ name, data }], problems }. */
function inspect(file) {
  const found = [];
  const zipBytes = fs.readFileSync(file);
  const end = zipBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return { entries: [], problems: ["not a zip file (no end-of-central-directory record)"] };
  const count = zipBytes.readUInt16LE(end + 10);
  let pos = zipBytes.readUInt32LE(end + 16);
  const entries = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    if (zipBytes.readUInt32LE(pos) !== 0x02014b50) {
      found.push(`entry ${i}: bad central directory signature`);
      break;
    }
    const method = zipBytes.readUInt16LE(pos + 10);
    const crc = zipBytes.readUInt32LE(pos + 16);
    const csize = zipBytes.readUInt32LE(pos + 20);
    const nameLength = zipBytes.readUInt16LE(pos + 28);
    const offset = zipBytes.readUInt32LE(pos + 42);
    const name = zipBytes.subarray(pos + 46, pos + 46 + nameLength).toString("utf8");
    pos += 46 + nameLength + zipBytes.readUInt16LE(pos + 30) + zipBytes.readUInt16LE(pos + 32);
    const start = offset + 30 + zipBytes.readUInt16LE(offset + 26) + zipBytes.readUInt16LE(offset + 28);
    const body = zipBytes.subarray(start, start + csize);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(body) : method === 0 ? body : null;
    } catch (e) {
      data = null;
    }
    if (data === null) found.push(`${name}: cannot be read (method ${method})`);
    else if (crc32(data) !== crc) found.push(`${name}: checksum mismatch`);
    if (seen.has(name)) found.push(`${name}: appears twice`);
    seen.add(name);
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\") || /^[A-Za-z]:/.test(name)) found.push(`${name}: unsafe name`);
    entries.push({ name, data });
  }
  const manifest = entries.find((e) => e.name === "manifest.json");
  if (!manifest) found.push("manifest.json is missing at the root");
  else {
    try {
      const parsed = JSON.parse(manifest.data.toString("utf8"));
      const entry = parsed.server && parsed.server.entry_point;
      if (!entries.some((e) => e.name === entry)) found.push(`the entry point ${entry} is not in the bundle`);
      for (const dep of ["yaml"]) if (!entries.some((e) => e.name === `node_modules/${dep}/package.json`)) found.push(`node_modules/${dep} is not in the bundle`);
    } catch (e) {
      found.push("manifest.json is not valid JSON");
    }
  }
  return { entries, problems: found };
}

function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };
  switch (command) {
    case "build": {
      const r = build(option("out"));
      console.log(`mcpb: ${r.files} files, ${r.bytes} bytes, sha256 ${r.sha256}\nmcpb: written to ${r.target}`);
      return 0;
    }
    case "inspect": {
      if (!rest[0]) {
        console.error("usage: node scripts/mcpb.js inspect FILE");
        return 2;
      }
      const r = inspect(rest[0]);
      for (const p of r.problems) console.error(`mcpb: ${p}`);
      if (r.problems.length) return 1;
      console.log(`mcpb: OK (${r.entries.length} files, every checksum matches, manifest.json at the root, entry point present)`);
      return 0;
    }
    case "problems": {
      const found = problems();
      for (const p of found) console.error(`mcpb: ${p}`);
      if (!found.length) console.log("mcpb: manifest is consistent with package.json");
      return found.length ? 1 : 0;
    }
    default:
      console.error("usage: node scripts/mcpb.js build [--out FILE] | inspect FILE | problems");
      return 2;
  }
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`mcpb: ${e.message}`);
    process.exit(1);
  }
}
module.exports = { problems, build, inspect, files, EXCLUDE, spawnOptions };
