import * as crypto from "crypto";
import * as http from "http";
import * as readline from "readline";
import { Readable, Writable } from "stream";
import { handleMessage, internalError, metrics, renderPrometheusMetrics, JsonRpcResponse } from "./server";

const MAX_BODY_BYTES = 1_000_000;
// Time allowed to *receive* a request (not to handle it). Node's own defaults are 60 s and 300 s, which lets one slow client hold a socket for 5 minutes.
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Newline-delimited JSON-RPC over a stream pair (the MCP stdio transport). */
export function serveStdio(input: Readable, output: Writable): Promise<void> {
  const rl = readline.createInterface({ input });
  const send = (r: JsonRpcResponse) => output.write(JSON.stringify(r) + "\n");
  let pending = Promise.resolve();

  rl.on("line", (line) => {
    if (!line.trim()) return;
    // Serialise handling so responses keep request order.
    pending = pending.then(async () => {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      try {
        const reply = await handleMessage(parsed);
        if (reply) send(reply);
      } catch (error) {
        // handleMessage reports tool failures itself; this keeps one bad message from ending the whole session.
        if (parsed?.id !== undefined) send(internalError(parsed.id, error));
      }
    });
  });
  return new Promise((resolve) => rl.on("close", () => pending.then(resolve)));
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Token bucket: `perMinute` requests of burst, refilled continuously. Returns 0 when the request may proceed,
 * otherwise the seconds to wait. 0 or less turns the limiter off.
 */
export function createRateLimiter(perMinute: number, now: () => number = Date.now): () => number {
  if (!(perMinute > 0)) return () => 0;
  let tokens = perMinute;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(perMinute, tokens + ((t - last) * perMinute) / 60_000);
    last = t;
    if (tokens >= 1) {
      tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - tokens) * 60) / perMinute));
  };
}

export interface HttpOptions {
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Global limit on POST /mcp (the bearer token is shared, so there is no per-client key). 0 or unset: off. */
  rateLimitPerMinute?: number;
}

export interface DrainableServer extends http.Server {
  /** While draining, /ready answers 503 (so a load balancer stops sending traffic) and everything else keeps working. */
  setDraining(draining: boolean): void;
}

/** HTTP mode: /health, /ready, /metrics and a stateless JSON-RPC endpoint at POST /mcp. */
export function createHttpServer(authToken?: string, options: HttpOptions = {}): DrainableServer {
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let headersTimeout = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  if (requestTimeout > 0 && headersTimeout > requestTimeout) headersTimeout = requestTimeout; // Node rejects the reverse
  // Node only checks timeouts every connectionsCheckingInterval (30 s by default), which would stretch a 10 s limit to 40 s.
  const checkEvery = Math.max(50, Math.min(5_000, Math.floor((headersTimeout || requestTimeout || 10_000) / 2)));
  const takeToken = createRateLimiter(options.rateLimitPerMinute ?? 0);
  let draining = false;

  const server = http.createServer(
    { headersTimeout, requestTimeout, connectionsCheckingInterval: checkEvery },
    (req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const refuse = (status: number, reason: string, body: unknown, extra: http.OutgoingHttpHeaders = {}) => {
        if (!res.headersSent) {
          metrics.http_rejected[reason] = (metrics.http_rejected[reason] || 0) + 1; // once per request, not per body chunk
          res.writeHead(status, { "Content-Type": "application/json", Connection: "close", ...extra });
          res.end(JSON.stringify(body), () => req.destroy());
        }
      };

      if (req.method === "GET" && req.url === "/health") return json(200, { status: "ok" });
      if (req.method === "GET" && req.url === "/ready") {
        return draining ? json(503, { status: "draining" }) : json(200, { status: "ok" });
      }
      if (authToken && !tokenMatches(req.headers.authorization, authToken)) {
        metrics.http_rejected.unauthorized = (metrics.http_rejected.unauthorized || 0) + 1;
        return json(401, { error: "Unauthorized" });
      }
      if (req.method === "GET" && req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        return res.end(renderPrometheusMetrics());
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const retryAfter = takeToken();
        if (retryAfter) return refuse(429, "rate_limited", { error: "Too many requests" }, { "Retry-After": String(retryAfter) });

        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) return refuse(413, "payload_too_large", { error: "Payload too large" });
          chunks.push(c);
        });
        req.on("end", async () => {
          if (res.writableEnded) return;
          let parsed: any;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          }
          try {
            const reply = await handleMessage(parsed);
            if (!reply) {
              res.writeHead(202);
              return res.end();
            }
            json(200, reply);
          } catch (error) {
            // Never let a handler failure escape this async callback: an unhandled rejection ends the process.
            if (!res.headersSent) json(500, internalError(parsed?.id ?? null, error));
          }
        });
        return;
      }
      json(404, { error: "Not found" });
    }
  ) as DrainableServer;
  server.setDraining = (value) => {
    draining = value;
  };
  return server;
}

