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

  it("hides the secret before it cuts the value short, so a cut through the secret leaves no half of it (mutation run 4)", async () => {
    const secret = "the-secret-value-1234";
    const value = "x".repeat(50) + secret + "tail"; // the preview is cut at 60 characters: inside the secret
    const e = client(() => ({ jsonrpc: "2.0", result: { isError: true, content: [{ type: "text", text: "{}" }] } }));
    const out = await run(e, [{ name: "s", tool: "t", each: [value] }], { secrets: [secret] });
    expect(JSON.stringify(out)).not.toContain("the-secret");
    expect(out.steps[0].problems[0]).toContain("x<hidden>");
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
    let dir = "";
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "datachecks-kinds-")); });
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
      // nor does a rules step that uses the run id make the A/B data answer to it: only a step that writes A/B data does (mutation run 4)
      const mixed = { name: "s", steps: [{ name: "a", tool: "t", writes: "ab-data", arguments: { id: "fixed" } }, { name: "r", tool: "t", writes: "rules", arguments: { id: "x-${run_id}" } }] };
      const fine = bundleDriver.dataChecks(file("fixed.jsonl", '{"id":"fixed"}\n'), mixed, "RUN1", rules);
      expect(fine[0]).toMatchObject({ ok: true, summary: "ab-data.jsonl and rules.yaml written" });
      // a rules step with the run id in it does not make the rules file answer to the id
      const rulesOnly = bundleDriver.dataChecks(file("nope.jsonl"), scenario("rules"), "RUN1", rules);
      expect(rulesOnly[0].ok).toBe(true);
    });
  });
});

describe("variables in a scenario (the review's findings)", () => {
  it("looks inside a saved value or the value of a loop with a dotted name, and keeps the type when the whole string is the name", () => {
    const vars = { each: { user: "u1", n: 7, nested: { deep: [10, 20] } }, run_id: "R1" };
    expect(lib.substitute("${each.user}", vars)).toBe("u1");
    expect(lib.substitute("${each.n}", vars)).toBe(7);
    expect(lib.substitute("${each.nested.deep.1}", vars)).toBe(20);
    expect(lib.substitute("user-${each.user}-${run_id}", vars)).toBe("user-u1-R1");
    expect(lib.substitute({ a: ["${each.n}"], b: { c: "${each.nested}" } }, vars)).toEqual({ a: [7], b: { c: { deep: [10, 20] } } });
  });

  it("says what is missing: a variable nobody saved, or a field the value does not have", () => {
    expect(() => lib.substitute("${nope}", {})).toThrow("unknown variable ${nope} (no earlier step saved it)");
    expect(() => lib.substitute("${each.nope}", { each: { user: "u1" } })).toThrow("unknown variable ${each.nope} (the value of each has nothing at nope)");
    expect(() => lib.substitute("a ${x.y} b", { x: {} })).toThrow(/unknown variable \$\{x\.y\}/);
  });

  it("looks at the variables' own properties only: ${constructor} and ${toString} are unknown, not Object's functions", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) expect(() => lib.substitute("${" + name + "}", {})).toThrow(/unknown variable/);
    expect(() => lib.substitute("${each.constructor}", { each: {} })).toThrow(/unknown variable/);
    expect(lib.substitute("${hasOwnProperty}", { hasOwnProperty: "mine" })).toBe("mine"); // a saved variable of that name is a variable
  });

  it("substitutes the keys of objects too, so an expectation's path can name the place in a loop", () => {
    expect(lib.substitute({ "apis.${index}.id": { $exists: false } }, { index: 3 })).toEqual({ "apis.3.id": { $exists: false } });
    expect(lib.substitute({ "k-${each}": 1 }, { each: "z" })).toEqual({ "k-z": 1 });
  });

  it("makes an expectation with the place in its path check the right place (it used to look for the text ${index})", async () => {
    const answer = (n: number) => ({ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ apis: [{ id: "a" }, { id: "b" }, { id: "c" }], n }) }], isError: false } });
    const client = { rpc: async () => answer(1) };
    const ok = await lib.runScenario(client, lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", each: [0, 1, 2], expect: { json: { "apis.${index}.id": { $type: "string" } } } }] }), {});
    expect(ok.ok).toBe(true);
    const never = await lib.runScenario(client, lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", each: [0, 1], expect: { json: { "apis.${index}.id": { $exists: false } } } }] }), {});
    expect(never.ok).toBe(false); // the id is there at every place: a check that "it is absent" must fail, whatever the path says
    expect(never.steps[0].problems[0]).toMatch(/json\.apis\.0\.id: expected \$exists false/);
  });

  it("does not let a step save a name the runner uses itself", () => {
    for (const name of ["each", "index", "run_id"]) {
      expect(() => lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", save: { [name]: "x" } }] })).toThrow(`"save" cannot name "${name}"`);
    }
    expect(() => lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", save: { mine: "x" } }] })).not.toThrow();
  });
});

