import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RoutingPluginsMCP, RoutingRule, rulesProblem } from "../features/07-routing-plugins/src/mcp-server";

/**
 * Routing rules: state that must stay whole (audit findings RT-1 to RT-5). Found by probing the module:
 * a rule id of "constructor" turned its hit count into the text of Object's function and the provider share into "NaN%";
 * update_rules replaced the live rules BEFORE writing the file, so a failed write (a read-only ConfigMap mount, a full disk)
 * reported an error while routing had already changed; a rules file that parsed but held a malformed rule made every
 * apply_routing_rules call fail; and the file was rewritten in place, so a crash could leave it truncated.
 */

// `import * as fs` is a frozen namespace object; the module under test calls the real fs, so that is what is replaced.
const realFs: typeof fs = require("fs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-routing-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let errors: jest.SpyInstance;
let warnings: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  warnings = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  errors.mockRestore();
  warnings.mockRestore();
  jest.restoreAllMocks();
});

const rule = (id: string, extra: Record<string, unknown> = {}): RoutingRule =>
  ({ id, name: id, enabled: true, priority: 1, match: {}, provider: `p-${id}`, reason: "r", ...extra }) as RoutingRule;
const fileIn = (name: string) => path.join(tmp, name);

describe("rule ids that collide with Object.prototype (RT-1)", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])("counts hits for a rule called %s", (id) => {
    const router = new RoutingPluginsMCP(fileIn(`ids-${id}.yaml`));
    router.updateRules([rule(id)]);
    router.applyRoutingRules({ task_type: "x" });
    router.applyRoutingRules({ task_type: "x" });
    const stats = router.getStats();
    expect(stats.total_requests).toBe(2);
    expect(Object.entries(stats.rules_applied)).toEqual([[id, 2]]);
    expect(stats.provider_breakdown).toEqual({ [`p-${id}`]: "100.0%" });
  });

  it("keeps the output shape the stats always had", () => {
    const router = new RoutingPluginsMCP(fileIn("shape.yaml"));
    router.updateRules([rule("a", { priority: 1, match: { task_type: "x" } }), rule("b", { priority: 2 })]);
    router.applyRoutingRules({ task_type: "x" });
    router.applyRoutingRules({ task_type: "y" });
    expect(router.getStats()).toEqual({
      total_requests: 2,
      rules_applied: { a: 1, b: 1 },
      provider_breakdown: { "p-a": "50.0%", "p-b": "50.0%" },
      rules_count: 2,
      enabled_rules: 2,
    });
  });
});

describe("update_rules writes first, so a failure changes nothing (RT-2, RT-5)", () => {
  it("leaves the live rules and the file untouched when the write fails", () => {
    const file = fileIn("keep.yaml");
    const router = new RoutingPluginsMCP(file);
    router.updateRules([rule("before")]);
    const written = fs.readFileSync(file, "utf8");
    jest.spyOn(realFs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system");
    });
    expect(() => router.updateRules([rule("after")])).toThrow("EROFS");
    expect(router.applyRoutingRules({ task_type: "x" }).rule_id).toBe("before"); // still the old rules
    expect(router.getStats().rules_count).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(written);
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the old file whole when the final step fails (a crash between writing and renaming)", () => {
    const file = fileIn("crash.yaml");
    const router = new RoutingPluginsMCP(file);
    router.updateRules([rule("before")]);
    const written = fs.readFileSync(file, "utf8");
    jest.spyOn(realFs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EIO");
    });
    expect(() => router.updateRules([rule("after")])).toThrow("EIO");
    expect(fs.readFileSync(file, "utf8")).toBe(written); // not truncated, not half written
    expect(router.applyRoutingRules({ task_type: "x" }).rule_id).toBe("before");
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"))).toEqual([]); // the temporary file is removed
  });

  it("an unwritable location is an error and routing is unchanged (the read-only ConfigMap case)", () => {
    const router = new RoutingPluginsMCP(path.join(tmp, "no-such-dir", "rules.yaml"));
    const before = router.getStats().rules_count;
    expect(() => router.updateRules([rule("only-one")])).toThrow();
    expect(router.getStats().rules_count).toBe(before);
    expect(router.applyRoutingRules({ task_type: "x" }).rule_id).not.toBe("only-one");
  });

  it("a successful update is complete on disk, reloads identically, and leaves no temporary file", () => {
    const file = fileIn("whole.yaml");
    const router = new RoutingPluginsMCP(file);
    router.updateRules([rule("b", { priority: 2 }), rule("a", { priority: 1 })]);
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith("whole.yaml"))).toEqual(["whole.yaml"]);
    const reloaded = new RoutingPluginsMCP(file);
    expect(reloaded.applyRoutingRules({ task_type: "x" }).rule_id).toBe("a");
    expect(reloaded.getStats().rules_count).toBe(2);
  });
});

