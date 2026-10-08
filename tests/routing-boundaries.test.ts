import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Routing = typeof import("../features/07-routing-plugins/src/mcp-server");
type RoutingRule = import("../features/07-routing-plugins/src/mcp-server").RoutingRule;

/**
 * Edges of the routing module that no test pinned until the mutation-testing pass of the audit: each field of a rule checked on
 * its own, the two size limits at exactly the limit, how a list in a rule's `match` is read (membership, not substring), the
 * order rules are tried in when they come from a file, what is logged on start-up, and the built-in rules.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-routing-edges-"));
// The module builds its singleton on import and says so on the console: keep that off ./rules.yaml and off the output.
jest.spyOn(console, "error").mockImplementation(() => undefined);
jest.spyOn(console, "warn").mockImplementation(() => undefined);
process.env.RULES_FILE = path.join(tmp, "singleton.yaml");
const { RoutingPluginsMCP, rulesProblem } = require("../features/07-routing-plugins/src/mcp-server") as Routing;
type RoutingPluginsMCP = InstanceType<Routing["RoutingPluginsMCP"]>;

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let errors: jest.SpyInstance;
let warnings: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  warnings = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const rule = (id: string, extra: Record<string, unknown> = {}): RoutingRule =>
  ({ id, name: id, enabled: true, priority: 1, match: {}, provider: `p-${id}`, reason: "r", ...extra }) as RoutingRule;
const fileIn = (name: string) => path.join(tmp, name);
const loadFrom = (name: string, text: string) => {
  const file = fileIn(name);
  fs.writeFileSync(file, text);
  return new RoutingPluginsMCP(file);
};
const SHAPE = "each rule needs string id, string provider, number priority, boolean enabled and object match";

describe("each field of a rule is checked on its own", () => {
  it.each([
    ["a number as the id", rule("a", { id: 5 })],
    ["a number as the provider", rule("a", { provider: 5 })],
    ["a missing provider", rule("a", { provider: undefined })],
    ["text as the priority", rule("a", { priority: "1" })],
    ["a missing priority", rule("a", { priority: undefined })],
    ["a number as enabled", rule("a", { enabled: 1 })],
    ["a missing enabled", rule("a", { enabled: undefined })],
    ["text as the match", rule("a", { match: "x" })],
    ["a missing match", rule("a", { match: undefined })],
    ["null as the match", rule("a", { match: null })],
    ["a rule that is not an object", null],
    ["a rule that is 0", 0],
  ])("%s", (_name, bad) => {
    expect(rulesProblem([bad])).toBe(SHAPE);
  });

  it("accepts a rule that has every field right, and reports a problem only for the first rule that has one", () => {
    expect(rulesProblem([rule("a")])).toBeNull();
    expect(rulesProblem([rule("a"), rule("b", { priority: "x" }), rule("c", { id: "" })])).toBe(SHAPE);
    expect(rulesProblem([rule("a"), rule("b", { id: "" }), rule("c", { priority: "x" })])).toBe("a rule id must not be empty");
  });
});

describe("the size limits sit exactly where they are documented", () => {
  it("allows 500 rules and refuses 501, saying how many it got", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => rule(`r${i}`));
    expect(rulesProblem(many(500))).toBeNull();
    expect(rulesProblem(many(501))).toBe("at most 500 rules are allowed (got 501)");
  });

  it("allows rules of exactly 1 MiB as JSON and refuses one character more", () => {
    const limit = 1024 * 1024;
    const withPad = (pad: number) => [rule("big", { reason: "x".repeat(pad) })];
    const overhead = JSON.stringify(withPad(0)).length;
    expect(JSON.stringify(withPad(limit - overhead)).length).toBe(limit);
    expect(rulesProblem(withPad(limit - overhead))).toBeNull();
    expect(rulesProblem(withPad(limit - overhead + 1))).toBe("the rules are larger than 1024 KB");
  });
});

describe("a list in a rule's match", () => {
  const router = (match: Record<string, unknown>) => {
    const r = new RoutingPluginsMCP(fileIn("lists.yaml"));
    r.updateRules([rule("listed", { match })]);
    return (request: Record<string, unknown>) => r.applyRoutingRules(request).rule_id;
  };

  it("matches when the request's value is one of the listed values, and only then", () => {
    const route = router({ task_type: ["qa", "summary"] });
    expect(route({ task_type: "qa" })).toBe("listed");
    expect(route({ task_type: "summary" })).toBe("listed");
    expect(route({ task_type: "security" })).toBe("default");
    expect(route({ task_type: "q" })).toBe("default"); // not a substring match
    expect(route({ task_type: ["qa"] })).toBe("default");
    expect(route({})).toBe("default"); // the key is missing from the request
  });

  it("compares a single value for equality, not as a substring", () => {
    const route = router({ priority: "critical" });
    expect(route({ priority: "critical" })).toBe("listed");
    expect(route({ priority: "crit" })).toBe("default"); // "critical".includes("crit") is true; equality is what is meant
    expect(route({ priority: "critical!" })).toBe("default");
  });

  it("needs every condition to hold, a list or not", () => {
    const route = router({ task_type: ["qa", "summary"], task_complexity: "low" });
    expect(route({ task_type: "qa", task_complexity: "low" })).toBe("listed");
    expect(route({ task_type: "qa", task_complexity: "high" })).toBe("default");
    expect(route({ task_type: "audit", task_complexity: "low" })).toBe("default");
    expect(route({ task_type: "qa" })).toBe("default");
  });

  it("matches anything when the rule has no conditions", () => {
    expect(router({})({ anything: 1 })).toBe("listed");
    expect(router({})({})).toBe("listed");
  });
});

describe("a rules file: the order rules are tried in, and what start-up says", () => {
  const file = (rules: string[]) => `rules:\n${rules.map((r) => `  - ${r}`).join("\n")}\n`;

  it("tries rules lowest priority number first, whatever order the file lists them in", () => {
    const r = loadFrom(
      "order.yaml",
      file([
        "{id: thirty, enabled: true, priority: 30, match: {}, provider: p30, reason: r}",
        "{id: ten, enabled: true, priority: 10, match: {}, provider: p10, reason: r}",
        "{id: twenty, enabled: true, priority: 20, match: {}, provider: p20, reason: r}",
      ])
    );
    expect(r.applyRoutingRules({ task_type: "x" }).rule_id).toBe("ten");
  });

  it("says how many rules it loaded", () => {
    loadFrom("count.yaml", file(["{id: a, enabled: true, priority: 1, match: {}, provider: p, reason: r}", "{id: b, enabled: true, priority: 2, match: {}, provider: p, reason: r}"]));
    expect(errors).toHaveBeenCalledWith("Loaded 2 routing rules");
    expect(warnings).not.toHaveBeenCalled();
  });

  it("warns, and does not report an error, when there is no rules file", () => {
    const missing = fileIn("does-not-exist.yaml");
    const r = new RoutingPluginsMCP(missing);
    expect(warnings).toHaveBeenCalledWith(`Rules file not found: ${missing}`);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("Error loading rules"))).toBe(false);
    expect(r.getStats().rules_count).toBe(3);
  });

  it("names the problem of an empty file, which parses to nothing", () => {
    const empty = fileIn("empty-file.yaml");
    fs.writeFileSync(empty, "");
    new RoutingPluginsMCP(empty);
    expect(errors).toHaveBeenCalledWith(`Rules file ${empty} is not usable (rules must be an array); using the built-in rules`);
  });

  it("reports a file it cannot read as an error and uses the built-in rules", () => {
    const dir = fileIn("a-directory.yaml");
    fs.mkdirSync(dir);
    const r = new RoutingPluginsMCP(dir); // exists, but reading a directory fails
    expect(errors.mock.calls[0][0]).toBe("Error loading rules:");
    expect(r.getStats().rules_count).toBe(3);
  });
});

describe("the built-in rules", () => {
  const router = () => new RoutingPluginsMCP(fileIn("builtin-none.yaml"));

  it("send low-complexity questions and summaries to claude-haiku, with claude-sonnet behind it", () => {
    expect(router().applyRoutingRules({ task_complexity: "low", task_type: "qa" })).toEqual({
      provider: "claude-haiku",
      fallback: ["claude-sonnet"],
      rule_id: "simple-tasks",
      reason: "Haiku optimal for low-complexity tasks",
    });
    expect(router().applyRoutingRules({ task_complexity: "low", task_type: "summary" }).rule_id).toBe("simple-tasks");
    expect(router().applyRoutingRules({ task_complexity: "high", task_type: "qa" }).rule_id).toBe("default");
  });

  it("send critical security and audit work to claude-opus, with gpt-4 behind it", () => {
    expect(router().applyRoutingRules({ priority: "critical", task_type: "security" })).toEqual({
      provider: "claude-opus",
      fallback: ["gpt-4"],
      rule_id: "critical-tasks",
      reason: "Opus required for critical decisions",
    });
    expect(router().applyRoutingRules({ priority: "critical", task_type: "audit" }).rule_id).toBe("critical-tasks");
    expect(router().applyRoutingRules({ priority: "normal", task_type: "audit" }).rule_id).toBe("default");
  });

  it("try the critical rule before the simple one when both would match, and end with a default that has no fallback", () => {
    expect(router().applyRoutingRules({ priority: "critical", task_type: "security", task_complexity: "low" }).rule_id).toBe("critical-tasks");
    expect(router().applyRoutingRules({ task_type: "development" })).toEqual({
      provider: "claude-sonnet",
      fallback: [],
      rule_id: "default",
      reason: "Balanced default",
    });
  });
});

describe("the statistics", () => {
  it("count only enabled rules as enabled", () => {
    const r = new RoutingPluginsMCP(fileIn("enabled.yaml"));
    r.updateRules([rule("a"), rule("b", { enabled: false, priority: 2 }), rule("c", { enabled: false, priority: 3 })]);
    expect(r.getStats()).toMatchObject({ rules_count: 3, enabled_rules: 1 });
  });

  it("skip a disabled rule that would match, and give the answer of the next that does", () => {
    const r = new RoutingPluginsMCP(fileIn("skip.yaml"));
    r.updateRules([rule("off", { enabled: false, priority: 1 }), rule("on", { priority: 2 })]);
    expect(r.applyRoutingRules({ task_type: "x" }).rule_id).toBe("on");
  });
});

describe("an update the module refuses comes back as an error answer", () => {
  it("through the tool: the message of the problem, nothing else", async () => {
    process.env.RULES_FILE = fileIn("tool-refuse.yaml");
    let tool!: (name: string, input: Record<string, unknown>) => Promise<string>;
    jest.isolateModules(() => {
      tool = require("../features/07-routing-plugins/src/mcp-server").processToolCall;
    });
    expect(JSON.parse(await tool("update_rules", { rules: "x" }))).toEqual({ error: "rules must be an array" });
    expect(JSON.parse(await tool("update_rules", {}))).toEqual({ error: "rules must be an array" });
    expect(JSON.parse(await tool("update_rules", { rules: [rule("a"), rule("a")] }))).toEqual({ error: "duplicate rule id: a" });
    expect(JSON.parse(await tool("update_rules", { rules: [rule("a")] }))).toEqual({ status: "success", message: "Updated 1 rules" });
  });
});