describe("the same request twice (same_again)", () => {
  const text = (value: unknown) => ({ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } });
  const run = (client: any, step: object) => lib.runScenario(client, lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", ...step }] }), {});

  it("passes when the second answer is the first one, and sends exactly two requests", async () => {
    const calls: number[] = [];
    const client = { rpc: async () => { calls.push(1); return text({ variant: "A" }); } };
    const out = await run(client, { same_again: true, expect: { json: { variant: "A" } } });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("fails when the second answer differs, showing both", async () => {
    let n = 0;
    const out = await run({ rpc: async () => text({ variant: n++ % 2 ? "B" : "A" }) }, { same_again: true });
    expect(out.ok).toBe(false);
    expect(out.steps[0].problems[0]).toMatch(/^the same request, sent again, was answered differently: .*"variant\\":\\"A.* then .*"variant\\":\\"B/);
  });

  it("does not send the second request when the first answer was malformed or the step has no same_again", async () => {
    const calls: number[] = [];
    await run({ rpc: async () => { calls.push(1); return { result: {} }; } }, { same_again: true });
    expect(calls).toHaveLength(1);
    const plain: number[] = [];
    await run({ rpc: async () => { plain.push(1); return text({}); } }, {});
    expect(plain).toHaveLength(1);
  });

  it("compares error answers too, and reports a second request that gets no answer", async () => {
    const same = await run({ rpc: async () => ({ jsonrpc: "2.0", error: { code: -32601, message: "no" } }) }, { tool: undefined, method: "x", same_again: true, expect: { rpc_error: -32601 } });
    expect(same.ok).toBe(true);
    let n = 0;
    const out = await run({ rpc: async () => { if (n++ === 1) throw new Error("no answer to tools/call within 20000 ms"); return text({}); } }, { same_again: true });
    expect(out.ok).toBe(false);
    expect(out.steps[0].problems[0]).toContain("no answer to tools/call");
  });

  it("must be true or false", () => {
    for (const bad of ["yes", 1, null, {}]) expect(() => lib.validateScenario({ name: "t", steps: [{ name: "s", tool: "t", same_again: bad }] })).toThrow(/"same_again" must be true or false/);
  });
});

describe("a loop that cannot run, or runs too long (the review's findings)", () => {
  const text = { jsonrpc: "2.0", result: { content: [{ type: "text", text: "{}" }], isError: false } };
  const run = (client: any, steps: any[], options: any = {}) => lib.runScenario(client, lib.validateScenario({ name: "t", steps }), options);

  it("says the scenario is wrong, sends nothing and stops at once for an unknown variable: not 'the server gave no answer'", async () => {
    let sent = 0;
    const out = await run({ rpc: async () => { sent++; return text; } }, [{ name: "s", tool: "t", each: ["a", "b", "c"], arguments: { q: "${nope}" } }]);
    expect(sent).toBe(0);
    expect(out.steps[0].summary).toBe("1 of 3 calls failed");
    expect(out.steps[0].problems.join("\n")).toContain("unknown variable ${nope}");
    expect(out.steps[0].problems.join("\n")).toContain("stopped after call 1 of 3: the scenario is wrong, so no call was sent");
    expect(out.steps[0].problems.join("\n")).not.toContain("gave no answer");
  });

  it("still says the server gave no answer when the request itself fails, and a plain step with an unknown variable says scenario error", async () => {
    const down = await run({ rpc: async () => { throw new Error("socket hang up"); } }, [{ name: "s", tool: "t", each: [1, 2, 3] }]);
    expect(down.steps[0].problems.join("\n")).toContain("stopped after call 1 of 3: the server gave no answer");
    const plain = await run({ rpc: async () => text }, [{ name: "s", tool: "t", arguments: { q: "${nope}" } }]);
    expect(plain.steps[0].summary).toBe("scenario error");
  });

  it("stops a looped step that has used up its time budget, saying how far it got", async () => {
    let n = 0;
    const slow = { rpc: async () => { n++; await new Promise((r) => setTimeout(r, 25)); return text; } };
    const out = await run(slow, [{ name: "s", tool: "t", each: Array.from({ length: 40 }, (_, i) => i) }], { eachBudgetMs: 120 });
    expect(n).toBeLessThan(40);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(out.ok).toBe(false);
    expect(out.steps[0].problems.join("\n")).toMatch(new RegExp(`stopped after ${n} of 40 calls: the step used up its time budget \\(0 s\\)`));
  });

  it("refuses a scenario that makes more than 5000 requests in all, however they are spread over the steps", () => {
    expect(lib.MAX_CALLS).toBe(5000);
    const loop = (n: number, name: string) => ({ name, tool: "t", each: Array.from({ length: n }, (_, i) => i) });
    expect(() => lib.validateScenario({ name: "t", steps: [loop(1000, "a"), loop(1000, "b"), loop(1000, "c"), loop(1000, "d"), loop(1000, "e")] })).not.toThrow(); // 5000
    expect(() => lib.validateScenario({ name: "t", steps: [loop(1000, "a"), loop(1000, "b"), loop(1000, "c"), loop(1000, "d"), loop(1000, "e"), { name: "f", tool: "t" }] })).toThrow(/the steps make 5001 requests in all; at most 5000 per scenario/);
  });
});

describe("a folder that already holds the server's data (the review's first finding)", () => {
  const writing = lib.validateScenario({ name: "w", scope: "own-server", steps: [{ name: "s", tool: "t", writes: "rules" }] });
  const reading = lib.validateScenario({ name: "r", scope: "own-server", steps: [{ name: "s", tool: "t" }] });
  const basic = lib.validateScenario({ name: "b", steps: [{ name: "s", tool: "t", writes: true }] });
  let dir = "";
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-data-test-")); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lists the three files the server would use in a work directory", () => {
    expect(lib.dataFiles("/d").map((f: string) => path.basename(f)).sort()).toEqual(["ab-data.jsonl", "experiments.yaml", "rules.yaml"]);
  });

  it("refuses an own-server scenario that writes when any of them is there, naming it", () => {
    const folder = fs.mkdtempSync(path.join(dir, "used-"));
    expect(() => lib.assertFreshData(lib.dataFiles(folder), writing)).not.toThrow(); // empty folder
    fs.writeFileSync(path.join(folder, "rules.yaml"), "rules: []\n");
    expect(() => lib.assertFreshData(lib.dataFiles(folder), writing)).toThrow(/rules\.yaml is already in the data folder: give an empty folder/);
    fs.writeFileSync(path.join(folder, "ab-data.jsonl"), "{}\n");
    expect(() => lib.assertFreshData(lib.dataFiles(folder), writing)).toThrow(/ab-data\.jsonl and rules\.yaml are already in the data folder|rules\.yaml and ab-data\.jsonl are already in the data folder/);
    expect(() => lib.assertFreshData(lib.dataFiles(folder), writing)).toThrow(lib.UsageError);
  });

  it("lets a scenario through that does not write, one that is not own-server, and a folder that does not exist yet", () => {
    const folder = fs.mkdtempSync(path.join(dir, "used2-"));
    fs.writeFileSync(path.join(folder, "rules.yaml"), "rules: []\n");
    expect(() => lib.assertFreshData(lib.dataFiles(folder), reading)).not.toThrow();
    expect(() => lib.assertFreshData(lib.dataFiles(folder), basic)).not.toThrow();
    expect(() => lib.assertFreshData(lib.dataFiles(path.join(dir, "nope")), writing)).not.toThrow();
    expect(() => lib.assertFreshData([undefined, undefined, undefined], writing)).not.toThrow();
  });
});

describe("the tolerance matcher ($near)", () => {
  it("accepts a number within the tolerance on either side, boundaries included, and nothing else", () => {
    const near = { $near: [12.9, 0.5] };
    for (const ok of [12.9, 12.4, 13.4, 12.5, 13.3]) expect(lib.matchValue(ok, near)).toBeNull();
    for (const bad of [12.3999, 13.4001, 0, -12.9]) expect(lib.matchValue(bad, near)).toMatch(/expected \$near \[12\.9,0\.5\], got /);
    for (const notNumber of ["12.9", null, undefined, [12.9], { a: 1 }, true]) expect(lib.matchValue(notNumber, near)).not.toBeNull();
    expect(lib.matchValue(5, { $near: [5, 0] })).toBeNull(); // a tolerance of 0 is an exact number
    // "ends included" holds for numbers that are not exactly representable too: 1.1 - 1.0 is 0.10000000000000009 in floating point
    expect(lib.matchValue(1.0, { $near: [1.1, 0.1] })).toBeNull();
    expect(lib.matchValue(1.2, { $near: [1.1, 0.1] })).toBeNull();
    expect(lib.matchValue(0.7, { $near: [0.8, 0.1] })).toBeNull();
    expect(lib.matchValue(1.2001, { $near: [1.1, 0.1] })).not.toBeNull();
    expect(lib.matchValue(0.9999, { $near: [1.1, 0.1] })).not.toBeNull();
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

describe("a driver refuses to start a writing own-server scenario on a folder that already holds the server's data", () => {
  const mcpb = require("../scripts/mcpb.js");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const bundle = path.join(tmp, "bundle3", `${pkg.name}-${pkg.version}.mcpb`);
  beforeAll(() => { fs.mkdirSync(path.dirname(bundle)); mcpb.build(bundle); }, 240_000);
  const used = (name: string, files: Record<string, string>) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
    return dir;
  };
  const drivers: Array<[string, string[]]> = [["drive-stdio.js", ["--root", server]], ["drive-http.js", ["--root", server]], ["drive-bundle.js", ["--bundle", bundle]]];

  for (const [script, extra] of drivers) {
    it(`${script}: exit 2, the folder untouched, the reason named`, () => {
      const dir = used("used-" + script, { "rules.yaml": "rules: [] # the user's own\n" });
      const ran = drive(script, [...extra, "--scenario", "routing-rules", "--data-dir", dir]);
      expect(ran.status).toBe(2);
      expect(ran.stderr).toContain('the scenario "routing-rules" writes data and replaces the routing rules of the server it starts, and rules.yaml is already in the data folder');
      expect(fs.readdirSync(dir)).toEqual(["rules.yaml"]);
      expect(fs.readFileSync(path.join(dir, "rules.yaml"), "utf8")).toBe("rules: [] # the user's own\n");
    });
  }

  it("but the scenarios that do not write, and the basic one, still run in a used folder", () => {
    const dir = used("used-ok", { "ab-data.jsonl": "" });
    expect(drive("drive-stdio.js", ["--root", server, "--scenario", "gateway", "--data-dir", dir]).status).toBe(0);
    expect(drive("drive-stdio.js", ["--root", server, "--scenario", "basic", "--data-dir", dir]).status).toBe(0);
  });

  it("and a folder that does not exist yet is made and used, once: the second run into it is refused", () => {
    const dir = path.join(tmp, "made-by-the-driver");
    const first = drive("drive-stdio.js", ["--root", server, "--scenario", "routing-rules", "--data-dir", dir]);
    expect(first.status).toBe(0);
    expect(fs.existsSync(path.join(dir, "rules.yaml"))).toBe(true);
    const again = drive("drive-stdio.js", ["--root", server, "--scenario", "routing-rules", "--data-dir", dir]);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("already in the data folder");
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
  it("rules that are not sorted by their priority numbers (the scenario sends them out of order)", () => {
    const ran = broken(ROUTING, "const sorted = [...newRules].sort((a, b) => a.priority - b.priority);", "const sorted = [...newRules];", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("own rules: the lowest number among the enabled rules wins (a disabled rule with an even lower number and an empty match is skipped)");
  });
  it("statistics that count a disabled rule as enabled", () => {
    const ran = broken(ROUTING, "enabled_rules: this.rules.filter((r) => r.enabled).length,", "enabled_rules: this.rules.length,", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("own rules: the statistics count that rule by its name, as a percentage and not NaN%, and count the rules as sent");
  });
  it("a provider share that is not a number", () => {
    const ran = broken(ROUTING, "breakdown[provider] = `${percentage.toFixed(1)}%`;", 'breakdown[provider] = "NaN%";', run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("own rules: the statistics count that rule by its name, as a percentage and not NaN%, and count the rules as sent");
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
  it("a winner announced without significance", () => {
    const ran = broken(AB, "adjusted.get(x.k) < SIGNIFICANCE_LEVEL && means[leader] !== means[x.other]", "means[leader] !== means[x.other]", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(expect.arrayContaining(["results: a leader that is not significant is not a winner", "no clear winner for it either"]));
  });
  it("users given a random variant each time", () => {
    const ran = broken(AB, "? bucket(`${experimentId}:${userId}`)", "? bucket(`${experimentId}:${Math.random()}`)", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("assignment: 16 users get the variants recorded for them, and the same one again when asked a second time");
  });
  it("every user given the same variant", () => {
    const ran = broken(AB, "function bucket(key) {", "function bucket(key) { return 0;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("assignment: 16 users get the variants recorded for them, and the same one again when asked a second time");
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
    expect(failing(ran)).toEqual(expect.arrayContaining(["the same call again is answered from the cache", "statistics: the server counted what the driver asked for, API by API"]));
  });
  it("a counter that does not count", () => {
    const ran = broken(GATEWAY, "this.stats.successful++;", "", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["statistics: the server counted what the driver asked for, API by API"]);
  });
  it("an error message that is not the one the tool names", () => {
    const ran = broken(GATEWAY, 'return JSON.stringify({ error: "query must be a string" });', 'return JSON.stringify({ error: "bad query" });', run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toEqual(["discover: a query that is not text"]);
  });
  const partial = "aggregate: one call fails, the others keep their answers, in the order asked, and the reply is not an error";
  it("one failed call that turns the whole aggregation into an error", () => {
    const ran = broken(GATEWAY, "if (results.length > 0 && failed === results.length) {", "if (results.length > 0 && failed > 0) {", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain(partial);
  });
  it("aggregated answers in the wrong order", () => {
    const ran = broken(GATEWAY, "return JSON.stringify({ data: results, count: results.length, ...(failed > 0 ? { failed } : {}) });", "return JSON.stringify({ data: [...results].reverse(), count: results.length, ...(failed > 0 ? { failed } : {}) });", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain(partial);
  });
  it("an aggregation that does not say how many calls failed", () => {
    const ran = broken(GATEWAY, "...(failed > 0 ? { failed } : {})", "...{}", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain(partial);
  });
  it("a cache that ignores the params", () => {
    const ran = broken(GATEWAY, "const rawKey = `${apiId}:${endpoint}:${JSON.stringify(params)}`;", "const rawKey = `${apiId}:${endpoint}`;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("params make a different call: {id: 2} is not answered with the first one's data");
  });
  it("calls counted under the wrong API", () => {
    const ran = broken(GATEWAY, "this.stats.api_distribution[apiId] =\n                (this.stats.api_distribution[apiId] || 0) + 1;", 'const k = apiId === "finnhub" ? "misattributed" : apiId; this.stats.api_distribution[k] = (this.stats.api_distribution[k] || 0) + 1;', run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("statistics: the server counted what the driver asked for, API by API");
  });
  it("exactly 100 calls refused as too many", () => {
    const ran = broken(GATEWAY, "if (apis.length > exports.MAX_AGGREGATE_CALLS)", "if (apis.length >= exports.MAX_AGGREGATE_CALLS)", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("aggregate: exactly 100 calls in one request are accepted");
  });
  it("an aggregation limit that is too high", () => {
    const ran = broken(GATEWAY, "exports.MAX_AGGREGATE_CALLS = 100;", "exports.MAX_AGGREGATE_CALLS = 1000;", run);
    expect(ran.status).toBe(1);
    expect(failing(ran)).toContain("aggregate: 101 calls in one request are refused");
  });
});
