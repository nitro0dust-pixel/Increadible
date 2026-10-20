import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Stage 2 of the request drivers (docs/DRIVERS.md): the looped step ("each"), the tolerance matcher ($near), the scope of a scenario,
 * and the three scenarios built on them (gateway, ab-statistics, routing-rules). The scenarios are run against the server compiled
 * from these sources, and then against a server that has been broken on purpose, one thing at a time: a scenario that cannot fail
 * proves nothing.
 */
const lib = require("../scripts/drive-lib.js");

const root = path.join(__dirname, "..");
const scenarioDir = path.join(root, "scripts", "drive-scenarios");
const readScenario = (name: string) => JSON.parse(fs.readFileSync(path.join(scenarioDir, `${name}.json`), "utf8"));

// ---------------------------------------------------------------- the scenario format

describe("a looped step (each)", () => {
  const text = (value: unknown) => ({ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } });
  /** A client that records every call and answers with whatever `answer` makes of it. */
  const client = (answer: (n: number, params: any) => any) => {
    const calls: any[] = [];
    return { calls, rpc: async (_method: string, params: any) => { calls.push(params); return answer(calls.length, params); } };
  };
  const run = (c: any, steps: any[], options: any = {}) => lib.runScenario(c, lib.validateScenario({ name: "t", steps }), options);

  it("sends the same request once per value, keeps the value's own type, and says where it is", async () => {
    const c = client(() => text({}));
    const out = await run(c, [{ name: "s", tool: "t", each: [10, "x", { a: 1 }, null], arguments: { value: "${each}", place: "${index}", label: "v-${each}-${index}" } }]);
    expect(c.calls.map((p) => p.arguments)).toEqual([
      { value: 10, place: 0, label: "v-10-0" },
      { value: "x", place: 1, label: "v-x-1" },
      { value: { a: 1 }, place: 2, label: "v-[object Object]-2" },
      { value: null, place: 3, label: "v-null-3" },
    ]);
    expect(out.steps).toHaveLength(1); // one row in the report, not one per call
    expect([out.steps[0].ok, out.steps[0].summary]).toEqual([true, "ok (4 calls)"]);
  });

  it("lets the expectations name the value too, and works on a method step", async () => {
    const c = client((_n, params) => ({ jsonrpc: "2.0", result: { echoed: params.v } }));
    const out = await run(c, [{ name: "s", method: "echo", each: [1, 2, 3], params: { v: "${each}" }, expect: { result: { echoed: "${each}" } } }]);
    expect(out.ok).toBe(true);
    const wrong = await run(client(() => ({ jsonrpc: "2.0", result: { echoed: 99 } })), [{ name: "s", method: "echo", each: [1, 2], params: { v: "${each}" }, expect: { result: { echoed: "${each}" } } }]);
    expect(wrong.steps[0].problems[0]).toBe("call 1 of 2 (1): result.echoed: expected 1, got 99");
  });

  it("fails the row when any call fails, naming the call and its value, and counts them", async () => {
    const e = client((n) => ({ jsonrpc: "2.0", result: { isError: n === 2 || n === 4, content: [{ type: "text", text: "{}" }] } }));
    const bad = await run(e, [{ name: "s", tool: "t", each: ["a", "b", "c", "d"] }]);
    expect(bad.ok).toBe(false);
    expect(bad.steps[0].summary).toBe("2 of 4 calls failed");
    expect(bad.steps[0].problems).toHaveLength(2);
    expect(bad.steps[0].problems[0]).toMatch(/^call 2 of 4 \("b"\): unexpected tool error/);
    expect(bad.steps[0].problems[1]).toMatch(/^call 4 of 4 \("d"\): unexpected tool error/);
  });

  it("shows the first five problems and counts the rest", async () => {
    const e = client(() => ({ jsonrpc: "2.0", result: { isError: true, content: [{ type: "text", text: "{}" }] } }));
    const out = await run(e, [{ name: "s", tool: "t", each: Array.from({ length: 9 }, (_, i) => i) }]);
    expect(out.steps[0].summary).toBe("9 of 9 calls failed");
    expect(out.steps[0].problems).toHaveLength(6);
    expect(out.steps[0].problems[5]).toBe("... and 4 more calls had problems");
  });

  it("stops at the first call the server does not answer, instead of waiting for every one of them", async () => {
    const c = { calls: 0, rpc: async () => { c.calls++; throw new Error("no answer to tools/call within 20000 ms"); } };
    const out = await run(c, [{ name: "s", tool: "t", each: Array.from({ length: 50 }, (_, i) => i) }]);
    expect(c.calls).toBe(1);
    expect(out.steps[0].summary).toBe("1 of 50 calls failed");
    expect(out.steps[0].problems.join("\n")).toContain("stopped after call 1 of 50: the server gave no answer");
  });

  it("hides a secret in the value it names in a problem", async () => {
    const e = client(() => ({ jsonrpc: "2.0", result: { isError: true, content: [{ type: "text", text: "{}" }] } }));
    const out = await run(e, [{ name: "s", tool: "t", each: ["the-secret-value-1234"] }], { secrets: ["the-secret-value-1234"] });
    expect(JSON.stringify(out)).not.toContain("the-secret-value-1234");
    expect(out.steps[0].problems[0]).toContain("<hidden>");
  });

  it("is skipped as a whole when writes are skipped", async () => {
    const c = client(() => text({}));
    const out = await run(c, [{ name: "s", tool: "t", writes: true, each: [1, 2, 3] }], { skipWrites: true });
    expect(c.calls).toHaveLength(0);
    expect(out.steps[0].skipped).toBe(true);
  });

  it("is refused when it cannot work: no values, not a list, more than the limit, or a save", () => {
    const v = (step: object) => () => lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", ...step }] });
    expect(v({ each: [] })).toThrow(/"each" must be a non-empty list/);
    expect(v({ each: "abc" })).toThrow(/"each" must be a non-empty list/);
    expect(v({ each: { a: 1 } })).toThrow(/"each" must be a non-empty list/);
    expect(v({ each: [1], save: { x: "y" } })).toThrow(/"save" cannot go with "each"/);
    expect(lib.MAX_EACH).toBe(1000);
    expect(v({ each: Array.from({ length: 1000 }, (_, i) => i) })).not.toThrow();
    expect(v({ each: Array.from({ length: 1001 }, (_, i) => i) })).toThrow(/at most 1000 calls per step/);
  });
});

