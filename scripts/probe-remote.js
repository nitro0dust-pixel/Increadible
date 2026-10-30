#!/usr/bin/env node
/**
 * A read-only check of a server that is already running (a container, a Railway service, a port-forward): is it up, does it refuse a request
 * without the token, does it answer with the token, how many tools does it list, which live APIs does it report and does its gateway carry a contact.
 * It sends only requests that change nothing and call no provider: GET /health, GET /ready, an unauthenticated POST /mcp (tools/list), and, with a
 * token, initialize, tools/list and the read-only tool get_api_stats. It runs no scenario, so unlike `drive:http --url` it is safe against a deployment
 * whose gateway has live APIs on (that scenario expects sample data and would call the live providers).
 *   node scripts/probe-remote.js --url URL [--token-env NAME] [--expect-tools N] [--json] [--timeout-ms N]
 * The token is read from the environment variable NAME, never from the command line, and is never printed. Exit code: 0 every check passed,
 * 1 a check failed, 2 the probe could not run (bad options). docs/DRIVERS.md and DEPLOYMENT.md ("Railway") say when to use it.
 */
"use strict";
const lib = require("./drive-lib.js");
const { parseRemote } = require("./drive-http.js");

const USAGE = "usage: probe-remote.js --url URL [--token-env NAME] [--expect-tools N] [--json] [--timeout-ms N]";
const EXPECTED_TOOLS = 13;
/** The live APIs whose operator asks for a contact in the User-Agent. */
const WIKIMEDIA_APIS = ["wikipedia", "wikidata"];

