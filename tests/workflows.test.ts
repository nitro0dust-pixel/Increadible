import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

/**
 * workflows/*.js (docs/DRIVERS-WORKFLOW.md): the scripts of the multi-agent workflows. They are plain JavaScript run by the Workflow tool, which supplies
 * agent(), parallel(), phase() and log(). Here they are checked as files, and their orchestration (who may approve, when the loop stops, what a missing
 * answer means) is run with stand-ins for the agents, so the rules are tested without a model: a rule nobody can see fail is a wish.
 */
const dir = path.join(__dirname, "..", "workflows");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
const AsyncFunction = Object.getPrototypeOf(async function () { /* only for its constructor */ }).constructor;

interface Script { name: string; text: string; meta: any; body: string }
function load(file: string): Script {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const m = /^export const meta = (\{[\s\S]*?\n\})\n/m.exec(text);
  if (!m) throw new Error(`${file}: no "export const meta = {...}" at the top`);
  const meta = vm.runInNewContext(`(${m[1]})`, Object.freeze({})); // a pure literal: it must evaluate with nothing in scope
  return { name: file.replace(/\.js$/, ""), text, meta, body: text.replace(m[0], "") };
}
const scripts = files.map(load);

describe("the workflow scripts as files", () => {
  it("are there: drive-gate and engineer-loop", () => {
    expect(files).toEqual(["drive-gate.js", "engineer-loop.js"]);
  });

  for (const s of scripts) {
    describe(s.name, () => {
      it("has a meta that is a pure literal with the name of the file, a one-line description and phases with unique titles", () => {
        expect(s.meta.name).toBe(s.name);
        expect(typeof s.meta.description).toBe("string");
        expect(s.meta.description.length).toBeGreaterThan(20);
        expect(s.meta.description).not.toContain("\n");
        const titles = s.meta.phases.map((p: any) => p.title);
        expect(new Set(titles).size).toBe(titles.length);
        expect(titles.length).toBeGreaterThanOrEqual(3);
      });

      it("compiles as the body of an async function (plain JavaScript, no TypeScript)", () => {
        expect(() => new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "budget", "workflow", s.body)).not.toThrow();
        expect(s.body).not.toMatch(/:\s*(string|number|boolean|any)\b\s*[=,)]/); // a type annotation
      });

      it("calls phase() only with the titles its meta lists, and uses every title", () => {
        const titles = new Set(s.meta.phases.map((p: any) => p.title));
        const used = new Set<string>();
        for (const m of s.body.matchAll(/\bphase\((?:'([^']+)'|"([^"]+)")\)/g)) used.add(m[1] ?? m[2]);
        for (const m of s.body.matchAll(/phase: '([^']+)'/g)) used.add(m[1]);
        for (const t of used) expect({ title: t, listed: titles.has(t) }).toEqual({ title: t, listed: true });
        for (const t of titles) expect({ title: t, used: used.has(t as string) }).toEqual({ title: t, used: true });
      });

      it("uses nothing that would break a resume: no clock, no randomness", () => {
        expect(s.body).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)/);
      });

      it("never pushes, merges or deploys: the only git and gh words in its instructions are the ones that forbid it or read", () => {
        const bad = s.text.split("\n").filter((l) => /git push|gh pr (create|merge)|npm publish|kubectl apply|railway up|docker push/.test(l) && !/never|not |no |do not|forbid|without/i.test(l));
        expect(bad).toEqual([]);
      });
    });
  }
});

// ---------------------------------------------------------------- running the orchestration with stand-ins for the agents

type Handler = (label: string, prompt: string, opts: any) => any;
async function run(script: string, args: any, handler: Handler) {
  const s = scripts.find((x) => x.name === script)!;
  const calls: Array<{ label: string; prompt: string; opts: any }> = [];
  const agent = async (prompt: string, opts: any = {}) => { calls.push({ label: opts.label, prompt, opts }); const out = await handler(opts.label, prompt, opts); return out === undefined ? null : out; };
  const parallel = async (thunks: Array<() => Promise<any>>) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const logs: string[] = [];
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "budget", "workflow", s.body);
  const result = await fn(args, agent, parallel, undefined, () => undefined, (m: string) => logs.push(m), { total: null, spent: () => 0, remaining: () => Infinity }, undefined);
  return { result, calls, logs };
}

