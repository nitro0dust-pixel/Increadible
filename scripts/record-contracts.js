#!/usr/bin/env node
/**
 * Records one real answer to each keyless API's health probe, for the contract tests (gated catalog, step 1b:
 * `docs/GATEWAY-GATED-CATALOG.md`). Run it on a machine that can reach the providers (the authoring sandbox cannot):
 *
 *   npm ci && npm run build
 *   GATEWAY_USER_AGENT="increadible (you@example.org)" node scripts/record-contracts.js [--where "<machine>"] [api ...]
 *
 * (PowerShell: `$env:GATEWAY_USER_AGENT = "increadible (you@example.org)"` first.)
 *
 * Each probe goes through the gateway's own live path (the compiled `dist/`), so the request is exactly what the gateway sends.
 * The provider's answer (status, content type, body) is written to `tests/fixtures/contracts/<api>.json` only when it passes the
 * probe's check (`probes.ts`); `tests/gateway-contracts.test.ts` then replays it through the gateway in CI. Only APIs with
 * `auth: "none"` are recorded, so no credential can reach a fixture; the User-Agent (it may hold an address) is not written.
 * Exit status: 0 when every probe passed, 1 otherwise. Nothing is written for a probe that failed.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist", "features", "09-api-gateway", "src");
const outDir = path.join(root, "tests", "fixtures", "contracts");

function usage(message) {
  console.error(`record-contracts: ${message}`);
  console.error('usage: GATEWAY_USER_AGENT="increadible (contact)" node scripts/record-contracts.js [--where "<machine>"] [api ...]');
  process.exit(2);
}

function parseArgs(argv) {
  const ids = [];
  let where = "not stated";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--where") {
      if (i + 1 >= argv.length || argv[i + 1].trim() === "") usage("--where needs a value");
      where = argv[++i].trim().slice(0, 120);
    } else if (argv[i].startsWith("-")) usage(`unknown option ${argv[i]}`);
    else ids.push(argv[i]);
  }
  return { ids, where };
}

async function main() {
  const { ids, where } = parseArgs(process.argv.slice(2));
  const userAgent = (process.env.GATEWAY_USER_AGENT || "").trim();
  // Wikimedia asks automated clients for a User-Agent with contact details; the gateway's default has none.
  if (userAgent === "") usage("set GATEWAY_USER_AGENT to a name with contact details (Wikimedia's User-Agent policy asks for one)");
  if (!fs.existsSync(path.join(dist, "mcp-server.js"))) usage("dist/ is missing: run npm ci && npm run build first");

  const { CATALOG } = require(path.join(dist, "catalog.js"));
  const { UniversalAPIGateway } = require(path.join(dist, "mcp-server.js"));
  const { probeProblems } = require(path.join(dist, "probes.js"));

  const probed = CATALOG.filter((e) => e.gate.probe && e.definition.auth === "none");
  for (const id of ids) {
    const entry = CATALOG.find((e) => e.definition.id === id);
    if (!entry) usage(`unknown API ${id}`);
    if (entry.definition.auth !== "none") usage(`${id} needs a credential: only keyless APIs are recorded`);
    if (!entry.gate.probe) usage(`${id} has no probe in catalog.ts`);
  }
  const chosen = ids.length > 0 ? probed.filter((e) => ids.includes(e.definition.id)) : probed;

  // Keep a copy of each raw answer while the gateway reads the original.
  const realFetch = globalThis.fetch;
  let last = null;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    last = { url: String(input), status: response.status, contentType: response.headers.get("content-type") || "", text: await response.clone().text() };
    return response;
  };

  let failed = 0;
  for (const { definition, gate } of chosen) {
    const id = definition.id;
    const { endpoint, params } = gate.probe;
    last = null;
    const gateway = new UniversalAPIGateway({ liveApis: [id], userAgent });
    try {
      const result = await gateway.callAPI(id, endpoint, params);
      const problems = result.source === "live" ? probeProblems(id, result.data) : [`${id}: the answer was not live`];
      if (problems.length > 0 || !last) throw new Error(problems.join("; ") || `${id}: no request was seen`);
      const fixture = {
        api: id,
        recorded_on: new Date().toISOString(),
        recorded_where: where,
        request: { endpoint, params, url: last.url },
        response: { status: last.status, content_type: last.contentType, body: JSON.parse(last.text) },
      };
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${id}.json`);
      const text = `${JSON.stringify(fixture, null, 2)}\n`;
      fs.writeFileSync(file, text);
      const sha = crypto.createHash("sha256").update(text).digest("hex");
      console.log(`record-contracts: ${id}: OK, HTTP ${last.status}, ${Buffer.byteLength(text)} bytes, sha256 ${sha}, ${path.relative(root, file)}`);
    } catch (error) {
      failed++;
      console.log(`record-contracts: ${id}: FAILED: ${error.message}`);
    }
  }
  globalThis.fetch = realFetch;
  console.log(`record-contracts: ${chosen.length - failed} of ${chosen.length} recorded`);
  process.exit(failed === 0 && chosen.length > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`record-contracts: ${error.message}`);
  process.exit(1);
});
