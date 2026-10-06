import * as routing from "../features/07-routing-plugins/src/mcp-server";
import * as abTesting from "../features/08-ab-testing/src/mcp-server";
import * as gateway from "../features/09-api-gateway/src/mcp-server";

export const SERVER_INFO = { name: "increadible", version: "1.0.0" };
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

interface ToolModule {
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  call: (name: string, input: Record<string, any>) => Promise<string>;
}

const modules: ToolModule[] = [
  {
    tools: [
      routing.applyRoutingRulesTool,
      routing.getRoutingStatsTool,
      routing.updateRulesTool,
      routing.suggestRulesTool,
    ],
    call: routing.processToolCall,
  },
  {
    tools: [
      abTesting.createExperimentTool,
      abTesting.assignVariantTool,
      abTesting.recordMetricTool,
      abTesting.getResultsTool,
      abTesting.recommendWinnerTool,
    ],
    call: abTesting.processToolCall,
  },
  {
    tools: [
      gateway.discoverAPIsTool,
      gateway.callAPITool,
      gateway.aggregateAPIsTool,
      gateway.getStatsTool,
    ],
    call: gateway.processToolCall,
  },
];

const toolOwners = new Map<string, ToolModule>();
for (const m of modules) for (const t of m.tools) toolOwners.set(t.name, m);

/** Upper bounds, in seconds, of the tool-call latency buckets: 1 ms to 10 s, from in-memory tools up to slow external calls. */
export const LATENCY_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  /** counts[i]: observations in (bucket[i-1], bucket[i]]; slower ones are only in `count` (the +Inf bucket). */
  counts: number[];
  sum: number;
  count: number;
}

const newHistogram = (): Histogram => ({ counts: LATENCY_BUCKETS_SECONDS.map(() => 0), sum: 0, count: 0 });

function observe(h: Histogram, seconds: number): void {
  const bucket = LATENCY_BUCKETS_SECONDS.findIndex((upper) => seconds <= upper);
  if (bucket >= 0) h.counts[bucket]++;
  h.sum += seconds;
  h.count++;
}

export const metrics = {
  started_at: Date.now(),
  tool_calls: {} as Record<string, number>,
  tool_errors: {} as Record<string, number>,
  tool_latency: {} as Record<string, Histogram>,
  /** How late the event loop ran a 10 ms timer: a synchronous task that blocks the loop shows up here, and in no per-call timer. */
  event_loop_delay: newHistogram(),
  rpc_errors: 0,
  http_rejected: {} as Record<string, number>,
};

export function observeToolLatency(tool: string, seconds: number): void {
  observe((metrics.tool_latency[tool] ??= newHistogram()), seconds);
}

const LOOP_TICK_MS = 10;
let loopTimer: NodeJS.Timeout | undefined;

/**
 * Measure event-loop delay: a 10 ms interval records how much later than due it ran. While a synchronous task holds the loop, no
 * request is read, no handler starts and no /health probe is answered, and nothing inside a handler can see that wait (a handler
 * only starts after the block), so a per-call or per-request timer misses it. Cumulative histogram, no resets. The timer is unref'd.
 */
export function startEventLoopMonitor(): void {
  if (loopTimer) return;
  let due = performance.now() + LOOP_TICK_MS;
  loopTimer = setInterval(() => {
    const now = performance.now();
    observe(metrics.event_loop_delay, Math.max(0, now - due) / 1000);
    due = now + LOOP_TICK_MS;
  }, LOOP_TICK_MS);
  loopTimer.unref();
}

export function stopEventLoopMonitor(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = undefined;
}

