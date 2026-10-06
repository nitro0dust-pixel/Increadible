import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RoutingPluginsMCP, RoutingRule } from "../features/07-routing-plugins/src/mcp-server";
import { ABTestingFramework, Experiment } from "../features/08-ab-testing/src/mcp-server";
import { UniversalAPIGateway } from "../features/09-api-gateway/src/mcp-server";

/**
 * Integration tests for the Increadible components implemented in this repo
 * (Features #7 Routing Plugins, #8 A/B Testing, #9 API Gateway).
 *
 * These exercise the real classes. Features #1-#6 are external projects
 * (git submodules) and are not testable in-process here; see the todo list.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-e2e-"));
const tmpFile = (name: string) => path.join(tmpDir, name);

// Deterministic PRNG so statistical tests never flake.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalSampler(mean: number, sd: number, seed: number) {
  const rand = mulberry32(seed);
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function makeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: "exp-1",
    name: "Sonnet vs Haiku",
    hypothesis: "Haiku is as good for low-complexity tasks",
    status: "running",
    variants: [
      { id: "A", name: "control", config: {} },
      { id: "B", name: "treatment", config: {} },
    ],
    traffic_split: 0.5,
    metrics: [{ id: "quality", name: "Quality", type: "continuous", aggregation: "mean" }],
    ...overrides,
  };
}

function recordSamples(
  ab: ABTestingFramework,
  expId: string,
  variantId: string,
  n: number,
  sample: () => number
) {
  for (let i = 0; i < n; i++) ab.recordMetric(expId, variantId, { quality: sample() });
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Feature #7: Routing Plugins", () => {
  let router: RoutingPluginsMCP;

  beforeAll(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterAll(() => { jest.restoreAllMocks(); });

  // A nonexistent rules file triggers the built-in default rules.
  const fresh = (name = "missing-rules.yaml") => new RoutingPluginsMCP(tmpFile(name));

  it("routes low-complexity QA to Haiku", () => {
    router = fresh();
    const r = router.applyRoutingRules({ task_type: "qa", task_complexity: "low" });
    expect(r).toMatchObject({ provider: "claude-haiku", rule_id: "simple-tasks" });
    expect(r.fallback).toEqual(["claude-sonnet"]);
  });

  it("routes critical security work to Opus", () => {
    router = fresh();
    const r = router.applyRoutingRules({ task_type: "security", priority: "critical" });
    expect(r).toMatchObject({ provider: "claude-opus", rule_id: "critical-tasks" });
  });

  it("orders the built-in default rules by priority", () => {
    const priorities = ((fresh() as any).rules as RoutingRule[]).map((r) => r.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it("falls through to the default rule when nothing else matches", () => {
    router = fresh();
    const r = router.applyRoutingRules({ task_type: "development", task_complexity: "high" });
    expect(r).toMatchObject({ provider: "claude-sonnet", rule_id: "default" });
  });

  it("does not match a rule when the request lacks a required key", () => {
    router = fresh();
    // security task but no priority field -> must not hit critical-tasks
    const r = router.applyRoutingRules({ task_type: "security" });
    expect(r.rule_id).toBe("default");
  });

  it("applies rules in priority order and skips disabled rules", () => {
    router = fresh("priority-rules.yaml");
    const rules: RoutingRule[] = [
      { id: "low-prio", name: "l", enabled: true, priority: 50, match: { task_type: "x" }, provider: "p-low", reason: "r" },
      { id: "high-prio", name: "h", enabled: true, priority: 1, match: { task_type: "x" }, provider: "p-high", reason: "r" },
      { id: "disabled", name: "d", enabled: false, priority: 0, match: { task_type: "x" }, provider: "p-off", reason: "r" },
    ];
    router.updateRules(rules);
    expect(router.applyRoutingRules({ task_type: "x" }).provider).toBe("p-high");
  });

  it("persists updated rules and reloads them in a new instance (no code change)", () => {
    const file = tmpFile("persist-rules.yaml");
    const a = new RoutingPluginsMCP(file);
    a.updateRules([
      { id: "only", name: "o", enabled: true, priority: 1, match: {}, provider: "custom-model", reason: "r" },
    ]);
    const b = new RoutingPluginsMCP(file);
    expect(b.applyRoutingRules({ task_type: "anything" }).provider).toBe("custom-model");
  });

  it("falls back to default rules when the rules file is corrupt", () => {
    const file = tmpFile("corrupt-rules.yaml");
    fs.writeFileSync(file, "rules: [this is: : not valid yaml");
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const r = new RoutingPluginsMCP(file);
    expect(r.applyRoutingRules({ task_type: "qa", task_complexity: "low" }).provider).toBe("claude-haiku");
  });

  it("reports per-rule counts and provider breakdown that sum correctly", () => {
    router = fresh();
    for (let i = 0; i < 3; i++) router.applyRoutingRules({ task_type: "qa", task_complexity: "low" });
    router.applyRoutingRules({ task_type: "development" });
    const stats = router.getStats();
    expect(stats.total_requests).toBe(4);
    expect(stats.rules_applied).toEqual({ "simple-tasks": 3, default: 1 });
    expect(stats.provider_breakdown).toEqual({ "claude-haiku": "75.0%", "claude-sonnet": "25.0%" });
  });
});

describe("Feature #8: A/B Testing Framework", () => {
  let ab: ABTestingFramework;

  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => { jest.restoreAllMocks(); });

  const fresh = () => new ABTestingFramework(tmpFile("missing-experiments.yaml"));

  it("assigns only valid variants and honours the traffic split", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment({ traffic_split: 0.5 }));
    const rand = mulberry32(42);
    const spy = jest.spyOn(Math, "random").mockImplementation(rand);
    let a = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const v = ab.assignVariant("exp-1").variant_id;
      expect(["A", "B"]).toContain(v);
      if (v === "A") a++;
    }
    spy.mockRestore();
    expect(a / N).toBeGreaterThan(0.47);
    expect(a / N).toBeLessThan(0.53);
  });

  it("keeps a user in the same variant across calls, and splits users roughly by traffic_split", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment({ traffic_split: 0.3 }));
    for (const user of ["alice", "bob", "carol"]) {
      const first = ab.assignVariant("exp-1", user).variant_id;
      for (let i = 0; i < 50; i++) expect(ab.assignVariant("exp-1", user).variant_id).toBe(first);
    }
    let a = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) if (ab.assignVariant("exp-1", `user-${i}`).variant_id === "A") a++;
    expect(a / N).toBeGreaterThan(0.27);
    expect(a / N).toBeLessThan(0.33);
  });

  it("sends all traffic to A at split 1 and all to B at split 0", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment({ id: "all-a", traffic_split: 1 }));
    ab.createExperiment(makeExperiment({ id: "all-b", traffic_split: 0 }));
    for (let i = 0; i < 50; i++) {
      expect(ab.assignVariant("all-a").variant_id).toBe("A");
      expect(ab.assignVariant("all-b").variant_id).toBe("B");
    }
  });

  it("throws for assignment on an unknown experiment and returns null results", () => {
    ab = fresh();
    expect(() => ab.assignVariant("nope")).toThrow("Experiment not found");
    expect(ab.getExperimentResults("nope")).toBeNull();
  });

  it("rejects experiments the statistics cannot handle (must have exactly 2 variants)", () => {
    ab = fresh();
    expect(() =>
      ab.createExperiment(makeExperiment({ variants: [{ id: "only", name: "o", config: {} }] }))
    ).toThrow(/exactly 2 variants/);
  });

  it("reports incomplete with zero confidence until enough data is collected", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment());
    recordSamples(ab, "exp-1", "A", 40, normalSampler(10, 1, 1));
    const r = ab.getExperimentResults("exp-1")!;
    expect(r.status).toBe("incomplete");
    expect(r.confidence).toBe(0);
    expect(r.statistical_analysis.message).toContain("60 more samples");
    expect(ab.recommendWinner("exp-1")).toBe("Insufficient data for recommendation");
  });

  it("declares the better variant the winner when the difference is large", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment());
    recordSamples(ab, "exp-1", "A", 60, normalSampler(10, 1, 11));
    recordSamples(ab, "exp-1", "B", 60, normalSampler(5, 1, 12));
    const r = ab.getExperimentResults("exp-1")!;
    expect(r.status).toBe("complete");
    expect(r.winner).toBe("A");
    expect(r.statistical_analysis.p_values.quality).toBeLessThan(0.001);
    expect(Math.abs(r.statistical_analysis.effect_sizes.quality)).toBeGreaterThan(3);
    expect(r.confidence).toBeGreaterThan(0.99);
    expect(ab.recommendWinner("exp-1")).toBe("A");
  });

  it("picks B when B is better (winner is not hard-wired to a position)", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment());
    recordSamples(ab, "exp-1", "A", 60, normalSampler(5, 1, 21));
    recordSamples(ab, "exp-1", "B", 60, normalSampler(10, 1, 22));
    expect(ab.getExperimentResults("exp-1")!.winner).toBe("B");
  });

  it("does NOT declare a winner when both variants come from the same distribution", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment());
    recordSamples(ab, "exp-1", "A", 60, normalSampler(10, 2, 31));
    recordSamples(ab, "exp-1", "B", 60, normalSampler(10, 2, 32));
    const r = ab.getExperimentResults("exp-1")!;
    expect(r.statistical_analysis.p_values.quality).toBeGreaterThan(0.05);
    expect(r.winner).toBeUndefined();
    expect(r.confidence).toBeLessThan(0.95);
    expect(ab.recommendWinner("exp-1")).toBe("No clear winner");
  });

  it("computes a 95% CI for the mean (narrower than the raw data spread)", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment());
    recordSamples(ab, "exp-1", "A", 100, normalSampler(10, 2, 41));
    recordSamples(ab, "exp-1", "B", 100, normalSampler(10, 2, 42));
    const m = ab.getExperimentResults("exp-1")!.variant_results.A.metrics.quality;
    const [lo, hi] = m.ci_95;
    // CI of the mean should be about +/- 1.96 * 2 / sqrt(100) = +/- 0.39, not +/- 3.9
    expect(hi - lo).toBeGreaterThan(0.5);
    expect(hi - lo).toBeLessThan(1.2);
    expect(lo).toBeLessThan(m.mean);
    expect(hi).toBeGreaterThan(m.mean);
  });

  it("does not return NaN when a variant has zero variance", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment());
    recordSamples(ab, "exp-1", "A", 50, () => 1);
    recordSamples(ab, "exp-1", "B", 50, () => 1);
    const r = ab.getExperimentResults("exp-1")!;
    expect(Number.isNaN(r.statistical_analysis.effect_sizes.quality)).toBe(false);
    expect(Number.isNaN(r.statistical_analysis.p_values.quality)).toBe(false);
    expect(r.winner).toBeUndefined();
  });

  it("keeps results for different experiments separate", () => {
    ab = fresh();
    ab.createExperiment(makeExperiment({ id: "e1" }));
    ab.createExperiment(makeExperiment({ id: "e2" }));
    recordSamples(ab, "e1", "A", 60, normalSampler(10, 1, 51));
    recordSamples(ab, "e1", "B", 60, normalSampler(5, 1, 52));
    expect(ab.getExperimentResults("e1")!.status).toBe("complete");
    expect(ab.getExperimentResults("e2")!.status).toBe("incomplete");
  });
});

describe("Feature #8: A/B data persistence", () => {
  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  const dataFile = (name: string) => tmpFile(`persist-${name}.jsonl`);
  // A data file has one writer, so reopening one means the previous process is gone: close its instance first.
  const live = new Map<string, ABTestingFramework>();
  const open = (file: string, yamlFile = tmpFile("persist-missing.yaml")) => {
    live.get(file)?.close();
    const ab = new ABTestingFramework(yamlFile, file);
    live.set(file, ab);
    return ab;
  };
  afterEach(() => {
    for (const ab of live.values()) ab.close();
    live.clear();
  });
  const seed = (ab: ABTestingFramework, n = 40) => {
    ab.createExperiment(makeExperiment());
    recordSamples(ab, "exp-1", "A", n, normalSampler(10, 1, 61));
    recordSamples(ab, "exp-1", "B", n, normalSampler(5, 1, 62));
  };

  it("restores experiments and measurements after a restart with identical results", () => {
    const file = dataFile("restart");
    const before = open(file);
    seed(before, 60);
    const expected = before.getExperimentResults("exp-1");

    const after = open(file);
    expect(after.listExperiments().map((e) => e.id)).toEqual(["exp-1"]);
    expect(after.getExperimentResults("exp-1")).toEqual(expected);
    expect(expected!.status).toBe("complete");
  });

  it("keeps accumulating across several restarts", () => {
    const file = dataFile("accumulate");
    seed(open(file), 20); // 40 samples: incomplete
    expect(open(file).getExperimentResults("exp-1")!.status).toBe("incomplete");
    const second = open(file);
    recordSamples(second, "exp-1", "A", 30, normalSampler(10, 1, 71));
    recordSamples(second, "exp-1", "B", 30, normalSampler(5, 1, 72));
    const third = open(file).getExperimentResults("exp-1")!;
    expect(third.status).toBe("complete");
    expect(third.variant_results.A.metrics.quality.sample_size).toBe(50);
    expect(third.variant_results.B.metrics.quality.sample_size).toBe(50);
  });

  it("writes one JSON line per event with owner-only permissions", () => {
    const file = dataFile("format");
    const ab = open(file);
    ab.createExperiment(makeExperiment());
    ab.recordMetric("exp-1", "A", { quality: 3.5 });
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["experiment", "measurement"]);
    expect(lines[1]).toMatchObject({ experiment_id: "exp-1", variant_id: "A", metrics: { quality: 3.5 } });
    // Windows has no POSIX permission bits, so the mode can only be asserted elsewhere.
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("is in-memory only when no data file is given", () => {
    const before = fs.readdirSync(tmpDir).length;
    const ab = new ABTestingFramework(tmpFile("persist-missing.yaml"));
    ab.createExperiment(makeExperiment());
    ab.recordMetric("exp-1", "A", { quality: 1 });
    expect(fs.readdirSync(tmpDir).length).toBe(before);
  });

  it("recovers from a line torn by a crash and keeps appending cleanly", () => {
    const file = dataFile("torn");
    const ab = open(file);
    seed(ab, 10);
    fs.appendFileSync(file, '{"type":"measurement","experiment_id":"exp-1","varia'); // crash mid-write, no newline

    const restarted = open(file);
    expect(restarted.getExperimentResults("exp-1")!.statistical_analysis.current_samples).toBe(20);
    restarted.recordMetric("exp-1", "A", { quality: 9 });

    const again = open(file);
    expect(again.getExperimentResults("exp-1")!.statistical_analysis.current_samples).toBe(21);
  });

  it("skips a corrupt line in the middle and drops measurements of unknown experiments", () => {
    const file = dataFile("corrupt");
    seed(open(file), 5);
    fs.appendFileSync(file, "not json at all\n");
    fs.appendFileSync(file, JSON.stringify({ type: "measurement", experiment_id: "ghost", variant_id: "A", metrics: { quality: 1 }, timestamp: "t" }) + "\n");
    fs.appendFileSync(file, JSON.stringify({ type: "measurement", experiment_id: "exp-1", variant_id: "A", metrics: { quality: "x" }, timestamp: "t" }) + "\n");
    fs.appendFileSync(file, JSON.stringify({ type: "mystery" }) + "\n");
    const ab = open(file);
    expect(ab.getExperimentResults("exp-1")!.statistical_analysis.current_samples).toBe(10);
    expect(ab.listExperiments()).toHaveLength(1);
  });

  it("rejects a duplicate experiment id instead of mixing data, including after a restart", () => {
    const file = dataFile("dup");
    const ab = open(file);
    ab.createExperiment(makeExperiment());
    expect(() => ab.createExperiment(makeExperiment())).toThrow("Experiment already exists");
    expect(() => open(file).createExperiment(makeExperiment())).toThrow("Experiment already exists");
  });

  it("treats the YAML definition as authoritative over a logged experiment with the same id", () => {
    const file = dataFile("yaml-wins");
    const yamlFile = tmpFile("persist-defs.yaml");
    seed(open(file), 60);
    const def = makeExperiment({ name: "From YAML" });
    fs.writeFileSync(yamlFile, JSON.stringify({ experiments: [def] })); // JSON is valid YAML
    const ab = open(file, yamlFile);
    expect(ab.listExperiments().find((e) => e.id === "exp-1")!.name).toBe("From YAML");
    expect(ab.getExperimentResults("exp-1")!.variant_results.A.metrics.quality.sample_size).toBe(60);
  });

  it("fails fast with a clear error when the data file cannot be used", () => {
    const blocker = tmpFile("persist-blocker");
    fs.writeFileSync(blocker, "a file, not a directory");
    expect(() => open(path.join(blocker, "ab.jsonl"))).toThrow(/Cannot use A\/B data file .*ab\.jsonl/);
  });

  it("does not apply a change in memory when the disk write fails", () => {
    const ab = open(dataFile("write-fail"));
    ab.createExperiment(makeExperiment());
    const realFs = require("fs");
    const spy = jest.spyOn(realFs, "appendFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    expect(() => ab.recordMetric("exp-1", "A", { quality: 1 })).toThrow("ENOSPC");
    expect(() => ab.createExperiment(makeExperiment({ id: "exp-2" }))).toThrow("ENOSPC");
    spy.mockRestore();
    expect(ab.listExperiments().map((e) => e.id)).toEqual(["exp-1"]);
    ab.recordMetric("exp-1", "A", { quality: 2 });
    recordSamples(ab, "exp-1", "B", 99, () => 1);
    expect(ab.getExperimentResults("exp-1")!.status).not.toBe(undefined);
    expect(open(dataFile("write-fail")).getExperimentResults("exp-1")!.statistical_analysis.current_samples).toBe(100);
  });
});

describe("Feature #8: A/B data file lock, fsync and growth warning", () => {
  let errorSpy: ReturnType<typeof jest.spyOn>;
  beforeAll(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  const tracked: ABTestingFramework[] = [];
  afterEach(() => {
    for (const ab of tracked.splice(0)) ab.close();
  });

  const dataFile = (name: string) => tmpFile(`lock-${name}.jsonl`);
  const lockOf = (file: string) => `${file}.lock`;
  const open = (file: string, options?: ConstructorParameters<typeof ABTestingFramework>[2]) => {
    const ab = new ABTestingFramework(tmpFile("lock-missing.yaml"), file, options);
    tracked.push(ab);
    return ab;
  };
  const samples = (ab: ABTestingFramework) => ab.getExperimentResults("exp-1")!.statistical_analysis.current_samples;
  /** Plant a lock as another process would have left it, last refreshed `ageMs` ago. */
  const plantLock = (file: string, info: { pid: number; host: string }, ageMs: number) => {
    fs.writeFileSync(lockOf(file), JSON.stringify({ ...info, started: "earlier", token: "someone-else" }));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(lockOf(file), t, t);
  };
  const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

  describe("single writer", () => {
    it("holds a lock file while open and removes it on close", () => {
      const file = dataFile("basic");
      const ab = open(file);
      expect(fs.existsSync(lockOf(file))).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockOf(file), "utf-8"))).toMatchObject({ pid: process.pid, host: os.hostname() });
      ab.close();
      ab.close(); // idempotent
      expect(fs.existsSync(lockOf(file))).toBe(false);
    });

    it("refuses a second instance on the same file and hands the file over after close", () => {
      const file = dataFile("handover");
      const first = open(file);
      first.createExperiment(makeExperiment());
      first.recordMetric("exp-1", "A", { quality: 1 });
      expect(() => open(file)).toThrow(/Cannot use A\/B data file .*already open in this process/);
      first.close();
      const second = open(file);
      expect(samples(second)).toBe(1);
    });

    it("fails at once when the lock belongs to a live process on this machine", () => {
      const file = dataFile("live-holder");
      const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      try {
        plantLock(file, { pid: holder.pid!, host: os.hostname() }, 0);
        const started = Date.now();
        expect(() => open(file)).toThrow(new RegExp(`in use by pid ${holder.pid} on ${os.hostname()}`));
        expect(Date.now() - started).toBeLessThan(2_000); // no waiting when the holder is verifiably alive
        expect(fs.existsSync(file)).toBe(false); // and nothing was created or read
      } finally {
        holder.kill();
      }
    });

    it("takes over the lock of a crashed process on this machine, and keeps its data", () => {
      const file = dataFile("crashed");
      const before = open(file);
      before.createExperiment(makeExperiment());
      before.recordMetric("exp-1", "A", { quality: 1 });
      before.close();
      plantLock(file, { pid: deadPid(), host: os.hostname() }, 10_000);
      const after = open(file);
      expect(samples(after)).toBe(1);
      expect(JSON.parse(fs.readFileSync(lockOf(file), "utf-8")).token).not.toBe("someone-else");
    });

    it("waits out a very recent lock of a dead process instead of racing it, then takes it over", () => {
      const file = dataFile("just-crashed");
      plantLock(file, { pid: deadPid(), host: os.hostname() }, 5_500); // not yet old enough to be sure
      const started = Date.now();
      open(file);
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(Date.now() - started).toBeLessThan(8_000);
    });

    it("takes over a lock that stopped being refreshed, whichever machine wrote it", () => {
      const file = dataFile("abandoned");
      plantLock(file, { pid: 1, host: "some-other-pod" }, 60_000);
      expect(() => open(file)).not.toThrow();
    });

    it("treats a lock naming its own pid as the leftover of a previous run (a restarted container is pid 1 again)", () => {
      const file = dataFile("own-pid");
      plantLock(file, { pid: process.pid, host: os.hostname() }, 0);
      expect(() => open(file)).not.toThrow();
    });

    it("waits, then fails clearly, for a fresh lock from another machine it cannot check", () => {
      const file = dataFile("elsewhere");
      plantLock(file, { pid: 1, host: "some-other-pod" }, 0);
      const started = Date.now();
      expect(() => open(file, { lockWaitMs: 600 })).toThrow(/held by pid 1 on some-other-pod.*could not be checked from here/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    });

    it("treats an unreadable lock like one from a machine it cannot check", () => {
      const file = dataFile("garbage-lock");
      fs.writeFileSync(lockOf(file), "not json");
      expect(() => open(file, { lockWaitMs: 300 })).toThrow(/an unknown process/);
    });

    it("leaves no lock behind when the data file cannot be opened", () => {
      const file = dataFile("unopenable");
      fs.mkdirSync(file); // a directory where the file should be
      expect(() => open(file)).toThrow(/Cannot use A\/B data file/);
      expect(fs.existsSync(lockOf(file))).toBe(false);
    });

    it("keeps refreshing its lock while it runs", () => {
      jest.useFakeTimers();
      try {
        const file = dataFile("heartbeat");
        open(file);
        const before = fs.statSync(lockOf(file)).mtimeMs;
        jest.advanceTimersByTime(3_100);
        expect(fs.statSync(lockOf(file)).mtimeMs).toBeGreaterThan(before + 2_000);
      } finally {
        jest.useRealTimers();
      }
    });

    it("refuses to write once another process has taken the lock over, and does not delete that lock", () => {
      const file = dataFile("lost");
      const ab = open(file);
      ab.createExperiment(makeExperiment());
      const logged = fs.readFileSync(file, "utf-8");
      fs.writeFileSync(lockOf(file), JSON.stringify({ pid: 1, host: "x", started: "t", token: "someone-else" }));
      expect(() => ab.recordMetric("exp-1", "A", { quality: 1 })).toThrow(/lock was lost/);
      expect(() => ab.createExperiment(makeExperiment({ id: "exp-2" }))).toThrow(/lock was lost/);
      expect(fs.readFileSync(file, "utf-8")).toBe(logged);
      ab.close();
      expect(JSON.parse(fs.readFileSync(lockOf(file), "utf-8")).token).toBe("someone-else");
    });

    it("refuses to write after close", () => {
      const ab = open(dataFile("closed"));
      ab.createExperiment(makeExperiment());
      ab.close();
      expect(() => ab.recordMetric("exp-1", "A", { quality: 1 })).toThrow("closed");
    });
  });

  describe("fsync", () => {
    const realFs = require("fs");

    it("flushes every append to disk when enabled", () => {
      const spy = jest.spyOn(realFs, "fsyncSync");
      try {
        const ab = open(dataFile("fsync-on"), { fsync: true });
        spy.mockClear();
        ab.createExperiment(makeExperiment());
        ab.recordMetric("exp-1", "A", { quality: 1 });
        ab.recordMetric("exp-1", "B", { quality: 2 });
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
    });

    it("does not flush when disabled (the default)", () => {
      const spy = jest.spyOn(realFs, "fsyncSync");
      try {
        const ab = open(dataFile("fsync-off"));
        ab.createExperiment(makeExperiment());
        ab.recordMetric("exp-1", "A", { quality: 1 });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("fails the call when the flush fails, without applying the change in memory", () => {
      const file = dataFile("fsync-fail");
      const ab = open(file, { fsync: true });
      ab.createExperiment(makeExperiment());
      const spy = jest.spyOn(realFs, "fsyncSync").mockImplementation(() => {
        throw new Error("EIO: input/output error");
      });
      try {
        expect(() => ab.recordMetric("exp-1", "A", { quality: 1 })).toThrow("EIO");
      } finally {
        spy.mockRestore();
      }
      expect(samples(ab)).toBe(0);
      // The line was appended before the flush failed, so it may well be on disk: the caller got an error,
      // and a restart will show the measurement. Documented in DEPLOYMENT.md.
      ab.close();
      expect(samples(open(file))).toBe(1);
    });
  });

  describe("growth warning", () => {
    const growthWarnings = () =>
      errorSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("never compacted")).length;

    it("warns once when the file passes the size limit", () => {
      // The experiment line is 351 bytes, so the first measurement (127) is what crosses 400.
      const ab = open(dataFile("grow"), { warnBytes: 400 });
      ab.createExperiment(makeExperiment());
      errorSpy.mockClear();
      for (let i = 0; i < 10; i++) ab.recordMetric("exp-1", "A", { quality: i });
      expect(growthWarnings()).toBe(1);
    });

    it("warns at startup when the existing file is already over the limit", () => {
      const file = dataFile("grown");
      const first = open(file);
      first.createExperiment(makeExperiment());
      for (let i = 0; i < 10; i++) first.recordMetric("exp-1", "A", { quality: i });
      first.close();
      errorSpy.mockClear();
      open(file, { warnBytes: 300 });
      expect(growthWarnings()).toBe(1);
    });

    it("stays quiet below the limit", () => {
      const ab = open(dataFile("small"));
      ab.createExperiment(makeExperiment());
      errorSpy.mockClear();
      ab.recordMetric("exp-1", "A", { quality: 1 });
      expect(growthWarnings()).toBe(0);
    });
  });
});

describe("Feature #9: Universal API Gateway", () => {
  let gw: UniversalAPIGateway;

  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it("discovers the registered APIs and filters by name/category/description", () => {
    gw = new UniversalAPIGateway();
    const all = gw.discoverAPIs();
    expect(all.length).toBe(9);
    expect(gw.discoverAPIs("weather").map((a) => a.id).sort()).toEqual(["openweathermap", "weatherapi"]);
    expect(gw.discoverAPIs("WEATHER").length).toBe(2);
    expect(gw.discoverAPIs("no-such-thing-xyz")).toEqual([]);
  });

  it("returns data on a miss, then serves identical calls from cache", async () => {
    gw = new UniversalAPIGateway();
    const first = await gw.callAPI("openweathermap", "/weather", { q: "London" });
    const second = await gw.callAPI("openweathermap", "/weather", { q: "London" });
    expect(first.cached).toBe(false);
    expect(first.data.main.temp).toBeDefined();
    expect(second.cached).toBe(true);
    expect(second.data).toEqual(first.data);
  });

  it("does not share cache entries across different params or endpoints", async () => {
    gw = new UniversalAPIGateway();
    await gw.callAPI("openweathermap", "/weather", { q: "London" });
    expect((await gw.callAPI("openweathermap", "/weather", { q: "Paris" })).cached).toBe(false);
    expect((await gw.callAPI("openweathermap", "/forecast", { q: "London" })).cached).toBe(false);
  });

  it("expires cache entries after the 5 minute TTL", async () => {
    gw = new UniversalAPIGateway();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    await gw.callAPI("newsapi", "/top", {});
    now += 299_000;
    expect((await gw.callAPI("newsapi", "/top", {})).cached).toBe(true);
    now += 2_000; // 301s after the original write
    expect((await gw.callAPI("newsapi", "/top", {})).cached).toBe(false);
  });

  it("rejects unknown APIs and counts the failure", async () => {
    gw = new UniversalAPIGateway();
    await expect(gw.callAPI("does-not-exist", "/x")).rejects.toThrow("API not found");
    expect(gw.getStats()).toMatchObject({ total_calls: 1, failed: 1, successful: 0 });
  });

  it("aggregates calls in order and tracks stats", async () => {
    gw = new UniversalAPIGateway();
    const out = await gw.aggregateAPIs([
      { id: "openweathermap", endpoint: "/weather", params: { q: "NYC" } },
      { id: "newsapi", endpoint: "/top" },
      { id: "coingecko", endpoint: "/price" },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].data.main).toBeDefined();
    expect(out[1].data.articles).toBeDefined();
    expect(out[2].data.bitcoin).toBeDefined();
    const s = gw.getStats();
    expect(s.successful).toBe(3);
    expect(s.cached_items).toBe(3);
  });

  it("reports a cache hit rate", async () => {
    gw = new UniversalAPIGateway();
    await gw.callAPI("wikipedia", "/page", { t: "x" });
    await gw.callAPI("wikipedia", "/page", { t: "x" });
    expect(gw.getStats().cache_hit_rate).toBe("0.50");
  });

  it("clearCache forces a fresh call, and custom APIs can be registered", async () => {
    gw = new UniversalAPIGateway();
    await gw.callAPI("wikipedia", "/page", {});
    gw.clearCache();
    expect((await gw.callAPI("wikipedia", "/page", {})).cached).toBe(false);
    gw.addCustomAPI({
      id: "custom", name: "Custom", category: "test", endpoint: "https://example.invalid",
      methods: ["GET"], auth: "none", free: true, description: "custom api",
    });
    expect(gw.discoverAPIs("custom").map((a) => a.id)).toContain("custom");
    expect((await gw.callAPI("custom", "/x", { a: 1 })).data.status).toBe("success");
  });

  it("handles 100 concurrent calls correctly", async () => {
    gw = new UniversalAPIGateway();
    const calls = Array.from({ length: 100 }, (_, i) => ({
      id: "openweathermap", endpoint: "/weather", params: { q: `city-${i % 10}` },
    }));
    const start = process.hrtime.bigint();
    const out = await gw.aggregateAPIs(calls);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(out).toHaveLength(100);
    expect(out.every((r) => r.data.main.temp !== undefined)).toBe(true);
    // Mock backend, in-process: measures gateway overhead only, not real API latency.
    expect(ms).toBeLessThan(2000);
  });
});

describe("Composition: routing -> experiment -> gateway", () => {
  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => { jest.restoreAllMocks(); });

  it("runs a request through all three real components", async () => {
    const router = new RoutingPluginsMCP(tmpFile("pipeline-rules-missing.yaml"));
    const ab = new ABTestingFramework(tmpFile("pipeline-exp-missing.yaml"));
    const gw = new UniversalAPIGateway();
    ab.createExperiment(makeExperiment({ id: "pipeline" }));

    const request = { task_type: "qa", task_complexity: "low" };
    const route = router.applyRoutingRules(request);
    const variant = ab.assignVariant("pipeline");
    const data = await gw.aggregateAPIs([
      { id: "openweathermap", endpoint: "/weather", params: { q: "SF" } },
      { id: "newsapi", endpoint: "/top" },
    ]);
    ab.recordMetric("pipeline", variant.variant_id, { quality: 0.9 });

    expect(route.provider).toBe("claude-haiku");
    expect(["A", "B"]).toContain(variant.variant_id);
    expect(data).toHaveLength(2);
    expect(ab.getExperimentResults("pipeline")!.status).toBe("incomplete");
    expect(router.getStats().total_requests).toBe(1);
    expect(gw.getStats().successful).toBe(2);
  });
});