export interface ShutdownOptions {
  /** How long to keep serving, with /ready answering 503, before closing (time for a load balancer to notice). */
  drainMs: number;
  /** After closing starts, how long in-flight requests get before the remaining connections are cut. */
  timeoutMs: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

/**
 * Returns the signal handler: drain, stop accepting, let in-flight requests finish, and exit 0. If they are still
 * running after `timeoutMs` the connections are cut and the exit code is 1, so a stalled client cannot hold the
 * process until the orchestrator sends SIGKILL (which would leave the A/B data file lock behind).
 */
export function installShutdown(server: DrainableServer, options: ShutdownOptions): (signal: string) => void {
  const { drainMs, timeoutMs, exit = (code) => process.exit(code), log = console.error } = options;
  let started = false;
  return (signal) => {
    if (started) return;
    started = true;
    log(`${signal}: draining for ${drainMs} ms, then closing (connections are cut ${timeoutMs} ms after that)`);
    server.setDraining(true);
    setTimeout(() => {
      const deadline = setTimeout(() => {
        log("shutdown deadline passed: cutting the remaining connections");
        server.closeAllConnections();
        exit(1);
      }, timeoutMs);
      server.close(() => {
        clearTimeout(deadline);
        exit(0);
      });
      server.closeIdleConnections();
    }, drainMs);
  };
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;

/**
 * An HTTP server reachable beyond this machine must not run without a token: an empty AUTH_TOKEN (for example an
 * empty Kubernetes secret value) would otherwise silently turn authentication off. Returns the reason to refuse, or null.
 */
export function exposureProblem(host: string, token: string | undefined, allowUnauthenticated: string | undefined): string | null {
  if ((token ?? "").trim() !== "") return null;
  if (LOOPBACK_HOST.test(host.trim())) return null;
  if (/^(1|true|yes)$/i.test(allowUnauthenticated ?? "")) return null;
  return (
    `Refusing to listen on ${host} without AUTH_TOKEN: /mcp and /metrics would be open to anything that can reach the port. ` +
    "Set AUTH_TOKEN, bind HOST=127.0.0.1, or set ALLOW_UNAUTHENTICATED=1 if something in front of this server authenticates."
  );
}

/** A non-negative integer setting from the environment; anything else (blank, negative, fractional, text) falls back, with a warning. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`Ignoring ${name}="${raw}": expected a non-negative integer (using ${fallback})`);
    return fallback;
  }
  return value;
}

if (require.main === module) {
  const port = process.env.PORT;
  if (port || process.argv.includes("--http")) {
    const host = process.env.HOST || "127.0.0.1";
    const token = (process.env.AUTH_TOKEN ?? "").trim() !== "" ? process.env.AUTH_TOKEN : undefined;
    const problem = exposureProblem(host, token, process.env.ALLOW_UNAUTHENTICATED);
    if (problem) {
      console.error(problem);
      process.exit(1);
    }
    if (!token && !LOOPBACK_HOST.test(host.trim())) {
      console.error(`WARNING: serving on ${host} without authentication (ALLOW_UNAUTHENTICATED is set)`);
    }
    const server = createHttpServer(token, {
      headersTimeoutMs: envInt("HTTP_HEADERS_TIMEOUT_MS", DEFAULT_HEADERS_TIMEOUT_MS),
      requestTimeoutMs: envInt("HTTP_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
      rateLimitPerMinute: envInt("RATE_LIMIT_PER_MINUTE", 0),
    });
    server.listen(Number(port || 3000), host, () =>
      console.error(`increadible listening on http://${host}:${port || 3000}`)
    );
    const shutdown = installShutdown(server, {
      drainMs: envInt("SHUTDOWN_DRAIN_MS", 0),
      timeoutMs: envInt("SHUTDOWN_TIMEOUT_MS", 10_000),
    });
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } else {
    // Exiting through process.exit runs the 'exit' hook that releases the A/B data file lock.
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
    serveStdio(process.stdin, process.stdout).then(() => process.exit(0));
  }
}
