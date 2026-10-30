import { PassThrough } from "stream";

/**
 * Edges of the protocol handler and the transports that no test pinned until the mutation-testing pass of the audit: which
 * protocol versions are echoed, which ids are ids, what a tool that throws something odd or answers with text that is not JSON
 * becomes, the arithmetic of the event-loop monitor and of the rate limiter's retry hint, the timeouts handed to Node, and the
 * exact shape of the hosts and values that count as "this machine" and "consent".
 */

type ServerModule = typeof import("../src/server");
type IndexModule = typeof import("../src/index");

const GATEWAY = "../features/09-api-gateway/src/mcp-server";
let server: ServerModule;
let index: IndexModule;
let errors: jest.SpyInstance;

/** A copy of the modules whose gateway tools are `gatewayCall`, so a tool can be made to throw or to answer with anything. */
async function withGateway<T>(gatewayCall: (name: string, input: Record<string, unknown>) => Promise<string>, body: (s: ServerModule) => Promise<T>): Promise<T> {
  let result!: T;
  await jest.isolateModulesAsync(async () => {
    jest.doMock(GATEWAY, () => ({ ...jest.requireActual(GATEWAY), processToolCall: gatewayCall }));
    try {
      result = await body(require("../src/server"));
    } finally {
      jest.dontMock(GATEWAY);
    }
  });
  return result;
}

beforeAll(() => {
  process.env.RULES_FILE = "/nonexistent/increadible-rules.yaml";
  process.env.EXPERIMENTS_FILE = "/nonexistent/increadible-experiments.yaml";
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.isolateModules(() => {
    server = require("../src/server");
    index = require("../src/index");
  });
});
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  server.stopEventLoopMonitor();
});
afterAll(() => jest.restoreAllMocks());