describe("Tool dispatch (processToolCall), isolated from the working directory", () => {
  const saved = { r: process.env.RULES_FILE, e: process.env.EXPERIMENTS_FILE };
  let routing: typeof import("../features/07-routing-plugins/src/mcp-server");
  let abTool: typeof import("../features/08-ab-testing/src/mcp-server");
  let gwTool: typeof import("../features/09-api-gateway/src/mcp-server");

  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.RULES_FILE = tmpFile("tool-rules.yaml");
    process.env.EXPERIMENTS_FILE = tmpFile("tool-experiments.yaml");
    jest.isolateModules(() => {
      routing = require("../features/07-routing-plugins/src/mcp-server");
      abTool = require("../features/08-ab-testing/src/mcp-server");
      gwTool = require("../features/09-api-gateway/src/mcp-server");
    });
  });
  afterAll(() => {
    jest.restoreAllMocks();
    process.env.RULES_FILE = saved.r;
    process.env.EXPERIMENTS_FILE = saved.e;
    if (saved.r === undefined) delete process.env.RULES_FILE;
    if (saved.e === undefined) delete process.env.EXPERIMENTS_FILE;
  });

  it("routing tools: apply_routing_rules, get_rule_stats, update_rules, unknown tool", async () => {
    const applied = JSON.parse(await routing.processToolCall("apply_routing_rules", { task_type: "qa", task_complexity: "low" }));
    expect(applied.provider).toBe("claude-haiku");
    expect(JSON.parse(await routing.processToolCall("get_rule_stats", {})).total_requests).toBe(1);
    const upd = JSON.parse(await routing.processToolCall("update_rules", {
      rules: [{ id: "x", name: "x", enabled: true, priority: 1, match: {}, provider: "p", reason: "r" }],
    }));
    expect(upd.status).toBe("success");
    expect(fs.existsSync(tmpFile("tool-rules.yaml"))).toBe(true);
    expect(JSON.parse(await routing.processToolCall("nope", {})).error).toBe("Unknown tool");
  });

  it("A/B tools: create, assign, record, results, recommend", async () => {
    await abTool.processToolCall("create_experiment", makeExperiment({ id: "t1" }) as any);
    const a = JSON.parse(await abTool.processToolCall("assign_variant", { experiment_id: "t1" }));
    expect(["A", "B"]).toContain(a.variant_id);
    await abTool.processToolCall("record_metric", { experiment_id: "t1", variant_id: a.variant_id, metrics: { quality: 1 } });
    expect(JSON.parse(await abTool.processToolCall("get_experiment_results", { experiment_id: "t1" })).status).toBe("incomplete");
    expect(JSON.parse(await abTool.processToolCall("recommend_winner", { experiment_id: "t1" })).recommendation)
      .toBe("Insufficient data for recommendation");
  });

  it("gateway tools: discover, call, aggregate, stats, and error shaping", async () => {
    expect(JSON.parse(await gwTool.processToolCall("discover_apis", { query: "news" })).length).toBeGreaterThan(0);
    expect(JSON.parse(await gwTool.processToolCall("call_api", { api_id: "newsapi", endpoint: "/top" })).cached).toBe(false);
    expect(JSON.parse(await gwTool.processToolCall("call_api", { api_id: "bogus", endpoint: "/x" })).error).toContain("API not found");
    expect(JSON.parse(await gwTool.processToolCall("aggregate_apis", { apis: [{ id: "newsapi", endpoint: "/top" }] })).count).toBe(1);
    expect(JSON.parse(await gwTool.processToolCall("get_api_stats", {})).total_calls).toBeGreaterThan(0);
  });
});

describe("Vendored features #1-#4, #6 (git submodules, not exercised here)", () => {
  it.todo("#1 OmniRoute: runs as a separate service; needs a live-service integration test");
  it.todo("#2 Claude-Mem: no in-process test in this repo");
  it.todo("#3 Token-Optimizer: real compression ratio must be measured on real contexts");
  it.todo("#3b Headroom: no in-process test in this repo");
  it.todo("#4 gstack: installs as Claude Code skills; no in-process test in this repo");
  it.todo("#6 agentacct: real cost savings must be measured from actual usage logs");
});
