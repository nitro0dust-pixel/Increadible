import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * scripts/drive-all.js (docs/DRIVERS-WORKFLOW.md): every driver against every shipped scenario, side by side, one table and one verdict.
 * The pure parts are tested in this process; the whole is run as a user runs it, against the server compiled from these sources, and
 * against a server that has been broken on purpose: a runner that cannot fail proves nothing.
 */
const all = require("../scripts/drive-all.js");
const lib = require("../scripts/drive-lib.js");

const root = path.join(__dirname, "..");

describe("planning the jobs", () => {
  it("is every shipped scenario for stdio, http and bundle, and the probe once", () => {
    const jobs = all.planJobs({});
    const scenarios = lib.listScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
    expect(jobs.map((j: any) => j.id).sort()).toEqual(
      [...["stdio", "http", "bundle"].flatMap((d) => scenarios.map((s: string) => `${d}:${s}`)), "probe"].sort()
    );
    expect(jobs.find((j: any) => j.id === "probe")).toMatchObject({ driver: "probe", scenario: null });
  });

  it("asks every driver for a JSON report, and passes the scenario on", () => {
    for (const job of all.planJobs({})) expect(job.args).toContain("--json");
    expect(all.planJobs({ only: ["stdio"], scenarios: ["gateway"] })).toEqual([{ id: "stdio:gateway", driver: "stdio", scenario: "gateway", args: ["--scenario", "gateway", "--json"] }]);
  });

  it("limits the drivers with only and the scenarios with scenarios, and keeps the order of the drivers", () => {
    expect(all.planJobs({ only: ["bundle", "stdio"], scenarios: ["basic", "gateway"] }).map((j: any) => j.id)).toEqual(["stdio:basic", "stdio:gateway", "bundle:basic", "bundle:gateway"]);
    expect(all.planJobs({ only: ["probe"] }).map((j: any) => j.id)).toEqual(["probe"]);
    expect(all.planJobs({ only: [] })).toEqual([]);
  });

  it("gives --root to the drivers that start a server from a checkout, and --bundle only to the bundle driver", () => {
    const jobs = all.planJobs({ scenarios: ["basic"], root: "/r", bundle: "/b.mcpb" });
    const args = (id: string) => jobs.find((j: any) => j.id === id).args;
    for (const id of ["stdio:basic", "http:basic", "probe"]) expect(args(id)).toEqual(expect.arrayContaining(["--root", "/r"]));
    expect(args("bundle:basic")).not.toContain("--root");
    expect(args("bundle:basic")).toEqual(expect.arrayContaining(["--bundle", "/b.mcpb"]));
    for (const id of ["stdio:basic", "http:basic", "probe"]) expect(args(id)).not.toContain("--bundle");
  });

  it("refuses a scenario that is not shipped", () => {
    expect(() => all.planJobs({ scenarios: ["nope"] })).toThrow(/--scenario: "nope" is not a shipped scenario/);
  });
});