describe("drive-gate: who decides", () => {
  const runOk = (label: string, exit = 0) => ({ label, exit_code: exit, report_path: `/e/${label}.json`, table_path: `/e/${label}.txt`, sha256: "a".repeat(64), node_version: "v22", git_head: "abc", tracked_files_modified: false });
  const critic = (role: string, verdict = "PASS", findings: any[] = []) => ({ role, verdict, checked: ["x"], findings });
  // the handler has the shape of agent(): label, prompt, options; these two do not need the prompt or the options
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const gate = (over: Partial<Record<string, any>> = {}) => (label: string, _prompt?: string, _opts?: any): any => {
    if (label.startsWith("run:")) return "run" in over ? over.run(label.slice(4)) : runOk(label.slice(4));
    if (label === "critic:validation") return "validation" in over ? over.validation : critic("validation");
    if (label === "critic:security") return "security" in over ? over.security : critic("security");
    if (label === "critic:adversarial") return "adversarial" in over ? over.adversarial : critic("adversarial");
  };

  it("PASS only when every run exits 0 and no critic finds anything that matters", async () => {
    const { result } = await run("drive-gate", {}, gate());
    expect(result.verdict).toBe("PASS");
    expect(result.deploy).toMatch(/not performed/);
    expect(result.critics.map((c: any) => c.role)).toEqual(["validation", "security", "adversarial"]);
    expect(result.not_covered.join(" ")).toMatch(/Windows/);
  });

  it("FAIL when a run exits non-zero, whatever the critics say", async () => {
    const { result } = await run("drive-gate", {}, gate({ run: (l: string) => runOk(l, 1) }));
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons[0]).toMatch(/did not end with exit code 0/);
  });

  it("FAIL when the Testing agent's run changed tracked files", async () => {
    const { result } = await run("drive-gate", {}, gate({ run: (l: string) => ({ ...runOk(l), tracked_files_modified: true }) }));
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toMatch(/modified tracked files/);
  });

  it("FAIL when a critic says FAIL or reports a blocker, even with a PASS verdict next to it", async () => {
    expect((await run("drive-gate", {}, gate({ security: critic("security", "FAIL", [{ severity: "major", title: "t", evidence: "e", next_action: "n" }]) }))).result.verdict).toBe("FAIL");
    expect((await run("drive-gate", {}, gate({ adversarial: critic("adversarial", "PASS", [{ severity: "blocker", title: "gate stayed green", evidence: "e", next_action: "n" }]) }))).result.verdict).toBe("FAIL");
  });

  it("REVIEW_REQUIRED when a critic asks for a human, or reports a major finding, or gave no answer: never a quiet PASS", async () => {
    expect((await run("drive-gate", {}, gate({ validation: critic("validation", "REVIEW_REQUIRED") }))).result.verdict).toBe("REVIEW_REQUIRED");
    expect((await run("drive-gate", {}, gate({ validation: critic("validation", "PASS", [{ severity: "major", title: "t", evidence: "e", next_action: "n" }]) }))).result.verdict).toBe("REVIEW_REQUIRED");
    const silent = await run("drive-gate", {}, gate({ security: null }));
    expect(silent.result.verdict).toBe("REVIEW_REQUIRED");
    expect(silent.result.critics.find((c: any) => c.verdict === "NO ANSWER")).toBeTruthy();
  });

  it("FAIL when a Testing agent gave no answer at all (nothing was run that anybody saw), and it is not listed as evidence", async () => {
    const { result } = await run("drive-gate", {}, gate({ run: () => null }));
    expect(result.verdict).toBe("FAIL");
    expect(result.evidence).toEqual([]);
    const half = await run("drive-gate", { runs: [{ label: "a", path_prefix: "" }, { label: "b", path_prefix: "" }] }, gate({ run: (l: string) => (l === "a" ? runOk("a") : null) }));
    expect(half.result.verdict).toBe("FAIL");
    expect(half.result.evidence.map((e: any) => e.label)).toEqual(["a"]); // a runner that said nothing is not evidence
    expect(half.result.reasons.join(" ")).toContain("b (agent failed)");
  });

  it("turns a major or blocker finding into a next action for a human, and leaves minor ones out", async () => {
    const f = (severity: string, next_action: string) => ({ severity, title: severity, evidence: "e", next_action });
    const { result } = await run("drive-gate", {}, gate({ validation: critic("validation", "REVIEW_REQUIRED", [f("minor", "tidy a comment"), f("major", "read the gap in the report")]) }));
    expect(result.next_actions).toEqual(["validation: read the gap in the report"]);
    expect(result.findings).toHaveLength(2); // all of them are still reported
  });

  it("runs one Testing agent per run entry, in parallel, and gives every critic the evidence of all of them", async () => {
    const runs = [{ label: "node22", path_prefix: "/n22" }, { label: "node24", path_prefix: "/n24" }];
    const { calls, result } = await run("drive-gate", { runs, repo: "/r", evidence_dir: "/ev" }, gate());
    expect(calls.filter((c) => c.label.startsWith("run:")).map((c) => c.label).sort()).toEqual(["run:node22", "run:node24"]);
    const critics = calls.filter((c) => c.label.startsWith("critic:"));
    expect(critics).toHaveLength(3);
    for (const c of critics) { expect(c.prompt).toContain("/e/node22.json"); expect(c.prompt).toContain("/e/node24.json"); }
    expect(result.evidence).toHaveLength(2);
    expect(calls.find((c) => c.label === "run:node22")!.prompt).toContain("/n22");
  });

  it("keeps the runner and the critics apart: a critic is told not to trust a summary and is not given the runner's reading", async () => {
    const { calls } = await run("drive-gate", {}, gate());
    for (const c of calls.filter((x) => x.label.startsWith("critic:"))) {
      expect(c.prompt).toMatch(/did NOT produce this evidence/);
      expect(c.prompt).toMatch(/must not trust anyone's summary of it/);
      expect(c.prompt).not.toMatch(/the runner (says|found|reported)/i);
    }
    expect(calls.find((c) => c.label.startsWith("run:"))!.prompt).toMatch(/do not interpret/i);
  });

  it("tells every agent the rules: no commits, no pushes, nothing deployed, no secret values", async () => {
    const { calls } = await run("drive-gate", {}, gate());
    for (const c of calls) {
      expect(c.prompt).toMatch(/never modify tracked files/);
      expect(c.prompt).toMatch(/never run git commit, push, checkout, reset or stash/);
      expect(c.prompt).toMatch(/never print or invent a secret value/);
      expect(c.prompt).toMatch(/human's explicit approval/);
    }
  });

  it("bounds the number of breakages the adversarial tester is asked for", async () => {
    const asked = async (n: any) => (await run("drive-gate", { breakages: n }, gate())).calls.find((c) => c.label === "critic:adversarial")!.prompt;
    expect(await asked(undefined)).toContain("Make 3 different");
    expect(await asked(100)).toContain("Make 6 different");
    expect(await asked(0)).toContain("Make 3 different"); // 0 is "not given"
    expect(await asked(-4)).toContain("Make 1 different");
  });

  it("tells the adversarial tester that a breakage the gate does not notice is a blocker, and to break a copy, never the repository", async () => {
    const { calls } = await run("drive-gate", { repo: "/r" }, gate());
    const prompt = calls.find((c) => c.label === "critic:adversarial")!.prompt;
    expect(prompt).toContain("A breakage that leaves the gate green is a blocker finding");
    expect(prompt).toContain("Edit the copy of dist/ only");
    expect(prompt).toContain("Never touch /r");
  });
});

describe("engineer-loop: who may approve, when it stops", () => {
  const plan = { base_sha: "b".repeat(40), criteria: [{ id: "C1", statement: "s", how_to_check: "h" }, { id: "C2", statement: "s2", how_to_check: "h2" }], files_likely: ["a.js"], risks: [], out_of_scope: [] };
  const built = (n: number) => ({ commit: `c${n}`.padEnd(40, "0"), worktree: `/w/round-${n}`, summary: `round ${n}`, files: ["a.js"], deviations: [], not_done: [] });
  const tests = (passed: boolean, failures: string[] = []) => ({ commit: "c", passed, commands: [{ command: "npm test", exit_code: passed ? 0 : 1, summary: "s" }], failures, not_available: [] });
  const sec = (findings: any[] = []) => ({ role: "security", summary: "s", findings });
  const val = (met: string[] = ["yes", "yes"], findings: any[] = []) => ({ summary: "s", criteria: met.map((m, i) => ({ id: `C${i + 1}`, met: m, evidence: "e" })), findings });
  const finding = (key: string, severity = "major") => ({ key, severity, title: key, evidence: "e", fix: "f" });
  /** round -> what the three critics answer */
  // the handler has the shape of agent(): label, prompt, options; these two do not need the prompt or the options
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const loop = (rounds: Record<number, { test?: any; sec?: any; val?: any }>) => (label: string, _prompt?: string, _opts?: any): any => {
    if (label === "research") return { facts: [{ claim: "c", source: "s", verified: true }], unknowns: [] };
    if (label === "planning") return plan;
    const [role, n] = label.split(":");
    const r = rounds[Number(n)] || {};
    if (role === "engineer") return built(Number(n));
    if (role === "test") return "test" in r ? r.test : tests(true);
    if (role === "security") return "sec" in r ? r.sec : sec();
    if (role === "validate") return "val" in r ? r.val : val();
  };
  const start = (over: object = {}) => ({ task: "do the thing", run_id: "t-001", ...over });

  it("refuses to start without a task or with a run id that is not a safe name", async () => {
    await expect(run("engineer-loop", {}, loop({}))).rejects.toThrow(/args\.task is required/);
    await expect(run("engineer-loop", { task: "x" }, loop({}))).rejects.toThrow(/args\.run_id is required/);
    for (const bad of ["a b", "../x", "x/y", "ab", "x".repeat(41), "a;b"]) await expect(run("engineer-loop", { task: "x", run_id: bad }, loop({}))).rejects.toThrow(/args\.run_id/);
  });

  it("an empty or blank task is refused", async () => {
    for (const task of ["", "   ", "\n\t", 5, null]) await expect(run("engineer-loop", { task, run_id: "t-001" }, loop({}))).rejects.toThrow(/args\.task is required/);
  });

  it("approves in the first round when the tests pass, no critic has a blocking finding and every criterion is met", async () => {
    const { result, calls } = await run("engineer-loop", start(), loop({}));
    expect(result.status).toBe("APPROVED_FOR_HUMAN_REVIEW");
    expect(result.approved).toBe(true);
    expect(result.rounds_run).toBe(1);
    expect(calls.map((c) => c.label)).toEqual(["research", "planning", "engineer:1", "test:1", "security:1", "validate:1"]);
    expect(result.production).toMatch(/explicit human approval/);
    expect(result.how_to_take_it).toContain("nothing was pushed, merged or deployed");
    expect(result.local_branch).toBe("wf/engineer-loop/t-001");
  });

  it("a criterion that is not met, or not known to be, blocks approval on its own, and so does a major finding of the Validation agent", async () => {
    const one = async (r: object) => (await run("engineer-loop", start({ max_iterations: 1 }), loop({ 1: r }))).result;
    for (const met of ["no", "unknown"]) {
      const out = await one({ val: val(["yes", met]) });
      expect({ met, approved: out.approved, unmet: out.status }).toEqual({ met, approved: false, unmet: "NOT_APPROVED_MAX_ROUNDS" });
    }
    for (const severity of ["major", "blocker"]) expect((await one({ val: val(["yes", "yes"], [finding("v", severity)]) })).approved).toBe(false);
    expect((await one({ val: val(["yes", "yes"], [finding("v", "minor")]) })).approved).toBe(true);
    // and the finding goes back to the Engineering agent of the next round
    const { calls } = await run("engineer-loop", start({ max_iterations: 2 }), loop({ 1: { val: val(["yes", "yes"], [finding("from-validation")]) } }));
    expect(calls.find((c) => c.label === "engineer:2")!.prompt).toContain("from-validation");
  });

  it("does not approve on minor findings alone, but does not need them fixed either", async () => {
    const { result } = await run("engineer-loop", start(), loop({ 1: { sec: sec([finding("nit", "minor")]) } }));
    expect(result.status).toBe("APPROVED_FOR_HUMAN_REVIEW");
  });

  it("recycles with the findings when a test fails, a criterion is unmet or a critic reports a major finding, and approves when the next round is clean", async () => {
    const { result, calls } = await run("engineer-loop", start(), loop({ 1: { test: tests(false, ["npm test: 2 failed"]), val: val(["yes", "no"]), sec: sec([finding("secret-in-docs", "blocker")]) } }));
    expect(result.status).toBe("APPROVED_FOR_HUMAN_REVIEW");
    expect(result.rounds_run).toBe(2);
    const second = calls.find((c) => c.label === "engineer:2")!.prompt;
    expect(second).toContain("secret-in-docs");
    expect(second).toContain("npm test: 2 failed");
    expect(second).toContain('"criterion":"C2"');
    expect(second).toContain("c1".padEnd(40, "0")); // it starts from the previous round's commit
    expect(calls.find((c) => c.label === "engineer:1")!.prompt).toContain("This is the first round");
  });

  it("never lets the Engineering agent's own account decide: the critics are told not to trust it and are given the commit, not the summary", async () => {
    const { calls } = await run("engineer-loop", start(), loop({}));
    for (const c of calls.filter((x) => /^(test|security|validate):/.test(x.label))) {
      expect(c.prompt).toMatch(/did NOT write this change/);
      expect(c.prompt).toMatch(/must not trust the Engineering agent's account of it/);
      expect(c.prompt).toContain("c1".padEnd(40, "0"));
      expect(c.prompt).not.toContain("round 1"); // the engineer's summary
    }
  });

  it("stops after max_iterations rounds with NOT_APPROVED, and the limit is at most 7", async () => {
    const never = { 1: { test: tests(false, ["a"]) }, 2: { test: tests(false, ["b"]) }, 3: { test: tests(false, ["c"]) } };
    const out = await run("engineer-loop", start({ max_iterations: 3 }), loop(never));
    expect(out.result.status).toBe("NOT_APPROVED_MAX_ROUNDS");
    expect(out.result.approved).toBe(false);
    expect(out.result.rounds_run).toBe(3);
    const many: Record<number, any> = {};
    for (let i = 1; i <= 9; i++) many[i] = { test: tests(false, ["f" + i]) };
    const capped = await run("engineer-loop", start({ max_iterations: 99 }), loop(many));
    expect(capped.result.rounds_run).toBe(7);
    expect(capped.result.max_rounds).toBe(7);
    expect((await run("engineer-loop", start({ max_iterations: 0 }), loop(many))).result.rounds_run).toBe(1);
  });

  it("stops as STALLED when a round finds exactly what the round before it found: no better proven alternative is being reached", async () => {
    const same = { 1: { sec: sec([finding("x")]) }, 2: { sec: sec([finding("x")]) }, 3: { sec: sec([finding("y")]) } };
    const { result } = await run("engineer-loop", start({ max_iterations: 5 }), loop(same));
    expect(result.status).toBe("STALLED_SAME_FINDINGS_TWICE");
    expect(result.rounds_run).toBe(2);
  });

  it("does not approve when a critic gave no answer: a missing review is not a clean one", async () => {
    for (const missing of [{ test: null }, { sec: null }, { val: null }]) {
      const { result } = await run("engineer-loop", start({ max_iterations: 1 }), loop({ 1: missing }));
      expect({ missing, approved: result.approved }).toEqual({ missing, approved: false });
      expect(result.rounds_run).toBe(1);
    }
  });

  it("stops without a result when the Engineering agent gives nothing, and says so", async () => {
    const h = loop({});
    const { result } = await run("engineer-loop", start(), (label, p, o) => (label === "engineer:1" ? null : h(label, p, o)));
    expect(result.status).toBe("STOPPED_NO_ENGINEERING_RESULT");
    expect(result.approved).toBe(false);
  });

  it("does not run the critics of a round before the Engineering agent of that round has finished, and runs the three critics together", async () => {
    const order: string[] = [];
    const h = loop({});
    await run("engineer-loop", start(), (label, p, o) => { order.push(label); return h(label, p, o); });
    expect(order.indexOf("engineer:1")).toBeLessThan(order.indexOf("test:1"));
    expect(order.slice(order.indexOf("engineer:1") + 1)).toEqual(["test:1", "security:1", "validate:1"]);
  });

  it("can skip Research, and puts the sprint's scope into the rules when one is given", async () => {
    const { calls } = await run("engineer-loop", start({ research: false, sprint: 1 }), loop({}));
    expect(calls.map((c) => c.label)).not.toContain("research");
    expect(calls[0].prompt).toContain("Sprint 1, Critical fixes");
    expect((await run("engineer-loop", start(), loop({}))).calls[0].prompt).not.toContain("Scope of this run");
    for (const sprint of [-1, 6, 50, 1.5, "1"]) expect((await run("engineer-loop", start({ sprint }), loop({}))).calls[0].prompt).not.toContain("Scope of this run");
    for (const sprint of [0, 5]) expect((await run("engineer-loop", start({ sprint }), loop({}))).calls[0].prompt).toContain("Scope of this run: Sprint " + sprint);
  });

  it("tells every agent the rules: evidence over assumption, no push, no deployment, no new major dependency, no secrets", async () => {
    const { calls } = await run("engineer-loop", start(), loop({}));
    for (const c of calls) {
      expect(c.prompt).toMatch(/NOT VERIFIED/);
      expect(c.prompt).toMatch(/never push/);
      expect(c.prompt).toMatch(/never print or write a secret value/);
      expect(c.prompt).toMatch(/new major dependency/);
    }
  });

  it("gives the Testing agent the commands to run, and the default ones include the drivers", async () => {
    const { calls } = await run("engineer-loop", start(), loop({}));
    const defaults = calls.find((c) => c.label === "test:1")!.prompt;
    for (const command of ["npm run type-check", "npm run lint", "npm test", "npm run build", "node scripts/drive-all.js"]) expect(defaults).toContain(JSON.stringify(command)); // as an item of the list, not in a sentence about it
    const custom = await run("engineer-loop", start({ verify: ["make check"] }), loop({}));
    const prompt = custom.calls.find((c) => c.label === "test:1")!.prompt;
    expect(prompt).toContain("make check");
    expect(prompt).not.toContain('"npm test"');
  });
});
