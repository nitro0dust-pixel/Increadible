#!/usr/bin/env node
/**
 * Probes the server's protocol behaviour on both transports: the cases a well-behaved client never sends (malformed JSON, a batch, a
 * message nobody answers, an oversize body, a foreign Origin) and the way the server ends. It records what THIS server does today; it is
 * not a conformance suite. Every check is one of
 *   contract  the behaviour the server is meant to have; a different answer fails the run;
 *   known     behaviour that differs from what the MCP specification asks (the note says what it asks); the recorded behaviour is expected,
 *             and a different one fails the run too, so a fix is noticed and the record is updated;
 *   observed  behaviour with no specification claim attached.
 *   node scripts/drive-probe.js [--transport stdio|http|both] [--root DIR] [--json] [--list] [--timeout-ms N]
 * Exit code: 0 every check matched, 1 a check did not, 2 the driver could not run. Run `npm run build` first. How to read it: docs/DRIVERS.md.
 */
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./drive-lib.js");

const USAGE = "usage: drive-probe.js [--transport stdio|http|both] [--root DIR] [--json] [--list] [--timeout-ms N]";
const SPEC = "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports";
const SPEC_NOTE = "the page was summarised when this driver was written (2026-10-14) and is not re-read for every release: read it before relying on it";
const spec = (text) => `${text} Source: ${SPEC} (${SPEC_NOTE}).`;
const JSON_HEADERS = { "Content-Type": "application/json" };
const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Pushes a problem unless the two values are equal. */
function eq(problems, what, actual, wanted) {
  if (!same(actual, wanted)) problems.push(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}
const errorOf = (m) => (m && m.error ? { code: m.error.code, id: m.id } : { notAnError: m });

// ---------------------------------------------------------------- the checks

/** Each run(ctx, problems) pushes what is wrong and returns a short account of what it saw. ctx.stdio() / ctx.http() start a server once and share it. */
const CHECKS = [
  // ---- stdio
  { id: "stdio.version-is-echoed", transport: "stdio", kind: "contract", title: "initialize answers the version the client names (2025-06-18) and 2024-11-05 when none is named",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      const named = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
      const none = await c.request("initialize");
      eq(problems, "version when named", named.result && named.result.protocolVersion, "2025-06-18");
      eq(problems, "version when not named", none.result && none.result.protocolVersion, "2024-11-05");
      return `${named.result && named.result.protocolVersion} / ${none.result && none.result.protocolVersion}`;
    } },
  { id: "stdio.unknown-version-is-echoed", transport: "stdio", kind: "known", title: "initialize echoes a version it cannot speak (1999-01-01)",
    note: spec("The lifecycle rules ask a server that does not support the requested version to answer with one it does support. This server answers whatever it was asked."),
    async run(ctx, problems) {
      const c = await ctx.stdio();
      const r = await c.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
      eq(problems, "protocolVersion", r.result && r.result.protocolVersion, "1999-01-01");
      return `echoed ${r.result && r.result.protocolVersion}`;
    } },
  { id: "stdio.string-id-is-echoed", transport: "stdio", kind: "contract", title: "a string id comes back as the same string",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      c.sendRaw('{"jsonrpc":"2.0","id":"abc-1","method":"ping"}');
      const got = await c.takeUnmatched(1);
      eq(problems, "answers", got.map((m) => ({ id: m.id, result: m.result })), [{ id: "abc-1", result: {} }]);
      return "id abc-1";
    } },
  { id: "stdio.parse-error", transport: "stdio", kind: "contract", title: "a line that is not JSON gets -32700 with id null, and the server carries on",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      c.sendRaw("{this is not json");
      const got = await c.takeUnmatched(1);
      eq(problems, "answer", got.map(errorOf), [{ code: -32700, id: null }]);
      eq(problems, "ping afterwards", (await c.request("ping")).result, {});
      return "-32700, still serving";
    } },
  { id: "stdio.batch-refused", transport: "stdio", kind: "contract", title: "a JSON array (a batch) gets one -32600 with id null",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      c.sendRaw('[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]');
      const got = await c.takeUnmatched(2, 600);
      eq(problems, "answers", got.map(errorOf), [{ code: -32600, id: null }]);
      return "one -32600";
    } },
  { id: "stdio.invalid-request", transport: "stdio", kind: "contract", title: "a message without \"jsonrpc\" gets -32600 with its own id",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      c.sendRaw('{"id":501,"method":"ping"}');
      const got = await c.takeUnmatched(1);
      eq(problems, "answer", got.map(errorOf), [{ code: -32600, id: 501 }]);
      return "-32600 id 501";
    } },
  { id: "stdio.notification-is-silent", transport: "stdio", kind: "contract", title: "a notification (no id) gets no answer",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      c.notify("notifications/cancelled", { requestId: 999 });
      const got = await c.takeUnmatched(1, 400);
      eq(problems, "answers", got, []);
      eq(problems, "ping afterwards", (await c.request("ping")).result, {});
      return "silence, then ping";
    } },
  { id: "stdio.errors", transport: "stdio", kind: "contract", title: "an unknown method is -32601 and an unknown tool is -32602",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      eq(problems, "unknown method", errorOf(await c.request("no/such/method")).code, -32601);
      eq(problems, "unknown tool", errorOf(await c.request("tools/call", { name: "no_such_tool", arguments: {} })).code, -32602);
      return "-32601, -32602";
    } },
  { id: "stdio.tool-schemas", transport: "stdio", kind: "contract", title: "every listed tool has a name, a description and an object schema whose required names are declared",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      const tools = (await c.request("tools/list")).result.tools;
      const names = new Set();
      for (const tool of tools) {
        if (names.has(tool.name)) problems.push(`${tool.name}: listed twice`);
        names.add(tool.name);
        if (typeof tool.description !== "string" || tool.description === "") problems.push(`${tool.name}: no description`);
        const schema = tool.inputSchema || {};
        if (schema.type !== "object") problems.push(`${tool.name}: inputSchema.type is ${JSON.stringify(schema.type)}, not "object"`);
        for (const required of schema.required || []) if (!(required in (schema.properties || {}))) problems.push(`${tool.name}: required "${required}" is not a property`);
      }
      if (tools.length === 0) problems.push("tools/list is empty");
      return `${tools.length} tools`;
    } },
  { id: "stdio.big-line-is-answered", transport: "stdio", kind: "known", title: "a 5,000,000-byte request line is answered (HTTP refuses more than 1,000,000 bytes)",
    note: "Not a specification rule: the HTTP transport caps a body at 1,000,000 bytes (413), the stdio transport has no cap on a line. Recorded so a change is noticed.",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      const r = await c.request("ping", { padding: "a".repeat(5_000_000) }, 15000);
      eq(problems, "answer", r.result, {});
      return "answered";
    } },
  { id: "stdio.stdout-is-clean", transport: "stdio", kind: "contract", title: "after all of the above stdout carried nothing but JSON-RPC answers",
    async run(ctx, problems) {
      const c = await ctx.stdio();
      await c.takeUnmatched(1, 200);
      eq(problems, "lines that are not JSON", c.nonJsonLines, []);
      return "clean";
    } },
  { id: "stdio.leaves-on-stdin-close", transport: "stdio", kind: "contract", title: "closing stdin ends the server with exit code 0",
    async run(ctx, problems) {
      const c = ctx.privateStdio();
      await c.initialize();
      const ended = await c.stop(4000);
      eq(problems, "how it ended", { how: ended.how, code: ended.code }, { how: "stdin closed", code: 0 });
      return `${ended.how}, exit ${ended.code}`;
    } },
  { id: "stdio.leaves-on-sigterm", transport: "stdio", kind: "contract", title: "SIGTERM ends the server with exit code 0",
    async run(ctx, problems) {
      const c = ctx.privateStdio();
      await c.initialize();
      const ended = await c.proc.stop({ stdinFirst: false, graceMs: 4000 });
      eq(problems, "how it ended", { how: ended.how, code: ended.code }, { how: "SIGTERM", code: 0 });
      return `${ended.how}, exit ${ended.code}`;
    } },

  // ---- http
  { id: "http.probes-need-no-token", transport: "http", kind: "contract", title: "/health and /ready answer 200 without the token",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      for (const route of ["/health", "/ready"]) {
        const r = await client.request("GET", route, { auth: false });
        eq(problems, `GET ${route}`, { status: r.status, body: r.json }, { status: 200, body: { status: "ok" } });
      }
      return "200, 200";
    } },
  { id: "http.metrics-need-the-token", transport: "http", kind: "contract", title: "/metrics is refused without the token and served with it",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      eq(problems, "without the token", (await client.request("GET", "/metrics", { auth: false })).status, 401);
      const r = await client.request("GET", "/metrics");
      eq(problems, "with the token", r.status, 200);
      if (!String(r.headers["content-type"]).startsWith("text/plain")) problems.push(`content-type is ${r.headers["content-type"]}, not text/plain`);
      return "401, 200";
    } },
  { id: "http.mcp-needs-the-token", transport: "http", kind: "contract", title: "POST /mcp is refused with 401 without the token and with a wrong one",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      const none = await client.request("POST", "/mcp", { auth: false, headers: JSON_HEADERS, body: PING });
      const wrong = await client.request("POST", "/mcp", { auth: false, headers: { ...JSON_HEADERS, Authorization: "Bearer not-the-token" }, body: PING });
      eq(problems, "no token", { status: none.status, body: none.json }, { status: 401, body: { error: "Unauthorized" } });
      eq(problems, "wrong token", wrong.status, 401);
      eq(problems, "right token", (await client.request("POST", "/mcp", { headers: JSON_HEADERS, body: PING })).status, 200);
      return "401, 401, 200";
    } },
  { id: "http.notification-gets-202", transport: "http", kind: "contract", title: "a notification gets 202 and an empty body",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      const r = await client.request("POST", "/mcp", { headers: JSON_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
      eq(problems, "status and body", { status: r.status, body: r.text }, { status: 202, body: "" });
      return "202";
    } },
  { id: "http.parse-error", transport: "http", kind: "contract", title: "malformed JSON and an empty body get 400 with -32700",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      for (const [what, body] of [["malformed", "{bad json"], ["empty", ""]]) {
        const r = await client.request("POST", "/mcp", { headers: JSON_HEADERS, body });
        eq(problems, what, { status: r.status, error: r.json && errorOf(r.json) }, { status: 400, error: { code: -32700, id: null } });
      }
      return "400, 400";
    } },
  { id: "http.batch-and-scalars-refused", transport: "http", kind: "contract", title: "an array and a bare number get 200 with one -32600",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      for (const [what, body] of [["array", `[${PING},${PING}]`], ["number", "42"]]) {
        const r = await client.request("POST", "/mcp", { headers: JSON_HEADERS, body });
        eq(problems, what, { status: r.status, error: r.json && errorOf(r.json) }, { status: 200, error: { code: -32600, id: null } });
      }
      return "200 -32600 x2";
    } },
  { id: "http.oversize-body", transport: "http", kind: "contract", title: "a body of 1,000,001 bytes gets 413 and the server keeps serving",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      const r = await client.request("POST", "/mcp", { headers: JSON_HEADERS, body: Buffer.alloc(1_000_001, 97) });
      eq(problems, "oversize", { status: r.status, body: r.json }, { status: 413, body: { error: "Payload too large" } });
      eq(problems, "ping afterwards", (await client.request("POST", "/mcp", { headers: JSON_HEADERS, body: PING })).status, 200);
      return "413, still serving";
    } },
  { id: "http.unknown-routes", transport: "http", kind: "contract", title: "unknown paths, /mcp/ with a slash and OPTIONS get 404 and no CORS headers",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      for (const [method, route] of [["GET", "/nope"], ["POST", "/mcp/"], ["OPTIONS", "/mcp"]]) {
        const r = await client.request(method, route, { headers: { ...JSON_HEADERS, Origin: "http://example.test" }, body: method === "POST" ? PING : undefined });
        eq(problems, `${method} ${route}`, r.status, 404);
        if (r.headers["access-control-allow-origin"]) problems.push(`${method} ${route}: a CORS header was sent`);
      }
      return "404 x3";
    } },
  { id: "http.get-mcp-is-404", transport: "http", kind: "known", title: "GET /mcp (the optional event stream) answers 404",
    note: spec("The Streamable HTTP rules ask a server that offers no event stream to answer 405 Method Not Allowed to this GET. This server answers 404."),
    async run(ctx, problems) {
      const { client } = await ctx.http();
      const r = await client.request("GET", "/mcp", { headers: { Accept: "text/event-stream" } });
      eq(problems, "status", r.status, 404);
      return "404";
    } },
  { id: "http.origin-and-host-are-not-validated", transport: "http", kind: "known", title: "a foreign Origin and a foreign Host header are accepted (with the token)",
    note: spec("The rules ask a server to validate the Origin header against DNS-rebinding attacks. This server does not; the bearer token is what protects /mcp, and a browser page cannot add it. Decision pending with the owner."),
    async run(ctx, problems) {
      const { client } = await ctx.http();
      const origin = await client.request("POST", "/mcp", { headers: { ...JSON_HEADERS, Origin: "http://evil.example" }, body: PING });
      const host = await client.request("POST", "/mcp", { headers: { ...JSON_HEADERS, Host: "evil.example" }, body: PING });
      eq(problems, "foreign Origin", origin.status, 200);
      eq(problems, "foreign Host", host.status, 200);
      return "200, 200";
    } },
  { id: "http.protocol-version-header-is-ignored", transport: "http", kind: "known", title: "an invalid MCP-Protocol-Version header (1999-01-01) is accepted",
    note: spec("The rules ask a server to answer 400 to an invalid or unsupported MCP-Protocol-Version header. This server ignores the header."),
    async run(ctx, problems) {
      const { client } = await ctx.http();
      const r = await client.request("POST", "/mcp", { headers: { ...JSON_HEADERS, "MCP-Protocol-Version": "1999-01-01" }, body: PING });
      eq(problems, "status", r.status, 200);
      return "200";
    } },
  { id: "http.content-type-is-not-checked", transport: "http", kind: "observed", title: "a JSON body sent as text/plain is accepted",
    async run(ctx, problems) {
      const { client } = await ctx.http();
      const r = await client.request("POST", "/mcp", { headers: { "Content-Type": "text/plain" }, body: PING });
      eq(problems, "status", r.status, 200);
      return "200";
    } },
  { id: "http.leaves-on-sigterm", transport: "http", kind: "contract", title: "SIGTERM ends the server with exit code 0",
    async run(ctx, problems) {
      const server = await ctx.http();
      const ended = await server.proc.stop({ stdinFirst: false, graceMs: 5000 });
      server.stopped = true;
      eq(problems, "how it ended", { how: ended.how, code: ended.code }, { how: "SIGTERM", code: 0 });
      return `${ended.how}, exit ${ended.code}`;
    } },
];