describe("what a writing step writes (writes)", () => {
  const v = (writes: unknown) => () => lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", writes }] });

  it("is true, false, \"ab-data\" or \"rules\", and nothing else", () => {
    for (const ok of [true, false, "ab-data", "rules"]) expect(v(ok)).not.toThrow();
    for (const bad of ["yes", "", "all", 1, 0, null, ["rules"], {}]) expect(v(bad)).toThrow(/"writes" must be true, false, "ab-data" or "rules"/);
  });

  it("counts as a write for every kind except false and none", () => {
    for (const writes of [true, "ab-data", "rules"]) expect(lib.isWrite({ writes })).toBe(true);
    for (const step of [{ writes: false }, {}]) expect(lib.isWrite(step)).toBe(false);
  });

  it("is skipped against a server that is already running, whatever it writes", async () => {
    for (const writes of [true, "ab-data", "rules"]) {
      let calls = 0;
      const client = { rpc: async () => { calls++; return { jsonrpc: "2.0", result: {} }; } };
      const out = await lib.runScenario(client, lib.validateScenario({ name: "t", steps: [{ name: "s", method: "ping", writes }] }), { skipWrites: true });
      expect({ writes, calls, skipped: out.steps[0].skipped }).toEqual({ writes, calls: 0, skipped: true });
    }
  });

  describe("and what the package driver looks for afterwards (dataChecks)", () => {
    const bundleDriver = require("../scripts/drive-bundle.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "datachecks-kinds-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = (name: string, content?: string) => { const f = path.join(dir, name); if (content !== undefined) fs.writeFileSync(f, content); else fs.rmSync(f, { force: true }); return f; };
    const verdict = (steps: any[]) => Object.fromEntries(steps.map((s: any) => [s.name, s]));
    const scenario = (...kinds: any[]) => ({ name: "s", steps: kinds.map((writes, i) => ({ name: "w" + i, tool: "t", writes, arguments: { id: "x-${run_id}" } })) });

    it("the rules file for a scenario that replaces the rules, and not the A/B data file", () => {
      const rules = file("rules1.yaml", "rules: []\n");
      const steps = bundleDriver.dataChecks(file("never-written.jsonl"), scenario("rules"), "RUN1", rules);
      expect(verdict(steps)["data landed in the chosen folder"]).toMatchObject({ ok: true, summary: "rules.yaml written" });
    });

    it("fails when that rules file is missing or empty", () => {
      const missing = bundleDriver.dataChecks(file("a.jsonl"), scenario("rules"), "RUN1", file("rules-missing.yaml"));
      expect(verdict(missing)["data landed in the chosen folder"].ok).toBe(false);
      expect(missing[0].problems[0]).toMatch(/rules-missing\.yaml was not created/);
      const empty = bundleDriver.dataChecks(file("a.jsonl"), scenario("rules"), "RUN1", file("rules-empty.yaml", ""));
      expect(empty[0].problems[0]).toMatch(/rules-empty\.yaml is empty/);
    });

    it("looks beside the data file when it is not told where the rules are", () => {
      file("rules.yaml", "rules: []\n");
      expect(bundleDriver.dataChecks(file("beside.jsonl"), scenario("rules"), "RUN1")[0].ok).toBe(true);
      fs.rmSync(path.join(dir, "rules.yaml"));
      expect(bundleDriver.dataChecks(file("beside.jsonl"), scenario("rules"), "RUN1")[0].ok).toBe(false);
    });

    it("both files for a scenario that writes both, and the run's id only for the A/B data", () => {
      const rules = file("rules2.yaml", "rules: []\n");
      const both = bundleDriver.dataChecks(file("both.jsonl", '{"id":"x-RUN1"}\n'), scenario("ab-data", "rules"), "RUN1", rules);
      expect(both[0]).toMatchObject({ ok: true, summary: "ab-data.jsonl and rules.yaml written" });
      const otherRun = bundleDriver.dataChecks(file("both.jsonl", '{"id":"x-OTHER"}\n'), scenario("ab-data", "rules"), "RUN1", rules);
      expect(otherRun[0].problems[0]).toMatch(/does not contain this run \(RUN1\)/);
      // a rules step with the run id in it does not make the rules file answer to the id
      const rulesOnly = bundleDriver.dataChecks(file("nope.jsonl"), scenario("rules"), "RUN1", rules);
      expect(rulesOnly[0].ok).toBe(true);
    });
  });
});

describe("the tolerance matcher ($near)", () => {
  it("accepts a number within the tolerance on either side, boundaries included, and nothing else", () => {
    const near = { $near: [12.9, 0.5] };
    for (const ok of [12.9, 12.4, 13.4, 12.5, 13.3]) expect(lib.matchValue(ok, near)).toBeNull();
    for (const bad of [12.3999, 13.4001, 0, -12.9]) expect(lib.matchValue(bad, near)).toMatch(/expected \$near \[12\.9,0\.5\], got /);
    for (const notNumber of ["12.9", null, undefined, [12.9], { a: 1 }, true]) expect(lib.matchValue(notNumber, near)).not.toBeNull();
    expect(lib.matchValue(5, { $near: [5, 0] })).toBeNull(); // a tolerance of 0 is an exact number
    expect(lib.matchValue(5.0000001, { $near: [5, 0] })).not.toBeNull();
  });

  it("goes with the other number matchers: every one of them must hold", () => {
    expect(lib.matchValue(3, { $near: [3, 1], $gte: 3 })).toBeNull();
    expect(lib.matchValue(2.5, { $near: [3, 1], $gte: 3 })).not.toBeNull();
  });

  it("is refused in a scenario unless it is [value, tolerance] with a tolerance of 0 or more", () => {
    const v = (near: unknown) => () => lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", expect: { json: { a: { $near: near } } } }] });
    expect(v([1, 0.1])).not.toThrow();
    expect(v([1, 0])).not.toThrow();
    for (const bad of [1, "1", [1], [1, 2, 3], [1, -0.1], ["1", 1], [1, "x"], [NaN, 1], [1, Infinity], null, {}]) expect(v(bad)).toThrow(/\$near must be \[value, tolerance\]/);
  });
});

describe("the scope of a scenario", () => {
  it("is 'any' or 'own-server', and a scenario without one is 'any'", () => {
    const s = (scope: unknown) => () => lib.validateScenario({ name: "t", scope, steps: [{ name: "s", method: "ping" }] });
    expect(s("any")).not.toThrow();
    expect(s("own-server")).not.toThrow();
    for (const bad of ["", "own", "remote", true, 1, null, ["any"]]) expect(s(bad)).toThrow(/"scope" must be one of: any, own-server/);
    expect(() => lib.validateScenario({ name: "t", steps: [{ name: "s", method: "ping" }] })).not.toThrow();
  });

  it("is 'own-server' on every shipped scenario that changes the server beyond its test data, and the basic one has none", () => {
    expect(readScenario("basic").scope).toBeUndefined();
    for (const name of ["gateway", "ab-statistics", "routing-rules"]) expect({ name, scope: readScenario(name).scope }).toEqual({ name, scope: "own-server" });
    expect(lib.listScenarios()).toEqual(expect.arrayContaining(["basic", "gateway", "ab-statistics", "routing-rules"]));
  });
});

// ---------------------------------------------------------------- the known data of ab-statistics, worked out here, not by the server

describe("ab-statistics: the numbers the scenario expects are the arithmetic of the values it sends", () => {
  const scenario = readScenario("ab-statistics");
  const step = (name: string) => scenario.steps.find((s: any) => s.name === name);
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
  const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)); };
  const A: number[] = step("record 60 measurements for A").each;
  const B: number[] = step("record 60 measurements for B").each;
  const expectations = step("results: means, spreads, intervals, effect size and p-value of the known data").expect.json;
  const q = (v: string, what: string) => expectations[`variant_results.${v}.metrics.quality.${what}`];

  it("has 60 values per variant, as the pattern the description gives", () => {
    expect(A).toEqual(Array.from({ length: 60 }, (_, i) => 10 + (i % 7)));
    expect(B).toEqual(Array.from({ length: 60 }, (_, i) => 14 + (i % 5)));
  });

  it("expects the mean and the sample standard deviation of those values", () => {
    expect(Math.abs(mean(A) - q("A", "mean").$near[0])).toBeLessThanOrEqual(q("A", "mean").$near[1]);
    expect(Math.abs(mean(B) - q("B", "mean").$near[0])).toBeLessThanOrEqual(q("B", "mean").$near[1]);
    expect(Math.abs(sd(A) - q("A", "std_dev").$near[0])).toBeLessThanOrEqual(q("A", "std_dev").$near[1]);
    expect(Math.abs(sd(B) - q("B", "std_dev").$near[0])).toBeLessThanOrEqual(q("B", "std_dev").$near[1]);
  });

  it("expects an interval between the one a normal quantile gives (1.96) and the one a quantile of 2.05 gives", () => {
    for (const [v, values] of [["A", A], ["B", B]] as const) {
      const se = sd(values) / Math.sqrt(values.length);
      const lower = q(v, "ci_95.0"), upper = q(v, "ci_95.1");
      // the bands are rounded outward to three decimals: they hold the exact band and are less than 0.001 wider on each side
      const around = (actual: number, exact: number, outward: 1 | -1) => { expect(outward * (actual - exact)).toBeGreaterThanOrEqual(0); expect(outward * (actual - exact)).toBeLessThan(0.001); };
      around(lower.$gte, mean(values) - 2.05 * se, -1);
      around(lower.$lte, mean(values) - 1.96 * se, 1);
      around(upper.$gte, mean(values) + 1.96 * se, -1);
      around(upper.$lte, mean(values) + 2.05 * se, 1);
    }
  });

  it("expects Cohen's d of the two samples (A minus B, over the pooled standard deviation)", () => {
    const pooled = Math.sqrt((sd(A) ** 2 + sd(B) ** 2) / 2);
    const d = (mean(A) - mean(B)) / pooled;
    const wanted = expectations["statistical_analysis.effect_sizes.quality"].$near;
    expect(Math.abs(d - wanted[0])).toBeLessThanOrEqual(wanted[1]);
  });

  it("sends the same values to both variants of the second experiment, and expects no difference", () => {
    expect(step("the same 60 measurements for A").each).toEqual(A);
    expect(step("the same 60 measurements for B").each).toEqual(A);
    const none = step("results: no difference, p = 1, no winner").expect.json;
    expect(none["statistical_analysis.p_values.quality"].$near[0]).toBe(1);
    expect(none["statistical_analysis.effect_sizes.quality"].$near[0]).toBe(0);
  });

  it("needs at least 100 samples before it expects a result, and sends 120 in each experiment", () => {
    expect(A.length + B.length).toBeGreaterThanOrEqual(100);
    expect(step("results are incomplete at 60 of 100 samples").expect.json["statistical_analysis.current_samples"]).toBe(A.length);
    expect(step("results are incomplete at 60 of 100 samples").expect.json["statistical_analysis.message"]).toBe(`Need ${100 - A.length} more samples`);
  });
});

