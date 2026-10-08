import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Behaviour of the routing module that no test exercised until the audit (the coverage report listed these lines as never run):
 * the built-in route taken when no rule matches, how that route shows in the statistics, and the whole `suggest_rules` tool.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-routing-tools-"));
// The module builds its singleton on import and says so on the console.
jest.spyOn(console, "error").mockImplementation(() => undefined);
jest.spyOn(console, "warn").mockImplementation(() => undefined);
process.env.RULES_FILE = path.join(tmp, "rules.yaml"); // the module builds its singleton on import; keep it off ./rules.yaml
const routing = require("../features/07-routing-plugins/src/mcp-server") as typeof import("../features/07-routing-plugins/src/mcp-server");
const { RoutingPluginsMCP, processToolCall } = routing;

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const rule = (id: string, provider: string, match: Record<string, unknown>, extra: Record<string, unknown> = {}): any =>
  ({ id, name: id, enabled: true, priority: 1, match, provider, reason: `reason of ${id}`, ...extra });
const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await processToolCall(name, input));

describe("the route taken when no rule matches", () => {
  it("is claude-sonnet with no fallback, and says so", () => {
    const router = new RoutingPluginsMCP(path.join(tmp, "default-route.yaml"));
    router.updateRules([rule("only-low", "cheap", { task_complexity: "low" })]);
    expect(router.applyRoutingRules({ task_type: "qa", task_complexity: "high" })).toEqual({
      provider: "claude-sonnet",
      fallback: [],
      rule_id: "default",
      reason: "No matching rule, using default",
    });
  });

  it("is also what a request gets when the only rule that would match is disabled", () => {
    const router = new RoutingPluginsMCP(path.join(tmp, "disabled.yaml"));
    router.updateRules([rule("off", "cheap", { task_type: "qa" }, { enabled: false })]);
    expect(router.applyRoutingRules({ task_type: "qa" }).rule_id).toBe("default");
  });

  it("counts as a request but belongs to no rule, so provider shares add up to less than 100%", () => {
    const router = new RoutingPluginsMCP(path.join(tmp, "shares.yaml"));
    router.updateRules([rule("low", "cheap", { task_complexity: "low" })]);
    router.applyRoutingRules({ task_complexity: "low" });
    router.applyRoutingRules({ task_complexity: "high" });
    router.applyRoutingRules({ task_complexity: "high" });
    router.applyRoutingRules({ task_complexity: "high" });
    const stats = router.getStats();
    expect(stats.total_requests).toBe(4);
    expect(stats.rules_applied).toEqual({ low: 1 });
    expect(stats.provider_breakdown).toEqual({ cheap: "25.0%" });
  });
});

describe("suggest_rules", () => {
  // A fresh copy of the module per test, because it keeps one router for the whole process and the counters would carry over.
  let copies = 0;
  function freshTools() {
    process.env.RULES_FILE = path.join(tmp, `rules-${copies++}.yaml`);
    let mod!: typeof routing;
    jest.isolateModules(() => {
      mod = require("../features/07-routing-plugins/src/mcp-server");
    });
    const tool = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await mod.processToolCall(name, input));
    return tool;
  }
  /** haiku for low complexity, opus for high, nothing for medium (those fall to the built-in default); then `sent` requests. */
  async function traffic(sent: { low?: number; high?: number; medium?: number }) {
    const tool = freshTools();
    await tool("update_rules", {
      rules: [rule("cheap", "claude-haiku", { task_complexity: "low" }), rule("rest", "claude-opus", { task_complexity: "high" })],
    });
    for (const [complexity, n] of Object.entries(sent)) {
      for (let i = 0; i < (n ?? 0); i++) await tool("apply_routing_rules", { task_type: "x", task_complexity: complexity });
    }
    return tool;
  }

  it("has nothing to suggest before any request was seen", async () => {
    expect(await freshTools()("suggest_rules")).toEqual([]);
  });

  it("suggests the same when nothing at all went to claude-haiku (0.0%, not no answer)", async () => {
    const tool = await traffic({ high: 2 });
    expect((await tool("get_rule_stats")).provider_breakdown).toEqual({ "claude-opus": "100.0%" });
    const suggestions = await tool("suggest_rules");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].current_low_cost_share).toBe("0.0%");
  });

  it("suggests reviewing the low-cost share when under half of the requests go to claude-haiku", async () => {
    const suggestions = await (await traffic({ low: 1, high: 3 }))("suggest_rules"); // 1 of 4
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].type).toBe("optimization");
    expect(suggestions[0].current_low_cost_share).toBe("25.0%");
    expect(suggestions[0].suggestion).toMatch(/Less than half of requests go to a low-cost model/);
  });

  it("stays quiet at exactly half", async () => {
    const tool = await traffic({ low: 3, high: 3 }); // 3 of 6
    expect((await tool("get_rule_stats")).provider_breakdown["claude-haiku"]).toBe("50.0%");
    expect(await tool("suggest_rules")).toEqual([]);
  });

  it("stays quiet above half", async () => {
    expect(await (await traffic({ low: 4, high: 3 }))("suggest_rules")).toEqual([]); // 4 of 7
  });

  it("reads the share of claude-haiku only: requests that fell back to the default count in the total", async () => {
    // 4 of 7 would be 57.1% and quiet; eight more that match no rule bring it to 4 of 15.
    const suggestions = await (await traffic({ low: 4, high: 3, medium: 8 }))("suggest_rules");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].current_low_cost_share).toBe("26.7%");
  });
});

describe("an unknown tool name", () => {
  it("is an error answer, not an exception", async () => {
    expect(await call("no_such_tool")).toEqual({ error: "Unknown tool" });
  });
});