describe("the expected step counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-all-expected-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, content: unknown) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content)); return f; };

  it("reads { jobs: { id: count } }, and nothing at all for no file", () => {
    expect(all.loadExpected(write("ok.json", { description: "x", jobs: { "stdio:basic": 19 } }))).toEqual({ "stdio:basic": 19 });
    expect(all.loadExpected(null)).toEqual({});
  });

  it("refuses a file that is missing, not JSON, not shaped so, or with a count that is not a whole number of 1 or more", () => {
    expect(() => all.loadExpected(path.join(dir, "missing.json"))).toThrow(/no such file/);
    expect(() => all.loadExpected(write("bad.json", "{nope"))).toThrow();
    expect(() => all.loadExpected(write("shape.json", { stdio: 1 }))).toThrow(/expected \{ "jobs"/);
    expect(() => all.loadExpected(write("arr.json", []))).toThrow(/expected \{ "jobs"/);
    for (const bad of [0, -1, 1.5, "19", null]) expect(() => all.loadExpected(write("count.json", { jobs: { a: bad } }))).toThrow(/must be a whole number of steps/);
  });

  it("covers exactly the jobs of the default plan, with the counts the shipped scenarios give", () => {
    const shipped = all.loadExpected(path.join(root, "scripts", "drive-expected.json"));
    expect(Object.keys(shipped).sort()).toEqual(all.planJobs({}).map((j: any) => j.id).sort());
    // the scenario's own steps plus what the driver adds to every scenario: stdio 3 (handshake, shutdown, stdout), http 6, bundle 6
    const added: Record<string, number> = { stdio: 3, http: 6, bundle: 6 };
    for (const scenario of lib.listScenarios()) {
      const own = lib.loadScenario(scenario).steps.length;
      for (const driver of Object.keys(added)) expect({ id: `${driver}:${scenario}`, steps: shipped[`${driver}:${scenario}`] }).toEqual({ id: `${driver}:${scenario}`, steps: own + added[driver] });
    }
    expect(shipped.probe).toBe(27);
  });
});

describe("judging one finished driver", () => {
  const job = { id: "stdio:basic", driver: "stdio", scenario: "basic", args: [] };
  const report = (steps: Array<{ name: string; ok: boolean; problems?: string[]; summary?: string }>, extra: object = {}) => JSON.stringify({ driver: "stdio", ok: steps.every((s) => s.ok), results: [{ scenario: "basic", ok: steps.every((s) => s.ok), steps }], ...extra });
  const done = (stdout: string, code: number | null = 0, extra: object = {}) => ({ stdout, stderr: "", code, ms: 5, ...extra });
  const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, ok: true }));

  it("PASS when the driver exited 0, reported every step ok, and the count is the expected one", () => {
    expect(all.judge(job, done(report(steps(3))), { "stdio:basic": 3 })).toMatchObject({ status: "PASS", steps: 3, passed: 3, failing: [], note: "" });
  });

  it("PASS with a note when no count is expected for the job", () => {
    expect(all.judge(job, done(report(steps(3))), {})).toMatchObject({ status: "PASS", note: "no expected count" });
  });

  it("FAIL when a step failed: which one, and why", () => {
    const out = all.judge(job, done(report([{ name: "a", ok: true }, { name: "b", ok: false, problems: ["json.x: expected 1, got 2"] }]), 1), {});
    expect(out).toMatchObject({ status: "FAIL", steps: 2, passed: 1, failing: ["b"] });
    expect(out.problems).toEqual(["b: json.x: expected 1, got 2"]);
  });

  it("FAIL when the number of steps is not the expected one, even though every step passed", () => {
    const fewer = all.judge(job, done(report(steps(18))), { "stdio:basic": 19 });
    expect(fewer).toMatchObject({ status: "FAIL", note: "step count differs" });
    expect(fewer.problems[0]).toBe("expected 19 steps (scripts/drive-expected.json), got 18");
    expect(all.judge(job, done(report(steps(20))), { "stdio:basic": 19 }).status).toBe("FAIL");
  });

  it("FAIL when the exit code is not 0 but no step failed, or the report itself says not ok", () => {
    expect(all.judge(job, done(report(steps(2)), 1), {})).toMatchObject({ status: "FAIL", note: "exit code 1 with no failing step" });
    expect(all.judge(job, done(report(steps(2), { ok: false })), {}).status).toBe("FAIL");
  });

  it("CANNOT RUN when the driver exited 2, or printed no report, with the first line of what it said", () => {
    expect(all.judge(job, { ...done(report(steps(1)), 2) }, {}).status).toBe("CANNOT RUN");
    const none = all.judge(job, { ...done("", 2), stderr: "drive-stdio: dist/src/main.js does not exist: run \"npm run build\"\nusage: ..." }, {});
    expect(none).toMatchObject({ status: "CANNOT RUN", steps: 0 });
    expect(none.note).toBe('drive-stdio: dist/src/main.js does not exist: run "npm run build"');
    expect(all.judge(job, done("not json", 0), {}).status).toBe("CANNOT RUN");
    expect(all.judge(job, done(JSON.stringify({ results: [] }), 0), {}).status).toBe("CANNOT RUN");
  });

  it("TIMEOUT when the deadline passed, whatever was printed", () => {
    expect(all.judge(job, { ...done("", null), timedOut: true, timeoutS: 30 }, {})).toMatchObject({ status: "TIMEOUT", note: "no verdict within 30 s" });
  });

  it("counts every result of a report, not only the first, and a report of no step is not a pass", () => {
    const job = { id: "stdio:basic", driver: "stdio", scenario: "basic", args: [] };
    const report = (results: any[], over: object = {}) => ({ code: 0, ms: 1, timeoutS: 1, stderr: "", stdout: JSON.stringify({ ok: true, results, ...over }) });
    const step = (name: string, ok: boolean) => ({ name, ok, problems: ok ? [] : ["no"] });
    const second = all.judge(job, report([{ steps: [step("a", true)] }, { steps: [step("b", false)] }]), {});
    expect({ status: second.status, failing: second.failing }).toEqual({ status: "FAIL", failing: ["b"] });
    expect(all.judge(job, report([{ steps: [step("a", true)] }, { steps: [step("b", true)] }]), { "stdio:basic": 2 }).status).toBe("PASS");
    for (const results of [[{ steps: [] }], [], [{ steps: [step("a", true)] }, { nothing: 1 }], [null]]) {
      const out = all.judge(job, report(results), {});
      expect({ results, status: out.status === "PASS" }).toEqual({ results, status: false });
    }
    expect(all.judge(job, report([{ steps: [] }]), {}).note).toMatch(/holds no step/);
  });

  it("says what a driver printed when it is not a report (a banner before the JSON, a cut-off report) next to the first line of its stderr", () => {
    const job = { id: "probe", driver: "probe", scenario: null, args: [] };
    const out = all.judge(job, { code: 0, ms: 1, timeoutS: 1, stderr: "", stdout: "\n> increadible@1.0.5 drive:probe\n{ \"ok\": tr" }, {});
    expect(out.status).toBe("CANNOT RUN");
    expect(out.note).toContain('stdout is not a report: "> increadible@1.0.5 drive:probe');
    expect(all.judge(job, { code: 3, ms: 1, timeoutS: 1, stderr: "boom\nmore", stdout: "" }, {}).note).toBe("boom");
    expect(all.judge(job, { code: 3, ms: 1, timeoutS: 1, stderr: "", stdout: "" }, {}).note).toBe("exit code 3");
  });

  it("cuts control characters out of what it quotes from a driver's stderr", () => {
    const out = all.judge(job, { ...done("", 2), stderr: "boom \u001b[31mred\u001b[0m\n" }, {});
    expect(out.note).toBe("boom ?[31mred?[0m");
  });
});

