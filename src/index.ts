import * as crypto from "crypto";
import * as http from "http";
import * as readline from "readline";
import { Readable, Writable } from "stream";
import { handleMessage, renderPrometheusMetrics, JsonRpcResponse } from "./server";

const MAX_BODY_BYTES = 1_000_000;

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
      const reply = await handleMessage(parsed);
      if (reply) send(reply);
    });
  });
  return new Promise((resolve) => rl.on("close", () => pending.then(resolve)));
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** HTTP mode: /health, /ready, /metrics and a stateless JSON-RPC endpoint at POST /mcp. */
export function createHttpServer(authToken?: string): http.Server {
  return http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && (req.url === "/health" || req.url === "/ready")) {
      return json(200, { status: "ok" });
    }
    if (authToken && !tokenMatches(req.headers.authorization, authToken)) {
      return json(401, { error: "Unauthorized" });
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      return res.end(renderPrometheusMetrics());
    }
    if (req.method === "POST" && req.url === "/mcp") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          if (!res.headersSent) {
            res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
            res.end(JSON.stringify({ error: "Payload too large" }), () => req.destroy());
          }
          return;
        }
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
        const reply = await handleMessage(parsed);
        if (!reply) {
          res.writeHead(202);
          return res.end();
        }
        json(200, reply);
      });
      return;
    }
    json(404, { error: "Not found" });
  });
}

if (require.main === module) {
  const port = process.env.PORT;
  if (port || process.argv.includes("--http")) {
    const host = process.env.HOST || "127.0.0.1";
    const server = createHttpServer(process.env.AUTH_TOKEN);
    server.listen(Number(port || 3000), host, () =>
      console.error(`increadible listening on http://${host}:${port || 3000}`)
    );
    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } else {
    // Exiting through process.exit runs the 'exit' hook that releases the A/B data file lock.
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
    serveStdio(process.stdin, process.stdout).then(() => process.exit(0));
  }
}
