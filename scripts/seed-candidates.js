#!/usr/bin/env node
/**
 * Seed import for the gated catalog (step 4, `docs/GATEWAY-GATED-CATALOG.md`): turns a snapshot of the public-apis list
 * (github.com/public-apis/public-apis, README.md, MIT licence) into candidate records. A candidate is never trusted and never
 * callable: the file this writes is read by no server code, is not compiled, and is not in the image or the Claude Desktop
 * package. An API becomes callable only by passing every gate and being added to `catalog.ts` by a person.
 *
 *   node scripts/seed-candidates.js <README.md> <LICENSE> --fetched-on YYYY-MM-DD --source-url URL [--out FILE]
 *
 * The input is untrusted text: it is parsed, never executed, and every field is length-capped. Only rows of tables whose header
 * is `API | Description | Auth | HTTPS | CORS` (with or without outer pipes), under a `###` category heading between `## Index` and
 * `## License`, are read; the list's sponsor and MCP blocks above the index are skipped. The listed auth is kept as listed (`listed_auth`), not mapped to an auth class:
 * classifying auth is gate 2, done by a person.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HEADER = /^\|?\s*API \| Description \| Auth \| HTTPS \| CORS\s*\|?$/;
const LINK = /^\[([^\]]{1,200})\]\((https?:\/\/[^)\s]{1,500})\)$/;
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

/**
 * Candidate records from the README's text, in list order, each with a unique `source_id` (`<category>/<name>`, then `-2`, `-3`),
 * and the table rows that could not be read, with their line number and why (they are reported, never guessed at).
 */
function parsePublicApis(markdown) {
  const out = [];
  const skipped = [];
  const seen = new Map();
  let category = null;
  let inTable = false;
  let inIndex = false;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s/.test(line)) {
      // A level-2 heading ends any category: only the part from "## Index" up to "## License" holds the list.
      inIndex = /^##\s+Index\s*$/.test(line) ? true : /^##\s+License\s*$/.test(line) ? false : inIndex;
      category = null;
      inTable = false;
      continue;
    }
    if (!inIndex) continue;
    if (line.startsWith("### ")) {
      category = cap(line.slice(4).trim(), 80);
      inTable = false;
      continue;
    }
    if (HEADER.test(line)) {
      inTable = category !== null;
      continue;
    }
    if (!inTable) continue;
    if (/^\|\s*:?-/.test(line)) continue; // the |:---|:---| separator
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length === 6 && cells[5] === "") cells.pop(); // some tables end their rows with an empty extra cell
    if (cells.length !== 5) {
      skipped.push({ line: i + 1, reason: `${cells.length} cells, not 5` });
      continue;
    }
    const link = LINK.exec(cells[0]);
    if (!link) {
      skipped.push({ line: i + 1, reason: "the first cell is not a [name](http(s) link)" });
      continue;
    }
    const name = cap(link[1].trim(), 100);
    const base = `${slug(category)}/${slug(name)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({
      source_id: n === 1 ? base : `${base}-${n}`,
      name,
      category,
      description: cap(cells[1], 300),
      listed_auth: cells[2].replace(/`/g, "") || "unknown",
      https: cells[3] === "Yes",
      cors: cells[4].toLowerCase(),
      docs_url: link[2],
      status: "candidate",
    });
  }
  return { candidates: out, skipped };
}

/** Counts that GATEWAY.md cites (entry count and the share listed as needing no auth). */
function counts(candidates) {
  const byAuth = {};
  for (const c of candidates) byAuth[c.listed_auth] = (byAuth[c.listed_auth] ?? 0) + 1;
  return { entries: candidates.length, categories: new Set(candidates.map((c) => c.category)).size, listed_auth: byAuth, https: candidates.filter((c) => c.https).length };
}

function main(argv) {
  const [readme, licence, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const fetchedOn = opt("--fetched-on");
  const sourceUrl = opt("--source-url");
  if (!readme || !licence || !/^\d{4}-\d{2}-\d{2}$/.test(fetchedOn ?? "") || !/^https:\/\//.test(sourceUrl ?? "")) {
    console.error("usage: node scripts/seed-candidates.js <README.md> <LICENSE> --fetched-on YYYY-MM-DD --source-url URL [--out FILE]");
    process.exit(2);
  }
  const text = fs.readFileSync(readme, "utf8");
  const { candidates, skipped } = parsePublicApis(text);
  const store = {
    note: "Seed material only (gated catalog, step 4). Nothing here is trusted or callable; read by no server code.",
    source: "public-apis",
    source_url: sourceUrl,
    fetched_on: fetchedOn,
    source_sha256: crypto.createHash("sha256").update(text).digest("hex"),
    licence: fs.readFileSync(licence, "utf8").trim(),
    counts: { ...counts(candidates), skipped_rows: skipped.length },
    skipped,
    candidates,
  };
  // One candidate per line: a re-import shows as a readable diff.
  const body = JSON.stringify({ ...store, candidates: [] }, null, 2).replace(
    '"candidates": []',
    `"candidates": [\n${candidates.map((c) => `    ${JSON.stringify(c)}`).join(",\n")}\n  ]`
  );
  const out = opt("--out") ?? path.join(__dirname, "..", "features", "09-api-gateway", "data", "candidates-public-apis.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${body}\n`);
  console.log(`seed-candidates: ${candidates.length} candidates in ${store.counts.categories} categories, ${skipped.length} rows skipped, source sha256 ${store.source_sha256}, ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { parsePublicApis, counts };
