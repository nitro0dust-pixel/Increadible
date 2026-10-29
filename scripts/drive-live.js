#!/usr/bin/env node
/**
 * Stage 4 of the request drivers (docs/DRIVERS.md, section 10): an opt-in live driver for the API gateway, tested against a local stub
 * of a provider. It drives the compiled gateway (dist/features/09-api-gateway/src/mcp-server.js) over real loopback HTTP against an
 * in-process stub server on 127.0.0.1, exercising the live-only paths that the sample-data scenarios of Stages 1 to 3 cannot reach:
 *   - live GET requests over the wire (query and header credentials, custom User-Agent, response caching);
 *   - credential scrubbing (a provider that echoes a key in an HTTP 500 body never leaks it into the error or logs);
 *   - redirect refusal (HTTP 302 is refused without following);
 *   - bounded retries (HTTP 503 retried once and succeeds; HTTP 429 with a short Retry-After waited out and retried);
 *   - HTTP 429 with a long Retry-After refused immediately, placing the API in cooldown and refusing follow-up calls before the network;
 *   - per-API rolling-minute rate limiting (GATEWAY_RATE_LIMITS) and the default rate limit (GATEWAY_DEFAULT_RATE_LIMIT);
 *   - request timeout (an unresponsive endpoint is aborted after timeoutMs and never retried) and response byte cap;
 *   - Wikimedia User-Agent contact enforcement in production mode (refused without contact, allowed with contact).
 * No real external provider is ever called by default; --live-probes opts in to running the keyless health probes against the real
 * providers when GATEWAY_CONTACT is set (an owner action on a machine with network access).
 *
 *   node scripts/drive-live.js [--root DIR] [--json] [--list] [--timeout-ms N] [--live-probes]
 * Exit code: 0 every check passed, 1 a check failed, 2 the driver could not run. Run `npm run build` first.
 */
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const lib = require("./drive-lib.js");

const USAGE = "usage: drive-live.js [--root DIR] [--json] [--list] [--timeout-ms N] [--live-probes]";
const KEY_Q = "stub-query-secret-9001";
const KEY_H = "stub-header-secret-9002";

