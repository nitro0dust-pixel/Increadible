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

export const metrics = {
  started_at: Date.now(),
  tool_calls: {} as Record<string, number>,
  tool_errors: {} as Record<string, number>,
  rpc_errors: 0,
};

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
      const text = await owner.call(name, msg.params?.arguments ?? {});
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
    "# HELP increadible_rpc_errors_total JSON-RPC protocol errors",
    "# TYPE increadible_rpc_errors_total counter",
    `increadible_rpc_errors_total ${metrics.rpc_errors}`,
  ];
  return lines.join("\n") + "\n";
}