const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) as any;
const toolCall = (name: unknown, args?: unknown) => rpc("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });

describe("the protocol version it answers with", () => {
  const versionFor = async (requested: unknown) => ((await server.handleMessage(rpc("initialize", { protocolVersion: requested }))) as any).result.protocolVersion;

  it("echoes a version it speaks, and offers the latest it speaks (2025-11-25) for anything else, also for text that only looks like one", async () => {
    expect(await versionFor("2025-06-18")).toBe("2025-06-18");
    expect(await versionFor("2024-11-05")).toBe("2024-11-05");
    for (const other of ["x2025-06-18", "2025-06-18x", "2025-6-18", "20250618", "2025-06-18\n", "", " 2025-06-18", 20250618, null, {}, undefined, "2099-01-01"]) {
      expect(await versionFor(other)).toBe("2025-11-25");
    }
  });
});

describe("what counts as a request, and which id an error carries back", () => {
  const reply = (message: unknown) => server.handleMessage(message as any) as Promise<any>;

  it("answers an invalid request with its id when that is a valid id, and with null otherwise", async () => {
    for (const id of [7, 0, -0, 1.5, "abc", "", null]) {
      expect(await reply({ jsonrpc: "1.0", id, method: "ping" })).toMatchObject({ id, error: { code: -32600, message: "Invalid Request" } });
    }
    for (const id of [{}, [], true, false, NaN, Infinity, -Infinity]) {
      expect(await reply({ jsonrpc: "2.0", id, method: "ping" })).toMatchObject({ id: null, error: { code: -32600 } });
    }
    expect(await reply({ jsonrpc: "2.0", id: 5 })).toMatchObject({ id: 5, error: { code: -32600 } }); // no method
    expect(await reply({ jsonrpc: "2.0", id: 5, method: 42 })).toMatchObject({ id: 5, error: { code: -32600 } });
  });

  it("answers a message that is not an object with an invalid request and a null id, whatever it is", async () => {
    for (const message of [null, undefined, 5, "text", true, [], [rpc("ping")]]) {
      expect(await reply(message)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    }
  });

  it("counts every error it answers with", async () => {
    const before = server.metrics.rpc_errors;
    await reply(null);
    await reply(rpc("no/such/method"));
    expect(server.metrics.rpc_errors).toBe(before + 2);
  });

  it("carries out a notification and answers none, but answers an unknown method that has an id", async () => {
    expect(await reply({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await reply({ jsonrpc: "2.0", method: "ping" })).toBeNull(); // known method, but no id: carried out, not answered
    expect(await reply(rpc("nope", undefined, 9))).toMatchObject({ id: 9, error: { code: -32601, message: "Method not found: nope" } });
  });
});

describe("tools/call: the name, the arguments and what comes back", () => {
  const reply = (message: unknown) => server.handleMessage(message as any) as Promise<any>;

  it("refuses a missing, empty or odd name as an unknown tool, without throwing", async () => {
    expect(await reply(rpc("tools/call"))).toMatchObject({ error: { code: -32602, message: "Unknown tool: undefined" } });
    expect(await reply(rpc("tools/call", null))).toMatchObject({ error: { code: -32602, message: "Unknown tool: undefined" } });
    expect(await reply(toolCall(5))).toMatchObject({ error: { code: -32602, message: "Unknown tool: 5" } });
    expect(await reply(toolCall(null))).toMatchObject({ error: { code: -32602, message: "Unknown tool: null" } });
    expect(await reply(toolCall("constructor"))).toMatchObject({ error: { code: -32602, message: "Unknown tool: constructor" } });
    expect(await reply(toolCall("__proto__"))).toMatchObject({ error: { code: -32602 } });
    expect(Object.keys(server.metrics.tool_calls)).not.toContain("constructor");
  });

  it("gives a tool no arguments as an empty object when there are none, or null", async () => {
    for (const message of [toolCall("get_api_stats"), toolCall("get_api_stats", null)]) {
      const r = await reply(message);
      expect(r.result.isError).toBe(false);
      expect(JSON.parse(r.result.content[0].text)).toHaveProperty("total_calls");
    }
  });

  it("reports whatever a tool throws as a tool error with its message: an Error, a string, null, an object", async () => {
    const throwing = (thrown: unknown) => async () => {
      throw thrown;
    };
    const text = async (thrown: unknown) =>
      withGateway(throwing(thrown), async (s) => JSON.parse(((await s.handleMessage(toolCall("get_api_stats", {}))) as any).result.content[0].text).error);
    expect(await text(new Error("boom"))).toBe("boom");
    expect(await text("plain string")).toBe("plain string");
    expect(await text(null)).toBe("null");
    expect(await text(undefined)).toBe("undefined");
    expect(await text({ code: 5 })).toBe("[object Object]");
    expect(await text({ message: "from an object" })).toBe("from an object");
  });

  it("marks only an object with an 'error' key as an error: text that is not JSON, arrays, strings, null and other objects are results", async () => {
    const outputs: Array<[string, boolean]> = [
      ["plain text, not JSON", false],
      ["", false],
      ["[1,2]", false],
      ['[{"error":"in a list"}]', false],
      ['"error"', false],
      ["null", false],
      ["0", false],
      ["true", false],
      ['{"ok":1}', false],
      ['{"error":"x"}', true],
      ['{"error":null}', true],
      ['{"data":1,"error":""}', true],
    ];
    for (const [output, isError] of outputs) {
      const outcome = await withGateway(async () => output, async (s) => {
        const before = s.metrics.tool_errors.get_api_stats ?? 0;
        const r: any = await s.handleMessage(toolCall("get_api_stats", {}));
        return { r, counted: (s.metrics.tool_errors.get_api_stats ?? 0) - before };
      });
      expect(outcome.r.result.isError).toBe(isError);
      expect(outcome.r.result.content).toEqual([{ type: "text", text: output }]); // returned as it came
      expect(outcome.counted).toBe(isError ? 1 : 0);
    }
  });
});

describe("the metrics", () => {
  it("shows the uptime in whole seconds since the server started", () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(server.metrics.started_at + 125_400);
    expect(server.renderPrometheusMetrics()).toContain("increadible_uptime_seconds 125\n");
    now.mockReturnValue(server.metrics.started_at + 125_600);
    expect(server.renderPrometheusMetrics()).toContain("increadible_uptime_seconds 126\n");
  });

  it("keeps a slower observation out of every bucket, and does not touch the array for it", () => {
    server.observeToolLatency("slow_tool", 11);
    server.observeToolLatency("slow_tool", 0.0005);
    const h = server.metrics.tool_latency.slow_tool;
    expect(Object.keys(h.counts)).toEqual(server.LATENCY_BUCKETS_SECONDS.map((_, i) => String(i))); // no stray key such as "-1"
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.count).toBe(2);
    expect(h.sum).toBeCloseTo(11.0005, 10);
  });
});

describe("the event-loop monitor", () => {
  /** Timers are fake, and each reading of the clock is the next of `readings`: the first is taken at start-up, one more per tick. */
  function run(readings: number[]) {
    jest.useFakeTimers({ doNotFake: ["performance"] });
    const queue = [...readings];
    jest.spyOn(performance, "now").mockImplementation(() => queue.shift() ?? Number.NaN);
    const h = server.metrics.event_loop_delay;
    const before = { count: h.count, sum: h.sum, counts: [...h.counts] };
    server.startEventLoopMonitor();
    jest.advanceTimersByTime(10 * (readings.length - 1));
    server.stopEventLoopMonitor();
    return { count: h.count - before.count, sum: h.sum - before.sum, counts: h.counts.map((c, i) => c - before.counts[i]) };
  }

  it("records no delay for a timer that ran when it was due, tick after tick", () => {
    const r = run([1000, 1010, 1020, 1030]);
    expect(r.count).toBe(3);
    expect(r.sum).toBe(0);
    expect(r.counts[0]).toBe(3);
  });

  it("measures how late a tick was against when it was due, and counts the next tick from when this one ran", () => {
    const r = run([1000, 1025, 1035]); // the first tick was due at 1010 and ran at 1025: 15 ms late; the second was due at 1035
    expect(r.count).toBe(2);
    expect(r.sum).toBeCloseTo(0.015, 10);
    expect(r.counts[server.LATENCY_BUCKETS_SECONDS.indexOf(0.025)]).toBe(1);
    expect(r.counts[0]).toBe(1);
  });

  it("does not record anything once stopped, and a second start does not double the ticks", () => {
    jest.useFakeTimers({ doNotFake: ["performance"] });
    let t = 0;
    jest.spyOn(performance, "now").mockImplementation(() => (t += 10));
    const before = server.metrics.event_loop_delay.count;
    server.startEventLoopMonitor();
    server.startEventLoopMonitor();
    jest.advanceTimersByTime(30);
    server.stopEventLoopMonitor();
    jest.advanceTimersByTime(100);
    expect(server.metrics.event_loop_delay.count - before).toBe(3);
  });

  it("does not keep the process alive", () => {
    const timers: NodeJS.Timeout[] = [];
    const real = global.setInterval;
    jest.spyOn(global, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const t = real(...args);
      timers.push(t);
      return t;
    }) as any);
    server.startEventLoopMonitor();
    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
    server.stopEventLoopMonitor();
  });
});