function withQuietConsoleError(fn) {
  const orig = console.error;
  console.error = () => undefined;
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

function loadGateway(root) {
  const gwFile = path.join(root, "dist", "features", "09-api-gateway", "src", "mcp-server.js");
  const catFile = path.join(root, "dist", "features", "09-api-gateway", "src", "catalog.js");
  const probeFile = path.join(root, "dist", "features", "09-api-gateway", "src", "probes.js");
  if (!fs.existsSync(gwFile) || !fs.existsSync(catFile) || !fs.existsSync(probeFile)) {
    throw new Error(`${gwFile} does not exist: run "npm run build" in ${root} first`);
  }
  return withQuietConsoleError(() => ({ ...require(gwFile), ...require(catFile), ...require(probeFile) }));
}

/** Starts a local stub HTTP provider on 127.0.0.1 and a free port. Records every request it receives. */
async function startStubProvider() {
  const seen = [];
  let seq503 = 0;
  let seq429Short = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    seen.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const sendJson = (status, body, extraHeaders = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    switch (url.pathname) {
      case "/v1/ok":
        return sendJson(200, { ok: true, query: Object.fromEntries(url.searchParams), ua: req.headers["user-agent"] || "" });
      case "/v1/echo-secret":
        return sendJson(500, { error: `rejected key ${url.searchParams.get("appid") || ""} / ${req.headers["x-api-key"] || ""}` });
      case "/v1/redirect":
        res.writeHead(302, { location: "http://127.0.0.1:1/other" });
        return res.end();
      case "/v1/flaky-503":
        seq503 += 1;
        if (seq503 % 2 === 1) return sendJson(503, { error: "temporary overload" });
        return sendJson(200, { recovered: true, attempt: seq503 });
      case "/v1/retry-after-short":
        seq429Short += 1;
        if (seq429Short % 2 === 1) return sendJson(429, { error: "rate limited" }, { "retry-after": "0" });
        return sendJson(200, { after_429: true, attempt: seq429Short });
      case "/v1/retry-after-long":
        return sendJson(429, { error: "slow down" }, { "retry-after": "25" });
      case "/v1/slow":
        return; // hangs until client aborts
      case "/v1/oversize":
        return sendJson(200, { pad: "x".repeat(8192) });
      default:
        return sendJson(404, { error: "not found" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    reset() {
      seen.length = 0;
      seq503 = 0;
      seq429Short = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function makeApis(baseUrl) {
  const def = (id, endpoint = baseUrl, auth = "none") => ({
    id,
    name: id,
    category: "test",
    endpoint,
    methods: ["GET"],
    auth,
    free: true,
    description: `stub api ${id}`,
  });
  return {
    apis: [
      def("plain"),
      def("qkey", baseUrl, "api_key"),
      def("hkey", baseUrl, "api_key"),
      def("wikipedia", "https://en.wikipedia.org/w/api.php", "none"),
    ],
    credentials: {
      qkey: { env: "GATEWAY_KEY_QKEY", in: "query", name: "appid" },
      hkey: { env: "GATEWAY_KEY_HKEY", in: "header", name: "X-Api-Key" },
    },
  };
}

async function expectFail(promise) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

const CHECKS = [
  {
    id: "live.get-and-cache",
    title: "live GET reaches the stub provider with the configured User-Agent, caches the JSON answer, and counts 1 network call for 2 requests",
    async run(ctx, problems) {
      const gw = ctx.open({ userAgent: "increadible-gateway/test (https://example.org/contact)" });
      const first = await gw.callAPI("plain", "/ok", { q: "btc" });
      const second = await gw.callAPI("plain", "/ok", { q: "btc" });
      if (first.source !== "live" || first.cached !== false) problems.push(`first call: expected live uncached, got ${JSON.stringify(first)}`);
      if (!first.data || first.data.ok !== true || first.data.query.q !== "btc") problems.push(`first call data mismatch: ${JSON.stringify(first.data)}`);
      if (first.data && first.data.ua !== "increadible-gateway/test (https://example.org/contact)") problems.push(`User-Agent was not sent: ${JSON.stringify(first.data.ua)}`);
      if (second.source !== "live" || second.cached !== true) problems.push(`second call: expected cached live answer, got ${JSON.stringify(second)}`);
      const stats = gw.getStats();
      if (stats.live_calls !== 1 || stats.total_calls !== 2) problems.push(`expected 1 live call and 2 total calls, got live=${stats.live_calls} total=${stats.total_calls}`);
      return "live + cached (1 HTTP GET)";
    },
  },
  {
    id: "live.credentials-and-redaction",
    title: "query and header credentials reach the stub provider, missing credentials fail before the network, and echoed credentials are redacted from errors",
    async run(ctx, problems) {
      const gw = ctx.open();
      ctx.stub.reset();
      await gw.callAPI("qkey", "/ok", { item: "1" });
      await gw.callAPI("hkey", "/ok", { item: "2" });
      if (ctx.stub.seen.length !== 2) problems.push(`expected 2 requests, saw ${ctx.stub.seen.length}`);
      else {
        if (ctx.stub.seen[0].query.appid !== KEY_Q) problems.push("query credential was not added as appid");
        if (ctx.stub.seen[1].headers["x-api-key"] !== KEY_H) problems.push("header credential was not added as X-Api-Key");
      }
      const errQ = await expectFail(gw.callAPI("qkey", "/echo-secret"));
      const errH = await expectFail(gw.callAPI("hkey", "/echo-secret"));
      for (const [label, msg] of [["qkey", errQ], ["hkey", errH]]) {
        if (!msg) problems.push(`${label}: expected HTTP 500 to fail`);
        else if (msg.includes(KEY_Q) || msg.includes(KEY_H)) problems.push(`${label}: secret leaked in error message`);
        else if (!msg.includes("[redacted]")) problems.push(`${label}: expected [redacted] in error message, got ${msg}`);
      }
      const noCredGw = ctx.open({ env: {} });
      const before = ctx.stub.seen.length;
      const missingMsg = await expectFail(noCredGw.callAPI("qkey", "/ok"));
      if (!missingMsg || !missingMsg.includes("set GATEWAY_KEY_QKEY")) problems.push(`expected missing credential error naming GATEWAY_KEY_QKEY, got ${missingMsg}`);
      if (ctx.stub.seen.length !== before) problems.push("missing credential still sent a network request");
      return "query + header + redaction ok";
    },
  },
  {
    id: "live.redirect-refused",
    title: "an HTTP 302 redirect from a provider is refused without following",
    async run(ctx, problems) {
      const gw = ctx.open({ retries: 0 });
      const msg = await expectFail(gw.callAPI("plain", "/redirect"));
      if (!msg || !msg.includes("redirect (HTTP 302)")) problems.push(`expected redirect refusal, got ${JSON.stringify(msg)}`);
      return "HTTP 302 refused";
    },
  },
  {
    id: "live.retry-transient-503",
    title: "bounded retries recover from a transient HTTP 503 on the second attempt and count the retry",
    async run(ctx, problems) {
      ctx.stub.reset();
      const gw = ctx.open({ retries: 1 });
      const res = await gw.callAPI("plain", "/flaky-503", { n: 1 });
      if (!res.data || res.data.recovered !== true || res.data.attempt !== 2) problems.push(`expected recovery on attempt 2, got ${JSON.stringify(res.data)}`);
      const stats = gw.getStats();
      if (stats.retries !== 1 || stats.live_calls !== 2) problems.push(`expected retries=1 and live_calls=2, got retries=${stats.retries} live_calls=${stats.live_calls}`);
      return "503 -> 200 (1 retry)";
    },
  },
  {
    id: "live.retry-429-short",
    title: "HTTP 429 with a Retry-After within retryMaxWaitMs is waited out and retried to success",
    async run(ctx, problems) {
      ctx.stub.reset();
      const gw = ctx.open({ retries: 1, retryMaxWaitMs: 2000 });
      const res = await gw.callAPI("plain", "/retry-after-short", { n: 1 });
      if (!res.data || res.data.after_429 !== true) problems.push(`expected success after 429 retry, got ${JSON.stringify(res.data)}`);
      const stats = gw.getStats();
      if (stats.throttled !== 1 || stats.retries !== 1) problems.push(`expected throttled=1 and retries=1, got throttled=${stats.throttled} retries=${stats.retries}`);
      return "429 (Retry-After: 0) -> 200";
    },
  },
  {
    id: "live.cooldown-after-429-long",
    title: "HTTP 429 with a Retry-After above retryMaxWaitMs starts a cooldown and refuses follow-up calls before the network",
    async run(ctx, problems) {
      ctx.stub.reset();
      const gw = ctx.open({ retries: 1, retryMaxWaitMs: 1000 });
      const firstMsg = await expectFail(gw.callAPI("plain", "/retry-after-long", { n: 1 }));
      if (!firstMsg || !firstMsg.includes("HTTP 429 (retry after 25)")) problems.push(`expected HTTP 429 (retry after 25), got ${JSON.stringify(firstMsg)}`);
      const sentBefore = ctx.stub.seen.length;
      const secondMsg = await expectFail(gw.callAPI("plain", "/ok", { n: 2 }));
      if (!secondMsg || !secondMsg.includes("asked the gateway to slow down")) problems.push(`expected cooldown refusal, got ${JSON.stringify(secondMsg)}`);
      if (ctx.stub.seen.length !== sentBefore) problems.push("cooldown-refused call still reached the provider");
      const stats = gw.getStats();
      if (stats.cooldown_refused !== 1 || !stats.cooldowns.plain) problems.push(`expected cooldown_refused=1 and active cooldown, got ${JSON.stringify(stats)}`);
      return "429 cooldown enforced";
    },
  },
  {
    id: "live.rate-limits",
    title: "per-API rate limit (GATEWAY_RATE_LIMITS) and default rate limit (GATEWAY_DEFAULT_RATE_LIMIT) refuse calls over the rolling-minute cap before the network",
    async run(ctx, problems) {
      ctx.stub.reset();
      const gw = ctx.open({ defaultRateLimit: 2, rateLimits: { qkey: 1 } });
      await gw.callAPI("plain", "/ok", { r: 1 });
      await gw.callAPI("plain", "/ok", { r: 2 });
      const sentBefore = ctx.stub.seen.length;
      const defaultMsg = await expectFail(gw.callAPI("plain", "/ok", { r: 3 }));
      if (!defaultMsg || !defaultMsg.includes("at most 2 live calls per minute to this API (GATEWAY_DEFAULT_RATE_LIMIT)")) {
        problems.push(`expected default rate-limit refusal, got ${JSON.stringify(defaultMsg)}`);
      }
      await gw.callAPI("qkey", "/ok", { r: 1 });
      const perApiMsg = await expectFail(gw.callAPI("qkey", "/ok", { r: 2 }));
      if (!perApiMsg || !perApiMsg.includes("at most 1 live calls per minute to this API (GATEWAY_RATE_LIMITS)")) {
        problems.push(`expected per-API rate-limit refusal, got ${JSON.stringify(perApiMsg)}`);
      }
      if (ctx.stub.seen.length !== sentBefore + 1) problems.push(`expected only 1 additional network request, saw ${ctx.stub.seen.length - sentBefore}`);
      if (gw.getStats().rate_limited !== 2) problems.push(`expected rate_limited=2, got ${gw.getStats().rate_limited}`);
      return "default (2/min) + per-API (1/min) ok";
    },
  },
  {
    id: "live.timeout-and-size-cap",
    title: "an unresponsive provider times out without retrying, and an oversize body is refused at maxResponseBytes",
    async run(ctx, problems) {
      ctx.stub.reset();
      const gw = ctx.open({ timeoutMs: 150, maxResponseBytes: 1024, retries: 2 });
      const timeoutMsg = await expectFail(gw.callAPI("plain", "/slow", { t: 1 }));
      if (!timeoutMsg || !timeoutMsg.includes("timed out after 150 ms")) problems.push(`expected timeout after 150 ms, got ${JSON.stringify(timeoutMsg)}`);
      if (ctx.stub.seen.length !== 1) problems.push(`a timeout must not be retried: expected 1 request, saw ${ctx.stub.seen.length}`);
      const sizeMsg = await expectFail(gw.callAPI("plain", "/oversize", { t: 2 }));
      if (!sizeMsg || !sizeMsg.includes("larger than 1024 bytes")) problems.push(`expected size-cap refusal, got ${JSON.stringify(sizeMsg)}`);
      return "timeout (150 ms, no retry) + 1024 B cap ok";
    },
  },
  {
    id: "live.wikimedia-contact-rule",
    title: "in production mode, Wikimedia calls without a User-Agent contact are refused before the network",
    async run(ctx, problems) {
      const gw = ctx.open({ production: true, userAgent: "increadible-gateway/test" });
      const msg = await expectFail(gw.callAPI("wikipedia", "/", { action: "query" }));
      if (!msg || !msg.includes("Wikimedia requires a User-Agent with contact information")) {
        problems.push(`expected Wikimedia contact refusal, got ${JSON.stringify(msg)}`);
      }
      if (gw.getStats().contact_refused !== 1) problems.push(`expected contact_refused=1, got ${gw.getStats().contact_refused}`);
      return "Wikimedia contact rule enforced";
    },
  },
];

async function runStubChecks(gwMod, timeoutMs) {
  const stub = await startStubProvider();
  const { apis, credentials } = makeApis(stub.baseUrl);
  const secrets = [KEY_Q, KEY_H];
  const steps = [];
  const ctx = {
    stub,
    open(overrides = {}) {
      return withQuietConsoleError(
        () =>
          new gwMod.UniversalAPIGateway({
            apis,
            credentials,
            liveApis: "*",
            env: { GATEWAY_KEY_QKEY: KEY_Q, GATEWAY_KEY_HKEY: KEY_H },
            timeoutMs: Math.min(timeoutMs, 2000),
            maxResponseBytes: 65536,
            retries: 0,
            sleep: async () => undefined,
            ...overrides,
          })
      );
    },
  };
  try {
    for (const check of CHECKS) {
      const started = Date.now();
      const problems = [];
      let summary = "ok";
      try {
        summary = (await check.run(ctx, problems)) || "ok";
      } catch (error) {
        problems.push(lib.redact(error.message, secrets));
        summary = "error";
      }
      steps.push(lib.driverStep(check.id, problems, problems.length ? "failed" : summary, Date.now() - started));
    }
  } finally {
    await stub.close();
  }
  return { stubUrl: stub.baseUrl, steps };
}

async function runLiveProbeSteps(gwMod) {
  const userAgent = gwMod.userAgentFromEnv();
  if (!gwMod.hasContact(userAgent)) {
    throw new lib.UsageError("--live-probes requires GATEWAY_CONTACT to be set to an email address or http(s) URL");
  }
  const entries = gwMod.CATALOG.filter((e) => e.gate.probe && e.definition.auth === "none");
  const steps = [];
  for (const { definition, gate } of entries) {
    const id = definition.id;
    const started = Date.now();
    const problems = [];
    let summary = "ok";
    try {
      const gw = withQuietConsoleError(() => new gwMod.UniversalAPIGateway({ liveApis: [id], userAgent, retries: 0, defaultRateLimit: 0 }));
      const res = await gw.callAPI(id, gate.probe.endpoint, gate.probe.params);
      if (res.source !== "live") problems.push(`${id}: expected live source, got ${res.source}`);
      else problems.push(...gwMod.probeProblems(id, res.data));
      summary = problems.length === 0 ? "HTTP 200 live" : "failed";
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      summary = "failed";
    }
    steps.push(lib.driverStep(`provider.${id}`, problems, summary, Date.now() - started));
  }
  return steps;
}

async function main(argv) {
  const opts = lib.parseArgs(argv, {
    string: ["root", "timeout-ms"],
    boolean: ["json", "list", "help", "live-probes"],
  });
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts._.length) throw new lib.UsageError(`unexpected argument "${opts._[0]}"`);
  if (opts.list) {
    for (const c of CHECKS) console.log(`${c.id.padEnd(36)} ${c.title}`);
    return 0;
  }
  const timeoutMs = opts["timeout-ms"] !== undefined ? lib.parseInteger("timeout-ms", opts["timeout-ms"]) : 10000;
  const root = path.resolve(opts.root || lib.REPO_ROOT);
  const gwMod = loadGateway(root);
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const { stubUrl, steps } = await runStubChecks(gwMod, timeoutMs);
  if (opts["live-probes"]) {
    steps.push(...(await runLiveProbeSteps(gwMod)));
  }
  const results = [{ scenario: opts["live-probes"] ? "live gateway (stub + real keyless probes)" : "live gateway (local stub)", ok: steps.every((s) => s.ok), steps }];
  const notes = [
    `node: ${process.version}`,
    `server: ${root} (package version ${version})`,
    `stub provider: ${stubUrl} (closed afterwards)`,
    `real providers: ${opts["live-probes"] ? "probed (keyless four)" : "not called (pass --live-probes with GATEWAY_CONTACT set to probe the keyless four)"}`,
  ];
  const ok = results[0].ok;
  if (opts.json) console.log(JSON.stringify({ driver: "live", ok, target: stubUrl, notes, results }, null, 2));
  else console.log(lib.formatReport({ driver: "live", target: stubUrl, results, notes }));
  return ok ? 0 : 1;
}

module.exports = { main, USAGE, CHECKS, startStubProvider };

if (require.main === module) lib.runCli("drive-live", USAGE, main);
