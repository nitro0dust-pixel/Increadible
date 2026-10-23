#!/usr/bin/env node
/**
 * Keeps the global skill `omniroute-mcp` (skills/omniroute-mcp/) in step with the documents it carries, and ships it.
 *
 *   node scripts/skill.js sync                  copy the canonical documents into skills/omniroute-mcp/references/
 *   node scripts/skill.js check                 exit 1 when a copy differs from its source, or the skill is malformed
 *   node scripts/skill.js package [--out FILE]  write a zip (default dist/skill/omniroute-mcp.zip) for claude.ai / Claude Desktop upload
 *   node scripts/skill.js install [--target DIR] [--dry-run]
 *                                               copy the skill to DIR/omniroute-mcp (default ~/.claude/skills: global for Claude Code)
 *
 * Zero dependencies (the zip is written here, so it works the same on macOS, Windows and Linux). The mapping below is the single
 * list of which document ends up as which reference file; tests/config.test.ts holds the skill to it.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { crc32, zip } = require("./zip.js");

const root = path.join(__dirname, "..");
const SKILL = "omniroute-mcp";
const skillDir = path.join(root, "skills", SKILL);

/** source document (relative to the repository) -> file under skills/omniroute-mcp/references/ */
const REFERENCES = {
  "docs/BUILD-HISTORY.md": "build-history.md",
  "docs/INSTALL-CLAUDE-DESKTOP.md": "install-claude-desktop.md",
  "docs/ARCHITECTURE.md": "architecture.md",
  "docs/TROUBLESHOOTING.md": "troubleshooting.md",
  "CLAUDE.md": "project-rules.md",
  "CONTRIBUTING.md": "contributing.md",
  "SECURITY.md": "security.md",
  "DEPLOYMENT.md": "deployment.md",
  "ROADMAP.md": "roadmap.md",
  "AUDIT.md": "audit.md",
  "GATEWAY.md": "gateway.md",
  "docs/RELEASING.md": "releasing.md",
  "docs/GATEWAY-GATED-CATALOG.md": "gated-catalog.md",
  "docs/USING-THE-GATEWAY.md": "using-the-gateway.md",
  "docs/DRIVERS.md": "drivers.md",
  "docs/DRIVERS-WORKFLOW.md": "drivers-workflow.md",
};

const header = (source) =>
  `<!-- Copy of ${source} made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->\n\n`;
const expected = (source) => header(source) + fs.readFileSync(path.join(root, source), "utf8");

/** Problems with the skill, as strings; empty when it is sound. */
function problems() {
  const found = [];
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return [`${path.relative(root, skillFile)} is missing`];
  const text = fs.readFileSync(skillFile, "utf8");
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!front) found.push("SKILL.md has no YAML front matter");
  else {
    const name = (front[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
    const description = (front[1].match(/^description:\s*([\s\S]+?)(?=\n[a-z-]+:|$)/m) || [])[1]?.trim().replace(/\s*\n\s*/g, " ").replace(/^"(.*)"$/, "$1");
    if (name !== SKILL) found.push(`front matter name is ${JSON.stringify(name)}, expected ${JSON.stringify(SKILL)}`);
    if (!/^[a-z0-9-]{1,64}$/.test(name || "")) found.push("name must be 1 to 64 lowercase letters, digits or hyphens");
    if (!description) found.push("description is missing");
    else {
      if (description.length > 1024) found.push(`description is ${description.length} characters (limit 1024)`);
      if (/[<>]/.test(description)) found.push("description must not contain angle brackets");
    }
  }
  for (const [source, ref] of Object.entries(REFERENCES)) {
    const file = path.join(skillDir, "references", ref);
    if (!fs.existsSync(path.join(root, source))) found.push(`source ${source} is missing`);
    else if (!fs.existsSync(file)) found.push(`references/${ref} is missing (run: node scripts/skill.js sync)`);
    else if (fs.readFileSync(file, "utf8") !== expected(source)) found.push(`references/${ref} differs from ${source} (run: node scripts/skill.js sync)`);
    if (!text.includes(`references/${ref}`)) found.push(`SKILL.md does not point to references/${ref}`);
  }
  const refDir = path.join(skillDir, "references");
  const known = new Set(Object.values(REFERENCES));
  if (fs.existsSync(refDir)) for (const f of fs.readdirSync(refDir)) if (!known.has(f)) found.push(`references/${f} is not in the mapping of scripts/skill.js`);
  return found;
}

function sync() {
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  for (const [source, ref] of Object.entries(REFERENCES)) fs.writeFileSync(path.join(skillDir, "references", ref), expected(source));
  return Object.keys(REFERENCES).length;
}

/** Every file of the skill as [relative path with forward slashes, Buffer], sorted. */
function skillFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push([path.relative(skillDir, full).split(path.sep).join("/"), fs.readFileSync(full)]);
    }
  };
  walk(skillDir);
  return out;
}

function packageZip(out) {
  const target = path.resolve(out || path.join(root, "dist", "skill", `${SKILL}.zip`));
  const entries = skillFiles().map(([name, data]) => [`${SKILL}/${name}`, data]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zip(entries));
  return { target, files: entries.length };
}

function install(targetRoot, dryRun) {
  const target = path.join(path.resolve(targetRoot || path.join(os.homedir(), ".claude", "skills")), SKILL);
  const files = skillFiles();
  if (!dryRun) {
    // Replace only what this script owns: the folder named after the skill.
    fs.rmSync(target, { recursive: true, force: true });
    for (const [name, data] of files) {
      const file = path.join(target, ...name.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
  }
  return { target, files: files.length };
}

function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };
  switch (command) {
    case "sync": {
      const n = sync();
      console.log(`skill: ${n} reference files written to skills/${SKILL}/references/`);
      return 0;
    }
    case "check": {
      const found = problems();
      if (found.length) {
        for (const p of found) console.error(`skill: ${p}`);
        return 1;
      }
      console.log(`skill: OK (${Object.keys(REFERENCES).length} references in step with their sources)`);
      return 0;
    }
    case "package": {
      const found = problems();
      if (found.length) {
        for (const p of found) console.error(`skill: ${p}`);
        return 1;
      }
      const { target, files } = packageZip(option("out"));
      console.log(`skill: ${files} files written to ${target}`);
      return 0;
    }
    case "install": {
      const found = problems();
      if (found.length) {
        for (const p of found) console.error(`skill: ${p}`);
        return 1;
      }
      const dryRun = rest.includes("--dry-run");
      const { target, files } = install(option("target"), dryRun);
      console.log(`skill: ${dryRun ? "would copy" : "copied"} ${files} files to ${target}`);
      return 0;
    }
    default:
      console.error("usage: node scripts/skill.js sync | check | package [--out FILE] | install [--target DIR] [--dry-run]");
      return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { REFERENCES, problems, sync, zip, crc32, packageZip, install };