describe("the reply to a failure nobody expected", () => {
  it("is a JSON-RPC internal error, and the cause goes to stderr only", () => {
    const cause = new Error("the real reason");
    expect(server.internalError(3, cause)).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "Internal error" } });
    expect(errors).toHaveBeenCalledWith("internal error:", cause);
    expect(server.internalError(undefined, cause).id).toBeNull();
  });
});

describe("stdio: what it does with lines", () => {
  async function session(lines: string[], throwOn?: number) {
    let n = 0;
    const real = server.handleMessage;
    const spy = jest.spyOn(server, "handleMessage").mockImplementation(async (message) => {
      if (throwOn !== undefined && ++n === throwOn) throw new Error("boom");
      return real(message);
    });
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on("data", (c) => chunks.push(c.toString()));
      const done = index.serveStdio(input, output);
      for (const line of lines) input.write(line + "\n");
      input.end();
      await done;
      return chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } finally {
      spy.mockRestore();
    }
  }

  it("ignores lines that are empty or only spaces, and answers a line that is not JSON with a parse error", async () => {
    expect(await session(["", "   ", "\t", JSON.stringify(rpc("ping", undefined, 1))])).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(await session(["{not json"])).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
  });

  it("answers JSON that is not a request as an invalid request", async () => {
    expect(await session(["null", "5"])).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    ]);
  });

  it("carries on after a handler failure for a message with no id, a null message, or a notification, and answers none of them", async () => {
    const replies = await session(["null", JSON.stringify(rpc("ping", undefined, 2))], 1);
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
    const notice = await session([JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" }), JSON.stringify(rpc("ping", undefined, 3))], 1);
    expect(notice).toEqual([{ jsonrpc: "2.0", id: 3, result: {} }]);
  });
});