// ---------------------------------------------------------------- running them

function makeContext(root, timeoutMs, secretsOut) {
  const dir = lib.makeWorkdir();
  const owned = [];
  let shared;
  let server;
  return {
    dir,
    async stdio() {
      if (!shared) { shared = this.privateStdio(); await shared.initialize(); }
      return shared;
    },
    privateStdio() {
      const c = new lib.StdioClient({ args: [lib.entryPoint(root, "main.js")], env: lib.baseEnv(lib.dataEnv(dir)), cwd: root, requestTimeoutMs: timeoutMs });
      owned.push(c);
      return c;
    },
    async http() {
      if (!server) {
        const port = await lib.freePort();
        const token = crypto.randomBytes(18).toString("hex");
        secretsOut.push(token);
        const env = lib.baseEnv({ ...lib.dataEnv(dir), PORT: String(port), HOST: "127.0.0.1", AUTH_TOKEN: token });
        const proc = new lib.ManagedProcess({ args: [lib.entryPoint(root, "index.js")], env, cwd: root, secrets: [token] });
        const client = new lib.HttpClient({ baseUrl: `http://127.0.0.1:${port}`, token, timeoutMs, secrets: [token] });
        server = { proc, client, stopped: false };
        await client.waitReady(15000, () => proc.exit === null);
      }
      return server;
    },
    async close() {
      for (const c of owned) await c.proc.stop({ stdinFirst: true, graceMs: 2000 });
      if (server && !server.stopped) await server.proc.stop({ graceMs: 3000 });
      lib.removeWorkdir(dir);
    },
  };
}