describe("the verdict", () => {
  const r = (status: string) => ({ status });
  it("no job at all is not a pass: nothing was checked (exit 2)", () => {
    expect(all.verdictOf([], [])).toEqual({ code: 2, verdict: "CANNOT RUN" });
    expect(all.verdictOf([], ["increadible-drive-x"]).code).not.toBe(0);
  });

  it("passes only when every job passed and nothing was left behind", () => {
    expect(all.verdictOf([r("PASS"), r("PASS")], [])).toEqual({ code: 0, verdict: "PASS" });
    expect(all.verdictOf([r("PASS")], ["increadible-drive-x"])).toEqual({ code: 1, verdict: "FAIL" });
  });
  it("fails when a check failed or a job timed out, even if other jobs could not run", () => {
    expect(all.verdictOf([r("PASS"), r("FAIL")])).toEqual({ code: 1, verdict: "FAIL" });
    expect(all.verdictOf([r("TIMEOUT"), r("PASS")])).toEqual({ code: 1, verdict: "FAIL" });
    expect(all.verdictOf([r("FAIL"), r("CANNOT RUN")])).toEqual({ code: 1, verdict: "FAIL" });
  });
  it("is 'could not run' (2) only when no job could be judged, and a failure (1) when some could not and the rest passed", () => {
    expect(all.verdictOf([r("CANNOT RUN"), r("CANNOT RUN")])).toEqual({ code: 2, verdict: "CANNOT RUN" });
    expect(all.verdictOf([r("PASS"), r("CANNOT RUN")])).toEqual({ code: 1, verdict: "FAIL" });
  });
});