/** This machine: 127.0.0.0/8, localhost and ::1. A server answering here without a token is a development server, not an open deployment. */
function isLoopback(hostname) {
  return /^127(\.\d{1,3}){3}$/.test(hostname) || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** What an unauthenticated POST /mcp must look like: 401 everywhere, and on this machine an open server is reported rather than failed. */
function judgeUnauthenticated(status, hostname) {
  if (status === 401) return { problems: [], summary: "HTTP 401: the token is required" };
  if (status === 200) {
    return isLoopback(hostname)
      ? { problems: [], summary: "HTTP 200: no token needed (loopback)", status: "OPEN", notes: ["this server runs without AUTH_TOKEN; that is allowed on this machine only"] }
      : { problems: ["a request without the token was answered (HTTP 200): the server is open to anything that can reach it"], summary: "HTTP 200: OPEN" };
  }
  return { problems: [`expected 401, got HTTP ${status}`], summary: `HTTP ${status}` };
}

/** The judgement of a get_api_stats answer: the fields the deployment depends on, and the Wikimedia contact rule. */
function judgeStats(stats) {
  const problems = [];
  const notes = [];
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return { problems: ["get_api_stats did not answer an object"], summary: "unreadable", notes };
  const live = stats.live_apis;
  if (!Array.isArray(live) || !live.every((id) => typeof id === "string")) problems.push("live_apis is missing or is not a list of names");
  const contact = stats.user_agent_has_contact;
  if (contact === undefined) notes.push("this build does not report user_agent_has_contact (it predates 2026-10-13)");
  else if (typeof contact !== "boolean") problems.push("user_agent_has_contact is not true or false");
  const wikimedia = Array.isArray(live) ? live.filter((id) => WIKIMEDIA_APIS.includes(id)) : [];
  if (wikimedia.length > 0 && contact === false) problems.push(`${wikimedia.join(" and ")} is live without a contact in the User-Agent (set GATEWAY_CONTACT)`);
  const gates = stats.gates && typeof stats.gates === "object" ? Object.values(stats.gates).map((g) => g && g.status) : [];
  const byStatus = {};
  for (const s of gates) byStatus[s] = (byStatus[s] || 0) + 1;
  const gateText = Object.keys(byStatus).length ? Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(", ") : "none reported";
  if (Number.isFinite(stats.live_calls) && Number.isFinite(stats.total_calls)) notes.push(`calls since the process started: ${stats.total_calls} (${stats.live_calls} live)`);
  const liveText = Array.isArray(live) ? (live.length ? live.join(", ") : "none") : "?";
  return { problems, summary: `live: ${liveText}; contact: ${contact === true ? "set" : contact === false ? "not set" : "n/a"}; gates: ${gateText}`, notes };
}

/** The report: one line per check, then the verdict. (The drivers' formatter says "skipped: they write data", which is not why a check is skipped here.) */
function formatProbe({ target, notes, steps }) {
  const lines = ["driver: probe-remote", `target: ${target}`, ...notes, "", "checks (read-only):"];
  const width = Math.max(...steps.map((s) => s.name.length));
  steps.forEach((s, i) => {
    const state = s.skipped ? "SKIP" : !s.ok ? "FAIL" : s.status || "PASS";
    lines.push(`  ${String(i + 1).padStart(2)}  ${s.name.padEnd(width)}  ${state.padEnd(4)}  ${s.summary}${s.skipped ? "" : `  (${s.ms} ms)`}`);
    for (const problem of s.problems) lines.push(`        - ${problem}`);
    for (const note of s.notes || []) lines.push(`        . ${note}`);
  });
  const ran = steps.filter((s) => !s.skipped);
  const failed = ran.filter((s) => !s.ok).length;
  const skippedText = ran.length < steps.length ? ` (${steps.length - ran.length} skipped: no token given)` : "";
  lines.push("", failed === 0 ? `PASS ${ran.length}/${ran.length}${skippedText}` : `FAIL ${failed} of ${ran.length} checks${skippedText}`);
  return lib.scrub(lines.join("\n"));
}

async function main(argv) {
  const opts = lib.parseArgs(argv, { string: ["url", "token-env", "expect-tools", "timeout-ms"], boolean: ["json", "help"] });
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts._.length) throw new lib.UsageError(`unexpected argument "${opts._[0]}"`);
  if (opts.url === undefined) throw new lib.UsageError("--url is required");
  const baseUrl = parseRemote(opts.url);
  const timeoutMs = opts["timeout-ms"] !== undefined ? lib.parseInteger("timeout-ms", opts["timeout-ms"]) : 20000;
  const expectTools = opts["expect-tools"] !== undefined ? lib.parseInteger("expect-tools", opts["expect-tools"], { max: 1000 }) : EXPECTED_TOOLS;
  let token;
  if (opts["token-env"] !== undefined) {
    token = process.env[opts["token-env"]];
    if (!token) throw new lib.UsageError(`--token-env ${opts["token-env"]} names a variable that is not set or is empty`);
  }
  const hostname = new URL(baseUrl).hostname;
  const secrets = token ? [token] : [];
  const notes = [`node: ${process.version}`, `token: ${token ? `from ${opts["token-env"]}` : "none (the checks that need one are skipped)"}`, "read-only: nothing is written and no provider is called"];
  if (token && baseUrl.startsWith("http:") && !isLoopback(hostname)) {
    const warning = "warning: the token is sent over plain http to an address that is not this machine";
    notes.push(warning);
    process.stderr.write(`${warning}\n`); // before the first request, not only in the report at the end
  }
  const client = new lib.HttpClient({ baseUrl, token, timeoutMs, secrets });

  /** One check as a report step: what it saw is the summary only when it held. */
  async function check(name, fn) {
    const started = Date.now();
    const problems = [];
    let out = { summary: "ok" };
    try {
      const r = await fn(problems);
      if (typeof r === "string") out = { summary: r };
      else if (r && typeof r === "object") out = r;
    } catch (error) {
      problems.push(lib.redact(String(error.message), secrets));
      out = { summary: "no answer" };
    }
    const all = [...problems, ...(out.problems || [])];
    return lib.driverStep(name, all, all.length ? (out.summary === "no answer" ? "no answer" : "different") : out.summary, Date.now() - started, all.length ? undefined : out.status, out.notes);
  }
  const skipped = (name) => ({ ...lib.driverStep(name, [], "no token given", 0), skipped: true });

  const steps = [];
  steps.push(await check("health", async (problems) => {
    const res = await client.request("GET", "/health", { auth: false });
    if (res.status !== 200) problems.push(`GET /health answered ${res.status}`);
    else if (!res.json || res.json.status !== "ok") problems.push(`GET /health body is not {"status":"ok"}: ${res.text.slice(0, 80)}`);
    return "GET /health 200";
  }));
  steps.push(await check("ready", async (problems) => {
    const res = await client.request("GET", "/ready", { auth: false });
    if (res.status === 503) problems.push("GET /ready answered 503: the server says it is draining");
    else if (res.status !== 200) problems.push(`GET /ready answered ${res.status}`);
    else if (!res.json || res.json.status !== "ok") problems.push(`GET /ready body is not {"status":"ok"}: ${res.text.slice(0, 80)}`);
    return "GET /ready 200";
  }));
  steps.push(await check("auth: a request without the token", async () => {
    const res = await client.request("POST", "/mcp", { auth: false, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    return judgeUnauthenticated(res.status, hostname);
  }));

  let serverInfo;
  if (!token) {
    steps.push(skipped("handshake"), skipped("tools"), skipped("stats"));
  } else {
    steps.push(await check("handshake", async (problems) => {
      let init;
      try { init = await client.initialize({ name: "increadible-probe-remote", version: "1" }); } catch (error) {
        if (/HTTP 401/.test(error.message)) throw new Error("the token was not accepted (HTTP 401)");
        throw error;
      }
      serverInfo = init.serverInfo;
      if (!serverInfo || serverInfo.name !== "increadible") problems.push(`serverInfo.name is ${JSON.stringify(serverInfo && serverInfo.name)}, expected "increadible"`);
      if (!serverInfo || typeof serverInfo.version !== "string" || serverInfo.version === "") problems.push("serverInfo.version is missing");
      if (typeof init.protocolVersion !== "string") problems.push("protocolVersion is not a string");
      return `${serverInfo && serverInfo.name} ${serverInfo && serverInfo.version}`;
    }));
    steps.push(await check("tools", async (problems) => {
      const answer = await client.rpc("tools/list", {});
      const tools = answer.result && Array.isArray(answer.result.tools) ? answer.result.tools : null;
      if (!tools) throw new Error("tools/list did not answer a list");
      const names = tools.map((t) => t && t.name);
      if (new Set(names).size !== names.length) problems.push("two tools have the same name");
      if (tools.length !== expectTools) problems.push(`expected ${expectTools} tools, the server lists ${tools.length}`);
      return { summary: `${tools.length} tools`, notes: [names.join(", ")] };
    }));
    steps.push(await check("stats", async () => {
      const answer = await client.rpc("tools/call", { name: "get_api_stats", arguments: {} });
      if (answer.error) throw new Error(`get_api_stats failed: ${lib.scrub(answer.error.message)}`);
      const result = answer.result || {};
      if (result.isError) throw new Error("get_api_stats answered a tool error");
      const text = result.content && result.content[0] && result.content[0].text;
      let stats;
      try { stats = JSON.parse(text); } catch { throw new Error("get_api_stats did not answer JSON"); }
      return judgeStats(stats);
    }));
  }

  const results = [{ scenario: "remote probe (read-only)", ok: steps.every((s) => s.ok), steps }];
  const ok = results[0].ok;
  if (opts.json) console.log(JSON.stringify({ driver: "probe-remote", ok, target: baseUrl, server: lib.redactDeep(serverInfo, secrets), notes, results }, null, 2));
  else console.log(formatProbe({ target: baseUrl, notes, steps }));
  return ok ? 0 : 1;
}

module.exports = { main, USAGE, EXPECTED_TOOLS, isLoopback, judgeUnauthenticated, judgeStats };

if (require.main === module) lib.runCli("probe-remote", USAGE, main);