describe("what update_rules and a rules file accept (RT-3, RT-4)", () => {
  const bad: Array<[string, unknown, string]> = [
    ["not an array", "x", "rules must be an array"],
    ["a null rule", [null], "each rule needs"],
    ["no match", [{ id: "a", provider: "p", priority: 1, enabled: true }], "each rule needs"],
    ["enabled as text", [rule("a", { enabled: "no" })], "each rule needs"],
    ["priority as text", [rule("a", { priority: "1" })], "each rule needs"],
    ["NaN priority", [rule("a", { priority: NaN })], "rule a: priority must be a finite number"],
    ["infinite priority", [rule("a", { priority: Infinity })], "rule a: priority must be a finite number"],
    ["match as a list", [rule("a", { match: [] })], "rule a: match must be an object"],
    ["fallback as text", [rule("a", { fallback: "x" })], "rule a: fallback must be a list of provider names"],
    ["fallback with a number", [rule("a", { fallback: ["x", 2] })], "rule a: fallback must be a list of provider names"],
    ["duplicate ids", [rule("a"), rule("a", { priority: 2 })], "duplicate rule id: a"],
    ["an empty id", [rule("")], "a rule id must not be empty"],
    ["too many rules", Array.from({ length: 501 }, (_, i) => rule(`r${i}`)), "at most 500 rules"],
    ["rules over 1 MB", [rule("big", { reason: "x".repeat(1024 * 1024) })], "larger than 1024 KB"],
  ];

  it.each(bad)("update_rules refuses %s, and the live rules stay", (_name, rules, message) => {
    const router = new RoutingPluginsMCP(fileIn("refuse.yaml"));
    const before = router.getStats().rules_count;
    expect(() => router.updateRules(rules as RoutingRule[])).toThrow(message);
    expect(router.getStats().rules_count).toBe(before);
    expect(rulesProblem(rules)).toContain(message.split(":")[0].split(" ").slice(0, 3).join(" "));
  });

  it("accepts a sound set, including an empty one and rules with and without the optional fields", () => {
    const router = new RoutingPluginsMCP(fileIn("accept.yaml"));
    expect(() => router.updateRules([rule("a", { fallback: ["x"], tags: ["t"] }), rule("b", { priority: 2.5, match: { k: ["v1", "v2"] } })])).not.toThrow();
    expect(() => router.updateRules([])).not.toThrow();
    expect(rulesProblem([])).toBeNull();
  });

  const loadFrom = (name: string, text: string) => {
    const file = fileIn(name);
    fs.writeFileSync(file, text);
    return new RoutingPluginsMCP(file);
  };
  const usesDefaults = (r: RoutingPluginsMCP) => r.applyRoutingRules({ task_type: "qa", task_complexity: "low" }).provider === "claude-haiku" && r.getStats().rules_count === 3;

  it.each([
    ["a rule with no match", "rules:\n  - {id: bad, enabled: true, priority: 1, provider: x, reason: y}\n"],
    ["enabled as text", "rules:\n  - {id: s, enabled: 'no', priority: 1, match: {}, provider: x, reason: y}\n"],
    ["priority as text", "rules:\n  - {id: s, enabled: true, priority: '1', match: {}, provider: x, reason: y}\n"],
    ["duplicate ids", "rules:\n  - {id: d, enabled: true, priority: 1, match: {}, provider: x}\n  - {id: d, enabled: true, priority: 2, match: {}, provider: y}\n"],
    ["rules that are not a list", "rules: {a: 1}\n"],
    ["no rules key", "metadata: {}\n"],
    ["an empty file", ""],
  ])("a rules file with %s uses the built-in rules and says why (it used to break every routing call)", (name, text) => {
    const r = loadFrom(`bad-${name.replace(/\W+/g, "-")}.yaml`, text);
    expect(usesDefaults(r)).toBe(true);
    expect(() => r.applyRoutingRules({ task_type: "anything" })).not.toThrow();
  });

  it("says which problem it found", () => {
    loadFrom("says.yaml", "rules:\n  - {id: bad, enabled: true, priority: 1, provider: x}\n");
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain("each rule needs string id");
  });

  it("a sound rules file still loads", () => {
    const r = loadFrom("sound.yaml", "rules:\n  - {id: mine, enabled: true, priority: 1, match: {task_type: x}, provider: custom, reason: y}\n");
    expect(r.applyRoutingRules({ task_type: "x" }).provider).toBe("custom");
    expect(r.getStats().rules_count).toBe(1);
  });

  it("the rules example in the README is valid", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    const block = readme.match(/\*\*Routing rules\*\*[\s\S]*?```yaml\n([\s\S]*?)```/);
    expect(block).not.toBeNull();
    const parsed = require("yaml").parse(block![1]);
    expect(rulesProblem(parsed.rules)).toBeNull();
  });
});