// ---------------------------------------------------------------- the scenarios against the real server, and against a broken one

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-scenarios-test-"));
const server = path.join(tmp, "server"); // a root the drivers can use: package.json, dist/, node_modules

beforeAll(() => {
  fs.mkdirSync(server);
  fs.symlinkSync(path.join(root, "node_modules"), path.join(server, "node_modules"), "dir");
  fs.copyFileSync(path.join(root, "package.json"), path.join(server, "package.json"));
  const tsc = cp.spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(server, "dist")], { cwd: root, encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`the build for the scenario tests failed:\n${tsc.stdout}${tsc.stderr}`);
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Ran { status: number | null; stdout: string; stderr: string; json: any }
function drive(script: string, args: string[]): Ran {
  const r = cp.spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], { encoding: "utf8", timeout: 90_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  let json: any;
  try { json = JSON.parse(r.stdout); } catch { /* not a --json run */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const failing = (ran: Ran) => ran.json.results[0].steps.filter((s: any) => !s.ok).map((s: any) => s.name);
const stepsOf = (ran: Ran) => ran.json.results[0].steps.map((s: any) => s.name);

/** Changes one compiled file of the test server in place for the duration of fn. The breakage must hit exactly one place. */
function broken<T>(file: string, from: string, to: string, fn: () => T): T {
  const target = path.join(server, "dist", ...file.split("/"));
  const original = fs.readFileSync(target, "utf8");
  expect({ file, occurrences: original.split(from).length - 1 }).toEqual({ file, occurrences: 1 });
  fs.writeFileSync(target, original.replace(from, () => to));
  try { return fn(); } finally { fs.writeFileSync(target, original); }
}
const ROUTING = "features/07-routing-plugins/src/mcp-server.js";
const AB = "features/08-ab-testing/src/mcp-server.js";
const GATEWAY = "features/09-api-gateway/src/mcp-server.js";
const stdio = (scenario: string) => drive("drive-stdio.js", ["--root", server, "--scenario", scenario, "--json"]);

describe("the shipped scenarios pass against the server as it is", () => {
  for (const name of ["gateway", "ab-statistics", "routing-rules"]) {
    it(`${name}: over stdio`, () => {
      const ran = stdio(name);
      expect({ status: ran.status, failing: ran.json && failing(ran) }).toEqual({ status: 0, failing: [] });
      expect(ran.json.results[0].steps.length).toBeGreaterThan(20);
    });
  }

  it("ab-statistics and routing-rules: over HTTP, with the token, the metrics and the SIGTERM shutdown", () => {
    for (const name of ["ab-statistics", "routing-rules"]) {
      const ran = drive("drive-http.js", ["--root", server, "--scenario", name, "--json"]);
      expect({ name, status: ran.status, failing: ran.json && failing(ran) }).toEqual({ name, status: 0, failing: [] });
      expect(stepsOf(ran)).toContain("metrics: the calls were counted");
    }
  });
});

describe("a driver that starts no server of its own refuses a scenario that changes one", () => {
  it("drive-http --url: exit 2, the reason named, and nothing sent", () => {
    for (const name of ["gateway", "ab-statistics", "routing-rules"]) {
      const ran = drive("drive-http.js", ["--url", "http://127.0.0.1:9", "--scenario", name, "--allow-writes"]);
      expect({ name, status: ran.status }).toEqual({ name, status: 2 });
      expect(ran.stderr).toContain(`the scenario "${name}" changes what the server holds beyond its own test data`);
      expect(ran.stderr).toContain("never with --url");
    }
  });

  it("but the basic scenario still goes to a server that is not there, and fails on the readiness check (exit 1), not on the scope", () => {
    const ran = drive("drive-http.js", ["--url", "http://127.0.0.1:9", "--ready-timeout-ms", "300", "--json"]);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["ready"]);
  });
});

describe("routing-rules notices a server that routes wrongly", () => {
  const run = () => stdio("routing-rules");
  it("rules tried in the wrong order", () => {
    const ran = broken(ROUTING, "const sorted = [...newRules].sort((a, b) => a.priority - b.priority);", "const sorted = [...newRules].sort((a, b) => b.priority - a.priority);", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("own rules: the lowest number among the enabled rules wins (a disabled rule with an even lower number and an empty match is skipped)");
  });
  it("a disabled rule that is not skipped", () => {
    const ran = broken(ROUTING, "if (!rule.enabled)\n                continue;", "", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("own rules: the lowest number among the enabled rules wins (a disabled rule with an even lower number and an empty match is skipped)");
  });
  it("a list that matches only its first value", () => {
    const ran = broken(ROUTING, "if (!value.includes(request[key]))", "if (value[0] !== request[key])", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(expect.arrayContaining(["built-in: a low-complexity summary does too (a list of task types)", "own rules: a list matches any of its values (z)"]));
  });
  it("a refused rule set that is applied anyway", () => {
    const ran = broken(ROUTING, "const problem = rulesProblem(newRules);\n        if (problem)\n            throw new Error(problem);", "const problem = null;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(expect.arrayContaining(["refused: two rules with one id", "refused: a priority that is text"]));
  });
});

describe("ab-statistics notices a server that computes wrongly", () => {
  const run = () => stdio("ab-statistics");
  const results = "results: means, spreads, intervals, effect size and p-value of the known data";
  it("a standard deviation divided by n instead of n - 1", () => {
    const ran = broken(AB, "const variance = r.n > 1 ? Math.max(0, r.m2) / (r.n - 1) : 0;", "const variance = r.n > 1 ? Math.max(0, r.m2) / r.n : 0;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain(results);
  });
  it("an interval that is too narrow", () => {
    const ran = broken(AB, "(tCritical95(g.n - 1) * g.std) / Math.sqrt(g.n)", "(tCritical95(g.n - 1) * g.std) / g.n", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain(results);
  });
  it("a p-value that is always 1", () => {
    const ran = broken(AB, "return Math.min(1, erfc(z / Math.SQRT2));", "return 1;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain(results);
  });
  it("the wrong variant named the winner", () => {
    const ran = broken(AB, "winner = vs[leader].id;", "winner = vs[0].id;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(expect.arrayContaining([results, "the winner is B"]));
  });
});

describe("gateway notices a server that answers wrongly", () => {
  const run = () => stdio("gateway");
  it("a cache that never hits", () => {
    const ran = broken(GATEWAY, "const cached = this.getFromCache(cacheKey);", "const cached = null;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(expect.arrayContaining(["the same call again is answered from the cache", "statistics: the server counted what the driver asked for"]));
  });
  it("a counter that does not count", () => {
    const ran = broken(GATEWAY, "this.stats.successful++;", "", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["statistics: the server counted what the driver asked for"]);
  });
  it("an error message that is not the one the tool names", () => {
    const ran = broken(GATEWAY, 'return JSON.stringify({ error: "query must be a string" });', 'return JSON.stringify({ error: "bad query" });', run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["discover: a query that is not text"]);
  });
  it("an aggregation limit that is too high", () => {
    const ran = broken(GATEWAY, "exports.MAX_AGGREGATE_CALLS = 100;", "exports.MAX_AGGREGATE_CALLS = 1000;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("aggregate: more than 100 calls in one request");
  });
});