describe("the rate limiter's hint of when to try again", () => {
  it("is the seconds until one whole token is back, rounded up, and at least one", () => {
    let now = 0;
    const take = index.createRateLimiter(6, () => now); // one token every 10 s
    for (let i = 0; i < 6; i++) expect(take()).toBe(0);
    expect(take()).toBe(10);
    now += 2_000; // 0.2 of a token back
    expect(take()).toBe(8);
    now += 8_000; // exactly one
    expect(take()).toBe(0);
    const fast = index.createRateLimiter(600, () => now); // a token every 100 ms: the hint is never below one second
    for (let i = 0; i < 600; i++) fast();
    expect(fast()).toBe(1);
  });
});

describe("the timeouts handed to Node", () => {
  const settings = (headers: number | undefined, request: number | undefined) => {
    const s: any = index.createHttpServer(undefined, { headersTimeoutMs: headers, requestTimeoutMs: request });
    const out = [s.headersTimeout, s.requestTimeout, s.connectionsCheckingInterval];
    s.close();
    return out;
  };

  it.each([
    ["the defaults", undefined, undefined, [10_000, 30_000, 5_000]],
    ["headers below the request limit", 10_000, 30_000, [10_000, 30_000, 5_000]],
    ["headers above the request limit are cut to it", 5_000, 2_000, [2_000, 2_000, 1_000]],
    ["equal limits are kept", 3_000, 3_000, [3_000, 3_000, 1_500]],
    ["no request limit: headers are kept", 5_000, 0, [5_000, 0, 2_500]],
    ["no limits at all", 0, 0, [0, 0, 5_000]],
    ["no headers limit: half the request limit", 0, 4_000, [0, 4_000, 2_000]],
    ["a check no more often than every 50 ms", 60, 30_000, [60, 30_000, 50]],
    ["a check at least every 5 s", 20_000, 30_000, [20_000, 30_000, 5_000]],
    ["an odd limit rounds the check down", 1_001, 30_000, [1_001, 30_000, 500]],
  ] as Array<[string, number | undefined, number | undefined, number[]]>)("%s", (_name, headers, request, expected) => {
    expect(settings(headers, request)).toEqual(expected);
  });
});

describe("graceful shutdown: the message, and the deadline that is cancelled by a clean close", () => {
  it("says what it is waiting for, and does not report a deadline once the server closed cleanly", async () => {
    const srv = index.createHttpServer(undefined, {});
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const exits: number[] = [];
    const log = jest.fn();
    const shutdown = index.installShutdown(srv, { drainMs: 0, timeoutMs: 300, exit: (code) => void exits.push(code), log });
    shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 700)); // well past the deadline
    expect(log).toHaveBeenCalledWith("SIGTERM: draining for 0 ms, then closing (connections are cut 300 ms after that)");
    expect(exits).toEqual([0]); // the deadline was cancelled: it did not add an exit(1)
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("which hosts are 'this machine', and which values are consent", () => {
  const problem = (host: string, token?: string, allow?: string) => index.exposureProblem(host, token, allow);

  it("takes only the whole host as loopback: a name that merely starts or ends like one is not", () => {
    for (const host of ["localhost.evil.example", "foolocalhost", "my.localhost", "127.0.0.1.evil.example", "x127.0.0.1", "::1x", "x::1", "[::1]x", "1270.0.1", "127.0.0"]) {
      expect(problem(host)).toMatch(/Refusing to listen on/);
    }
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.255.255.255", "::1", "[::1]"]) expect(problem(host)).toBeNull();
  });

  it("ignores spaces around the host and around the token", () => {
    expect(problem("  localhost  ")).toBeNull();
    expect(problem("0.0.0.0", "   ")).toMatch(/Refusing/);
    expect(problem("0.0.0.0", " t ")).toBeNull();
  });

  it("takes only 1, true or yes, in any case and nothing around them, as consent", () => {
    for (const yes of ["1", "true", "TRUE", "True", "yes", "YES", "Yes"]) expect(problem("0.0.0.0", undefined, yes)).toBeNull();
    for (const no of ["0", "", "false", "no", "yes!", "xtrue", "1x", "11", " 1", "1 ", "on", "yes\n"]) expect(problem("0.0.0.0", undefined, no)).toMatch(/Refusing/);
  });

  it("names the host and the three ways out in its message", () => {
    expect(problem("10.1.2.3")).toBe(
      "Refusing to listen on 10.1.2.3 without AUTH_TOKEN: /mcp and /metrics would be open to anything that can reach the port. " +
        "Set AUTH_TOKEN, bind HOST=127.0.0.1, or set ALLOW_UNAUTHENTICATED=1 if something in front of this server authenticates."
    );
  });
});