describe("running the jobs", () => {
  const jobs = Array.from({ length: 9 }, (_, i) => ({ id: `j${i}`, driver: "stdio", scenario: `s${i}`, args: [] }));
  const pass = JSON.stringify({ ok: true, results: [{ steps: [{ name: "a", ok: true }] }] });

  it("never has more jobs in flight than the concurrency, uses all of it, and keeps the order of the jobs", async () => {
    let inFlight = 0, peak = 0;
    const run = async (job: any) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 15 + (job.id === "j0" ? 40 : 0))); inFlight--; return { stdout: pass, stderr: "", code: 0, ms: 1 }; };
    const results = await all.runAll(jobs, { concurrency: 3, timeoutS: 5, expected: {}, run });
    expect(peak).toBe(3);
    expect(results.map((x: any) => x.id)).toEqual(jobs.map((j) => j.id));
    expect(results.every((x: any) => x.status === "PASS")).toBe(true);
  });

  it("runs one at a time with a concurrency of 1", async () => {
    let inFlight = 0, peak = 0;
    const run = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { stdout: pass, stderr: "", code: 0, ms: 1 }; };
    await all.runAll(jobs.slice(0, 4), { concurrency: 1, timeoutS: 5, expected: {}, run });
    expect(peak).toBe(1);
  });

  it("judges each job on its own: one failure does not hide the others", async () => {
    const run = async (job: any) => ({ stdout: job.id === "j2" ? JSON.stringify({ ok: false, results: [{ steps: [{ name: "x", ok: false, problems: ["no"] }] }] }) : pass, stderr: "", code: job.id === "j2" ? 1 : 0, ms: 1 });
    const results = await all.runAll(jobs.slice(0, 4), { concurrency: 2, timeoutS: 5, expected: {}, run });
    expect(results.map((x: any) => x.status)).toEqual(["PASS", "PASS", "FAIL", "PASS"]);
  });

  it("runs a real driver process, which refuses when there is no build where it was told to look", async () => {
    const started = Date.now();
    const finished = await all.runAll([{ id: "probe", driver: "probe", scenario: null, args: ["--root", "/nonexistent"] }], { concurrency: 1, timeoutS: 60, expected: {} });
    expect(finished[0].status).toBe("CANNOT RUN"); // the driver refused: no build there
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("the process of one driver", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-all-stub-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  // a stand-in for node: runProcess starts "<node> scripts/drive-<driver>.js <args>", and this ignores the arguments
  const stub = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    return file;
  };
  const job = { id: "probe", driver: "probe", scenario: null, args: [] };

  it("gets the variables a driver needs and none of the shell's others: no token, no live APIs", async () => {
    process.env.AUTH_TOKEN = "a-secret-value-for-this-test";
    process.env.GATEWAY_LIVE_APIS = "*";
    try {
      const finished = await all.runProcess(job, { timeoutS: 30, node: stub("env.sh", "env") });
      expect(finished.code).toBe(0);
      expect(finished.stdout).toMatch(/^PATH=/m);
      expect(finished.stdout).not.toMatch(/AUTH_TOKEN|GATEWAY_LIVE_APIS|a-secret-value-for-this-test/);
    } finally {
      delete process.env.AUTH_TOKEN;
      delete process.env.GATEWAY_LIVE_APIS;
    }
  });

  it("stops one that runs past its deadline, and one that ignores SIGTERM too (SIGKILL after 5 s)", async () => {
    const quick = await all.runProcess(job, { timeoutS: 1, node: stub("slow.sh", "i=0; while [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done") });
    expect(quick.timedOut).toBe(true);
    const started = Date.now();
    const stubborn = await all.runProcess(job, { timeoutS: 1, node: stub("stubborn.sh", 'trap "" TERM\ni=0; while [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done') });
    expect(stubborn.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(12_000); // 1 s + 5 s, not the 20 s the process would have taken on its own
  }, 60_000);

  it("ends a driver that ignores SIGTERM together with everything it started: a process group per driver (a stand-in for node that starts a sleeper and ignores the signal)", async () => {
    const pidFile = path.join(dir, "sleeper.pid");
    const stubborn = stub("group.sh", `trap "" TERM\nsleep 30 &\necho $! > ${pidFile}\nwait`);
    const started = Date.now();
    const finished = await all.runProcess(job, { timeoutS: 1, node: stubborn });
    expect(finished.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(12_000);
    const sleeper = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) { try { process.kill(sleeper, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; } }
    expect(alive).toBe(false); // killed with its parent: it would otherwise have run for 30 s
  }, 60_000);

  it("keeps what the driver wrote, and the last of its stderr", async () => {
    const finished = await all.runProcess(job, { timeoutS: 30, node: stub("talk.sh", 'echo out; echo err >&2; exit 3') });
    expect(finished).toMatchObject({ code: 3, timedOut: false });
    expect(finished.stdout).toBe("out\n");
    expect(finished.stderr).toBe("err\n");
  });
});

describe("the table", () => {
  const rows = [
    { id: "stdio:basic", status: "PASS", steps: 19, passed: 19, ms: 120, note: "", problems: [] },
    { id: "http:basic", status: "FAIL", steps: 22, passed: 21, ms: 300, note: "", problems: ["auth: expected 401, got 200"] },
    { id: "bundle:basic", status: "CANNOT RUN", steps: 0, passed: 0, ms: 4, note: "no package", problems: [] },
  ];
  it("has a line per job with the result, the passed and total steps and the time, then the problems, then the verdict", () => {
    const text = all.formatTable(rows, [], { verdict: "FAIL" });
    expect(text).toMatch(/^job\s+result\s+steps\s+time\s+note$/m);
    expect(text).toMatch(/^stdio:basic\s+PASS\s+19\/19\s+120 ms$/m);
    expect(text).toMatch(/^http:basic\s+FAIL\s+21\/22\s+300 ms$/m);
    expect(text).toMatch(/^bundle:basic\s+CANNOT RUN\s+-\s+4 ms\s+no package$/m);
    expect(text).toContain("  http:basic: auth: expected 401, got 200");
    expect(text.trimEnd().split("\n").pop()).toBe("FAIL: 1 of 3 jobs passed");
  });
  it("names what was left behind", () => {
    expect(all.formatTable(rows.slice(0, 1), ["increadible-drive-abc"], { verdict: "FAIL" })).toContain("left behind by a driver (removed afterwards): increadible-drive-abc");
  });
  it("shows at most five problems of a job", () => {
    const many = { ...rows[1], problems: Array.from({ length: 9 }, (_, i) => `p${i}`) };
    const lines = all.formatTable([many], [], { verdict: "FAIL" }).split("\n").filter((l: string) => l.startsWith("  http:basic: "));
    expect(lines).toHaveLength(5);
  });
  it("scrubs control characters", () => {
    const text = all.formatTable([{ ...rows[1], problems: ["\u001b[2Jwipe"] }], [], { verdict: "FAIL" });
    expect(text).not.toContain("\u001b");
  });
});

describe("the work directories of the drivers", () => {
  it("lists those in a folder that carry the drivers' prefix, and no others", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-all-pending-"));
    try {
      fs.mkdirSync(path.join(dir, `${lib.WORKDIR_PREFIX}abc`));
      fs.mkdirSync(path.join(dir, "something-else"));
      expect(all.pendingDirs(dir)).toEqual([`${lib.WORKDIR_PREFIX}abc`]);
      expect(all.pendingDirs(path.join(dir, "missing"))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------- the whole, as a user runs it

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-driveall-test-"));
const server = path.join(tmp, "server");

beforeAll(() => {
  fs.mkdirSync(server);
  fs.symlinkSync(path.join(root, "node_modules"), path.join(server, "node_modules"), "dir");
  fs.copyFileSync(path.join(root, "package.json"), path.join(server, "package.json"));
  const tsc = cp.spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(server, "dist")], { cwd: root, encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`the build for the drive-all tests failed:\n${tsc.stdout}${tsc.stderr}`);
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Ran { status: number | null; stdout: string; stderr: string; json: any }
function runAll(args: string[], env: Record<string, string> = {}): Ran {
  const r = cp.spawnSync(process.execPath, [path.join(root, "scripts", "drive-all.js"), ...args], { encoding: "utf8", timeout: 170_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  let json: any;
  try { json = JSON.parse(r.stdout); } catch { /* not a --json run */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const privateTmp = () => fs.mkdtempSync(path.join(tmp, "private-tmp-"));

function broken<T>(file: string, from: string, to: string, fn: () => T): T {
  const target = path.join(server, "dist", ...file.split("/"));
  const original = fs.readFileSync(target, "utf8");
  expect({ file, occurrences: original.split(from).length - 1 }).toEqual({ file, occurrences: 1 });
  fs.writeFileSync(target, original.replace(from, () => to));
  try { return fn(); } finally { fs.writeFileSync(target, original); }
}

describe("drive-all as a process", () => {
  it("runs stdio, http and the probe against the server, in parallel, and passes with the shipped expected counts", () => {
    const ran = runAll(["--only", "stdio,http,probe", "--scenario", "basic,gateway", "--root", server, "--json"]);
    expect({ status: ran.status, verdict: ran.json && ran.json.verdict }).toEqual({ status: 0, verdict: "PASS" });
    expect(ran.json.jobs.map((j: any) => j.id).sort()).toEqual(["http:basic", "http:gateway", "probe", "stdio:basic", "stdio:gateway"]);
    expect(ran.json.jobs.every((j: any) => j.status === "PASS" && j.note === "")).toBe(true);
    expect(ran.json.leftBehind).toEqual([]);
  });

  it("prints the table and exits 0 without --json", () => {
    const ran = runAll(["--only", "stdio", "--scenario", "basic", "--root", server]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toMatch(/^stdio:basic\s+PASS\s+19\/19/m);
    expect(ran.stdout.trimEnd().split("\n").pop()).toBe("PASS: 1 of 1 jobs passed");
  });

  it("fails, and names the job, when the server is wrong in a way only one driver looks at", () => {
    const ran = broken("src/index.js", 'json(401, { error: "Unauthorized" })', 'json(200, { error: "Unauthorized" })', () => runAll(["--only", "stdio,http", "--scenario", "basic", "--root", server, "--json"]));
    expect(ran.status).toBe(1);
    const byId = Object.fromEntries(ran.json.jobs.map((j: any) => [j.id, j]));
    expect(byId["stdio:basic"].status).toBe("PASS");
    expect(byId["http:basic"].status).toBe("FAIL");
    expect(byId["http:basic"].failing).toEqual(["auth: a request without the token is refused"]);
  });

  it("fails a job that passes with a different number of steps than the file expects", () => {
    const wrong = path.join(tmp, "wrong-expected.json");
    fs.writeFileSync(wrong, JSON.stringify({ jobs: { "stdio:basic": 20 } }));
    const ran = runAll(["--only", "stdio", "--scenario", "basic", "--root", server, "--expect", wrong, "--json"]);
    expect(ran.status).toBe(1);
    expect(ran.json.jobs[0]).toMatchObject({ status: "FAIL", note: "step count differs" });
    expect(ran.json.jobs[0].problems[0]).toContain("expected 20 steps");
    expect(runAll(["--only", "stdio", "--scenario", "basic", "--root", server, "--no-expect"]).status).toBe(0);
  });

  it("fails when a driver leaves its work directory behind", () => {
    // a stand-in server that answers everything and keeps a directory with the drivers' prefix in the temporary folder
    const fake = path.join(tmp, "leaky");
    fs.mkdirSync(path.join(fake, "dist", "src"), { recursive: true });
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(fake, "dist", "src", "main.js"), `
      const fs = require("fs"); const os = require("os"); const path = require("path");
      fs.mkdirSync(path.join(process.env.TMPDIR || os.tmpdir(), "increadible-drive-left-" + process.pid));
      process.stdin.setEncoding("utf8"); let buf = "";
      process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) continue;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "x", capabilities: {}, serverInfo: { name: "increadible", version: "1.2.3" } } : {} }) + "\\n"); } });
      process.stdin.on("end", () => process.exit(0));`);
    const dir = privateTmp();
    const ran = runAll(["--only", "stdio", "--scenario", "basic", "--root", fake, "--no-expect", "--json"], { TMPDIR: dir });
    expect(ran.status).toBe(1);
    expect(ran.json.leftBehind).toHaveLength(1);
    expect(ran.json.leftBehind[0]).toMatch(/^increadible-drive-left-\d+$/);
    expect(ran.json.verdict).toBe("FAIL");
    expect(fs.readdirSync(dir)).toEqual([]); // what it left was in a folder of this run's own, which is removed afterwards
  });

  /** A stand-in server (see the test above) that answers everything, and runs `extra` first. */
  const fakeServer = (name: string, extra: string) => {
    const fake = path.join(tmp, name);
    fs.mkdirSync(path.join(fake, "dist", "src"), { recursive: true });
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(fake, "dist", "src", "main.js"), `
      const fs = require("fs"); const os = require("os"); const path = require("path");
      ${extra}
      process.stdin.setEncoding("utf8"); let buf = "";
      process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) continue;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "x", capabilities: {}, serverInfo: { name: "increadible", version: "1.2.3" } } : {} }) + "\\n"); } });
      process.stdin.on("end", () => process.exit(0));`);
    return fake;
  };

  it("does not blame itself for the work directories of another run in the same temporary folder (found by two reviewers: two runs at once failed each other)", () => {
    // the stand-in server makes a directory with the drivers' prefix in the folder ABOVE its own temporary folder: where a second run, a manual driver or a test would make theirs
    const fake = fakeServer("neighbour", `fs.mkdirSync(path.join(path.dirname(process.env.TMPDIR), "increadible-drive-neighbour-" + process.pid));`);
    const dir = privateTmp();
    const ran = runAll(["--only", "stdio", "--scenario", "basic", "--root", fake, "--no-expect", "--json"], { TMPDIR: dir });
    // (the stand-in is too bare to pass the scenario, so the verdict is a FAIL of the job; what is asserted is what was blamed on the run)
    expect(ran.json.leftBehind).toEqual([]);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("increadible-drive-neighbour-"))).toHaveLength(1); // it was made, and left alone
  });

  it("gives the drivers a temporary folder of this run's own, and removes it", () => {
    const fake = fakeServer("where", `fs.writeFileSync(path.join(path.dirname(__dirname), "..", "tmpdir-seen.txt"), String(process.env.TMPDIR));`);
    const dir = privateTmp();
    runAll(["--only", "stdio", "--scenario", "basic", "--root", fake, "--no-expect", "--json"], { TMPDIR: dir });
    const seen = fs.readFileSync(path.join(fake, "tmpdir-seen.txt"), "utf8");
    expect(path.dirname(seen)).toBe(dir); // a folder inside the one drive-all was given...
    expect(path.basename(seen)).toMatch(/^increadible-drive-/);
    expect(fs.existsSync(seen)).toBe(false); // ...and gone afterwards
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("ends the drivers and their servers when it is interrupted, and removes its folder (SIGTERM: exit 143)", async () => {
    // the stand-in server records its process id and never answers: the stdio driver waits for it
    const fake = fakeServer("hang", `fs.writeFileSync(path.join(__dirname, "..", "..", "pid.txt"), String(process.pid)); setInterval(() => {}, 1000); process.stdin.on = () => process.stdin;`);
    // (the line above stops the stand-in from answering: it replaces the listener registration after its own was not yet made)
    const dir = privateTmp();
    const child = cp.spawn(process.execPath, [path.join(root, "scripts", "drive-all.js"), "--only", "stdio", "--scenario", "basic", "--root", fake, "--no-expect", "--timeout-s", "60"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: dir }, stdio: "ignore" });
    const pidFile = path.join(fake, "pid.txt");
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(pidFile)).toBe(true);
    const serverPid = Number(fs.readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    const code: number | null = await new Promise((resolve) => { child.on("close", (c) => resolve(c)); setTimeout(() => resolve(-1), 20_000).unref(); });
    expect(code).toBe(143);
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) { try { process.kill(serverPid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; } }
    expect(alive).toBe(false); // the server the driver had started is gone
    expect(fs.readdirSync(dir)).toEqual([]);
  }, 60_000);

  it("the longest deadline is a day: more would overflow the timer and end every job at once", () => {
    for (const bad of ["86401", "2200000", "0"]) expect({ bad, status: runAll(["--list", "--timeout-s", bad]).status }).toEqual({ bad, status: 2 });
    expect(runAll(["--list", "--timeout-s", "86400"]).status).toBe(0);
  });

  it("asks for the build each driver needs and no more: stdio main.js, http index.js, the probe both, the package none", () => {
    const only = (entry: string) => { // a root that has just one of the two entry points
      const root2 = path.join(tmp, "only-" + entry.replace(".", "-"));
      fs.mkdirSync(path.join(root2, "dist", "src"), { recursive: true });
      fs.writeFileSync(path.join(root2, "package.json"), JSON.stringify({ version: "1.2.3" }));
      fs.writeFileSync(path.join(root2, "dist", "src", entry), "");
      return root2;
    };
    const mainOnly = only("main.js");
    const indexOnly = only("index.js");
    for (const [driver, root2, missing] of [["http", mainOnly, "index.js"], ["stdio", indexOnly, "main.js"], ["probe", mainOnly, "index.js"], ["probe", indexOnly, "main.js"]] as const) {
      const ran = runAll(["--only", driver, "--root", root2]);
      expect({ driver, status: ran.status }).toEqual({ driver, status: 2 });
      expect(ran.stderr).toContain(missing);
    }
    // each driver is satisfied by its own entry point: it gets as far as starting, then fails on the empty stand-in, which is exit 1, not 2
    expect(runAll(["--only", "stdio", "--scenario", "basic", "--root", mainOnly, "--no-expect"]).status).toBe(1);
    expect(runAll(["--only", "http", "--scenario", "basic", "--root", indexOnly, "--no-expect"]).status).toBe(1);
  });

  it("could not run (2) when there is no build, naming the command to run", () => {
    const empty = path.join(tmp, "no-build");
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const ran = runAll(["--only", "stdio", "--root", empty]);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain('run "npm run build"');
  });

  it("could not run (2) when the bundle jobs are asked for and the package is missing", () => {
    const ran = runAll(["--only", "bundle", "--bundle", path.join(tmp, "nope.mcpb")]);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("nope.mcpb does not exist");
  });

  it("refuses bad options with exit 2: unknown driver, unknown scenario, concurrency 0, expect and no-expect together, a stray argument", () => {
    for (const args of [["--only", "ftp"], ["--only", ","], ["--scenario", " , "], ["--scenario", "nope"], ["--concurrency", "0"], ["--timeout-s", "abc"], ["--expect", "a", "--no-expect"], ["extra"], ["--nope"]]) {
      const ran = runAll(args);
      expect({ args, status: ran.status }).toEqual({ args, status: 2 });
    }
  });

  it("names each driver and scenario once, however often it is given", () => {
    const ran = runAll(["--list", "--only", "stdio,stdio,probe", "--scenario", "basic,basic"]);
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim().split("\n")).toEqual(["stdio:basic", "probe"]);
  });

  it("lists the jobs without running anything", () => {
    const ran = runAll(["--list", "--only", "stdio,probe", "--scenario", "basic"]);
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim().split("\n")).toEqual(["stdio:basic", "probe"]);
  });
});