async function runChecks(checks, root, timeoutMs) {
  const secrets = [];
  const ctx = makeContext(root, timeoutMs, secrets);
  const steps = [];
  try {
    for (const check of checks) {
      const started = Date.now();
      const problems = [];
      let observed = "";
      try { observed = (await check.run(ctx, problems)) || ""; } catch (error) { problems.push(lib.redact(error.message, secrets)); observed = "no answer"; }
      const status = check.kind === "known" ? "KNOWN" : check.kind === "observed" ? "INFO" : "PASS";
      const notes = problems.length === 0 ? (check.note ? [check.note] : undefined) : [`expected: ${check.title}`];
      steps.push({ ...lib.driverStep(check.id, problems, problems.length ? "different" : observed, Date.now() - started, status, notes), id: check.id, kind: check.kind });
    }
  } finally {
    await ctx.close();
  }
  return steps;
}

async function main(argv) {
  const opts = lib.parseArgs(argv, { string: ["transport", "root", "timeout-ms"], boolean: ["json", "list", "help"] });
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts._.length) throw new lib.UsageError(`unexpected argument "${opts._[0]}"`);
  const transport = opts.transport || "both";
  if (!["stdio", "http", "both"].includes(transport)) throw new lib.UsageError(`--transport must be stdio, http or both, got "${transport}"`);
  const selected = CHECKS.filter((c) => transport === "both" || c.transport === transport);
  if (opts.list) {
    for (const c of selected) console.log(`${c.id.padEnd(44)} ${c.kind.padEnd(9)} ${c.title}`);
    return 0;
  }
  const root = path.resolve(opts.root || lib.REPO_ROOT);
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const steps = await runChecks(selected, root, opts["timeout-ms"] ? Number(opts["timeout-ms"]) : 20000);
  const results = [{ scenario: `protocol probe (${transport})`, ok: steps.every((s) => s.ok), steps }];
  const notes = [`node: ${process.version}`, `server: ${root} (package version ${version})`, "legend: PASS contract met · KNOWN recorded deviation from the MCP spec, behaviour unchanged · INFO observed, no spec claim"];
  if (opts.json) console.log(JSON.stringify({ driver: "probe", ok: results[0].ok, target: root, notes, results }, null, 2));
  else console.log(lib.formatReport({ driver: "probe", target: root, results, notes }));
  return results[0].ok ? 0 : 1;
}

module.exports = { main, USAGE, CHECKS };

if (require.main === module) lib.runCli("drive-probe", USAGE, main);