function renderHistogram(name: string, label: string | undefined, h: Histogram): string[] {
  const l = label ? `${label},` : "";
  const plain = label ? `{${label}}` : "";
  let cumulative = 0;
  return [
    ...LATENCY_BUCKETS_SECONDS.map((upper, i) => {
      cumulative += h.counts[i];
      return `${name}_bucket{${l}le="${upper}"} ${cumulative}`;
    }),
    `${name}_bucket{${l}le="+Inf"} ${h.count}`,
    `${name}_sum${plain} ${h.sum}`,
    `${name}_count${plain} ${h.count}`,
  ];
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const fail = (id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse => {
  metrics.rpc_errors++;
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
};

/** The reply for a failure the handler did not expect. Logged to stderr only (stdout carries the stdio protocol). */
export function internalError(id: JsonRpcRequest["id"], error: unknown): JsonRpcResponse {
  console.error("internal error:", error);
  return fail(id, -32603, "Internal error");
}

/** Handles one JSON-RPC message; returns null for notifications (no reply). */
export async function handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
    return fail(msg?.id, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: modules.flatMap((m) =>
            m.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
          ),
        },
      };
    case "tools/call": {
      const name = msg.params?.name;
      const owner = typeof name === "string" ? toolOwners.get(name) : undefined;
      if (!owner) return fail(id, -32602, `Unknown tool: ${String(name)}`);
      metrics.tool_calls[name] = (metrics.tool_calls[name] || 0) + 1;
      let text: string;
      const started = performance.now();
      try {
        text = await owner.call(name, msg.params?.arguments ?? {});
      } catch (error: any) {
        // One tool that throws must not end the process (an unhandled rejection does in Node 15+): report it as a tool error.
        text = JSON.stringify({ error: String(error?.message ?? error) });
      } finally {
        observeToolLatency(name, (performance.now() - started) / 1000);
      }
      let isError = false;
      try {
        const parsed = JSON.parse(text);
        isError = !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed;
      } catch {
        /* non-JSON tool output is returned as-is */
      }
      if (isError) metrics.tool_errors[name] = (metrics.tool_errors[name] || 0) + 1;
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } };
    }
    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return fail(id, -32601, `Method not found: ${msg.method}`);
  }
}

export function renderPrometheusMetrics(): string {
  const lines = [
    "# HELP increadible_uptime_seconds Seconds since the server started",
    "# TYPE increadible_uptime_seconds gauge",
    `increadible_uptime_seconds ${((Date.now() - metrics.started_at) / 1000).toFixed(0)}`,
    "# HELP increadible_tool_calls_total Tool calls by tool name",
    "# TYPE increadible_tool_calls_total counter",
    ...Object.entries(metrics.tool_calls).map(([t, n]) => `increadible_tool_calls_total{tool="${t}"} ${n}`),
    "# HELP increadible_tool_errors_total Tool calls that returned an error, by tool name",
    "# TYPE increadible_tool_errors_total counter",
    ...Object.entries(metrics.tool_errors).map(([t, n]) => `increadible_tool_errors_total{tool="${t}"} ${n}`),
    "# HELP increadible_tool_call_duration_seconds Time to handle a tool call, by tool (includes calls that failed)",
    "# TYPE increadible_tool_call_duration_seconds histogram",
    ...Object.entries(metrics.tool_latency).flatMap(([tool, h]) =>
      renderHistogram("increadible_tool_call_duration_seconds", `tool="${tool}"`, h)
    ),
    "# HELP increadible_event_loop_delay_seconds How much later than due the event loop ran a 10 ms timer (a synchronous task that blocks the loop shows up here)",
    "# TYPE increadible_event_loop_delay_seconds histogram",
    ...(metrics.event_loop_delay.count > 0 ? renderHistogram("increadible_event_loop_delay_seconds", undefined, metrics.event_loop_delay) : []),
    "# HELP increadible_rpc_errors_total JSON-RPC protocol errors",
    "# TYPE increadible_rpc_errors_total counter",
    `increadible_rpc_errors_total ${metrics.rpc_errors}`,
    "# HELP increadible_http_rejected_total HTTP requests refused before reaching the handler, by reason",
    "# TYPE increadible_http_rejected_total counter",
    ...Object.entries(metrics.http_rejected).map(([r, n]) => `increadible_http_rejected_total{reason="${r}"} ${n}`),
  ];
  return lines.join("\n") + "\n";
}
