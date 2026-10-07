import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ABTestingFramework } from "../features/08-ab-testing/src/mcp-server";
import { rng } from "./helpers/ab-golden-data";

/**
 * Metric semantics (roadmap step 12): a metric can say which way is better (`direction`), an experiment can name the metric
 * that decides (`primary_metric`), and a metric can be a `guardrail` that may withhold a winner but never pick one.
 * Before this the first metric decided and the higher mean always won, which reports a significantly cheaper variant as the
 * loser. Experiments that use none of the new fields must answer exactly as before: tests/ab-golden.test.ts holds that.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-ab-metrics-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const noExperimentsFile = path.join(tmp, "none.yaml");

let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

const variants = [
  { id: "A", name: "A", config: {} },
  { id: "B", name: "B", config: {} },
];
const experiment = (metrics: any[], extra: Record<string, unknown> = {}): any => ({
  id: "x",
  name: "x",
  hypothesis: "h",
  status: "setup",
  variants,
  traffic_split: 0.5,
  metrics,
  ...extra,
});
const metric = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, type: "continuous", aggregation: "mean", ...extra });

const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/**
 * `shift[m]` is how much B's mean differs from A's on metric m. A and B share the same noise draw for each measurement, so a
 * shift of 0 is exactly "no difference" (p = 1) and a shift of 1 is overwhelmingly significant: nothing here depends on a lucky seed.
 * A metric listed in `skip` is never recorded.
 */
function fill(fw: ABTestingFramework, shift: Record<string, number>, options: { n?: number; seed?: number; skip?: string[]; id?: string } = {}) {
  const { n = 60, seed = 1, skip = [], id = "x" } = options;
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const noise = Object.fromEntries(Object.keys(shift).map((m) => [m, normal(r)]));
    for (const v of ["A", "B"]) {
      const metrics: Record<string, number> = {};
      for (const m of Object.keys(shift)) if (!skip.includes(m)) metrics[m] = 10 + (v === "B" ? shift[m] : 0) + noise[m];
      fw.recordMetric(id, v, metrics);
    }
  }
}

function run(exp: any, shift: Record<string, number>, options: Parameters<typeof fill>[2] = {}) {
  const fw = new ABTestingFramework(noExperimentsFile);
  fw.createExperiment(exp);
  fill(fw, shift, options);
  return { fw, results: fw.getExperimentResults("x")!, recommendation: fw.recommendWinner("x") };
}

describe("direction", () => {
  it("defaults to higher is better, as before: a variant with a much lower cost is the loser unless the metric says lower is better", () => {
    expect(run(experiment([metric("cost")]), { cost: -1 }).results.winner).toBe("A");
  });

  it("names the variant with the lower mean the winner on a lower_is_better metric", () => {
    const { results, recommendation } = run(experiment([metric("cost", { direction: "lower_is_better" })]), { cost: -1 });
    expect(results.winner).toBe("B");
    expect(recommendation).toBe("B");
    expect(run(experiment([metric("cost", { direction: "lower_is_better" })]), { cost: +1 }).results.winner).toBe("A");
  });

  it("treats an explicit higher_is_better exactly like the default", () => {
    const shift = { quality: 1 };
    const explicit = run(experiment([metric("quality", { direction: "higher_is_better" })]), shift).results;
    const implicit = run(experiment([metric("quality")]), shift).results;
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
    expect(explicit.winner).toBe("B");
  });

  it("names no winner when the difference is not significant, whatever the direction", () => {
    for (const direction of ["higher_is_better", "lower_is_better"]) {
      expect(run(experiment([metric("m", { direction })]), { m: 0 }).results.winner).toBeUndefined();
    }
  });

  it("is symmetric: negating every value and flipping the direction gives the same winner, confidence and p-values (40 random datasets)", () => {
    // The p-value does not care about the sign of the data; only the meaning of "better" does. A direction that is applied
    // to the wrong side, or to the wrong metric, breaks this for some of the datasets.
    const bad: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 7919);
      const shift = { m: (r() - 0.5) * 2 }; // from -1 to +1: significant and not, both ways
      const n = 50 + Math.floor(r() * 40); // 100 samples in total is the module's minimum for any result
      const direct = new ABTestingFramework(noExperimentsFile);
      const negated = new ABTestingFramework(noExperimentsFile);
      direct.createExperiment(experiment([metric("m", { direction: "higher_is_better" })]));
      negated.createExperiment(experiment([metric("m", { direction: "lower_is_better" })]));
      const rr = rng(seed);
      for (let i = 0; i < n; i++) {
        const z = normal(rr);
        for (const v of ["A", "B"]) {
          const x = 10 + (v === "B" ? shift.m : 0) + z;
          direct.recordMetric("x", v, { m: x });
          negated.recordMetric("x", v, { m: -x });
        }
      }
      const a = direct.getExperimentResults("x")!;
      const b = negated.getExperimentResults("x")!;
      const same =
        a.winner === b.winner &&
        a.confidence === b.confidence &&
        JSON.stringify(a.statistical_analysis.p_values) === JSON.stringify(b.statistical_analysis.p_values) &&
        a.statistical_analysis.effect_sizes.m + 0 === -b.statistical_analysis.effect_sizes.m + 0;
      if (!same) bad.push(`seed ${seed}: ${a.winner}/${b.winner} p ${JSON.stringify(a.statistical_analysis.p_values)} vs ${JSON.stringify(b.statistical_analysis.p_values)}`);
    }
    expect(bad).toEqual([]);
  });

  it("names the same winner when the two variants are listed the other way round", () => {
    for (const direction of ["higher_is_better", "lower_is_better"]) {
      const forward = run(experiment([metric("m", { direction })]), { m: -1 }).results.winner;
      const fw = new ABTestingFramework(noExperimentsFile);
      fw.createExperiment(experiment([metric("m", { direction })], { variants: [variants[1], variants[0]] }));
      fill(fw, { m: -1 });
      expect(fw.getExperimentResults("x")!.winner).toBe(forward);
    }
  });
});

describe("primary_metric", () => {
  const metrics = [metric("quality"), metric("cost", { direction: "lower_is_better" })];

  it("lets the first metric decide when none is named (a first metric with no difference means no winner)", () => {
    expect(run(experiment(metrics), { quality: 0, cost: -1 }).results.winner).toBeUndefined();
  });

  it("lets the named metric decide instead, and the others only report", () => {
    const { results } = run(experiment(metrics, { primary_metric: "cost" }), { quality: 0, cost: -1 });
    expect(results.winner).toBe("B");
    expect(Object.keys(results.statistical_analysis.p_values).sort()).toEqual(["cost", "quality"]);
    // quality is reported but did not decide: moving it does not move the winner
    expect(run(experiment(metrics, { primary_metric: "cost" }), { quality: -1, cost: -1 }).results.winner).toBe("B");
  });

  it("reports the confidence of the named metric", () => {
    const named = run(experiment(metrics, { primary_metric: "cost" }), { quality: 0, cost: -1 }).results;
    const first = run(experiment(metrics), { quality: 0, cost: -1 }).results;
    expect(named.confidence).toBeGreaterThan(0.99);
    expect(first.confidence).toBe(0); // p = 1 on the first metric
  });
});

describe("guardrails", () => {
  const guarded = (extra: Record<string, unknown> = {}) =>
    experiment(
      [metric("cost", { direction: "lower_is_better" }), metric("quality", { guardrail: true }), metric("latency", { direction: "lower_is_better", guardrail: true })],
      extra
    );

  it("withholds a winner that is significantly worse on a guardrail, and says which one", () => {
    const { results, recommendation } = run(guarded(), { cost: -1, quality: -1, latency: 0 });
    expect(results.winner).toBeUndefined();
    expect(results.statistical_analysis.winner_withheld_by).toEqual(["quality"]);
    expect(results.statistical_analysis.guardrails.quality).toMatchObject({ significantly_worse_variant: "B" });
    expect(results.statistical_analysis.guardrails.quality.p_value).toBeLessThan(0.001);
    expect(recommendation).toBe("No clear winner (withheld by guardrail: quality)");
    expect(results.confidence).toBeGreaterThan(0.99); // the confidence still describes the primary metric
  });

  it("applies each guardrail's own direction, and reports every guardrail that blocks", () => {
    const { results } = run(guarded(), { cost: -1, quality: -1, latency: +1 }); // B is slower: latency is lower_is_better
    expect(results.statistical_analysis.winner_withheld_by).toEqual(["quality", "latency"]);
    expect(results.statistical_analysis.guardrails.latency.significantly_worse_variant).toBe("B");
  });

  it("keeps the winner when the guardrail shows no significant difference, and still reports it", () => {
    const { results } = run(guarded(), { cost: -1, quality: 0, latency: 0 });
    expect(results.winner).toBe("B");
    expect(results.statistical_analysis.winner_withheld_by).toBeUndefined();
    expect(results.statistical_analysis.guardrails.quality).toEqual({ p_value: 1, significantly_worse_variant: null });
  });

  it("keeps the winner when the guardrail is significantly better for it, and names the other variant as the worse one", () => {
    const { results } = run(guarded(), { cost: -1, quality: +1, latency: -1 });
    expect(results.winner).toBe("B");
    expect(results.statistical_analysis.guardrails.quality.significantly_worse_variant).toBe("A");
    expect(results.statistical_analysis.guardrails.latency.significantly_worse_variant).toBe("A");
  });

  it("withholds the winner when a guardrail has no data: a check that did not run is not a pass", () => {
    const { results, recommendation } = run(guarded(), { cost: -1, quality: 0, latency: 0 }, { skip: ["quality"] });
    expect(results.winner).toBeUndefined();
    expect(results.statistical_analysis.winner_withheld_by).toEqual(["quality"]);
    expect(results.statistical_analysis.guardrails.quality).toEqual({ p_value: null, significantly_worse_variant: null });
    expect(recommendation).toContain("quality");
  });

  it("does not need guardrail data when there is no winner to protect", () => {
    const { results, recommendation } = run(guarded(), { cost: 0, quality: 0, latency: 0 }, { skip: ["quality"] });
    expect(results.winner).toBeUndefined();
    expect(results.statistical_analysis.winner_withheld_by).toBeUndefined();
    expect(recommendation).toBe("No clear winner");
  });

  it("never lets a guardrail pick the winner", () => {
    const { results } = run(guarded(), { cost: 0, quality: +1, latency: -1 });
    expect(results.winner).toBeUndefined();
  });

  it("adds no keys for an experiment without guardrails (its output is byte-identical to before)", () => {
    const { results } = run(experiment([metric("cost", { direction: "lower_is_better" }), metric("quality")]), { cost: -1, quality: -1 });
    expect(Object.keys(results.statistical_analysis).sort()).toEqual(["effect_sizes", "p_values", "significance_level", "test"]);
    expect(results.winner).toBe("B");
  });
});

describe("validation", () => {
  const create = (exp: any) => new ABTestingFramework(noExperimentsFile).createExperiment(exp);

  it("rejects a direction that is not one of the two, instead of silently reading it as higher is better", () => {
    expect(() => create(experiment([metric("m", { direction: "lower" })]))).toThrow("direction must be one of higher_is_better, lower_is_better");
    expect(() => create(experiment([metric("m", { direction: "LOWER_IS_BETTER" })]))).toThrow("direction");
    expect(() => create(experiment([metric("m", { direction: 1 })]))).toThrow("direction");
  });

  it("rejects a guardrail flag that is not true or false", () => {
    expect(() => create(experiment([metric("m"), metric("g", { guardrail: "yes" })]))).toThrow("guardrail must be true or false");
  });

  it("rejects a primary_metric that is not one of the metrics", () => {
    expect(() => create(experiment([metric("m")], { primary_metric: "nope" }))).toThrow("primary_metric nope is not one of the experiment's metrics");
  });

  it("rejects a guardrail as the primary metric, named or by default (it would block itself)", () => {
    expect(() => create(experiment([metric("m"), metric("g", { guardrail: true })], { primary_metric: "g" }))).toThrow("cannot also be a guardrail");
    expect(() => create(experiment([metric("g", { guardrail: true }), metric("m")]))).toThrow("cannot be a guardrail; set primary_metric");
    expect(() => create(experiment([metric("g", { guardrail: true }), metric("m")], { primary_metric: "m" }))).not.toThrow();
  });

  it("accepts every experiment that was valid before these fields existed", () => {
    expect(() => create(experiment([metric("m")]))).not.toThrow();
    expect(() => create(experiment([{ id: "m", name: "m", type: "x", aggregation: "y", something_else: 1 }]))).not.toThrow();
    expect(() => create(experiment([]))).not.toThrow();
  });

  it("is applied to experiments loaded from the experiments file too (an invalid one is skipped, not half-loaded)", () => {
    const file = path.join(tmp, "experiments.yaml");
    fs.writeFileSync(
      file,
      [
        "experiments:",
        "  - {id: good, name: g, hypothesis: h, traffic_split: 0.5, variants: [{id: A, name: A, config: {}}, {id: B, name: B, config: {}}], metrics: [{id: cost, name: cost, type: t, aggregation: a, direction: lower_is_better}]}",
        "  - {id: bad, name: b, hypothesis: h, traffic_split: 0.5, variants: [{id: A, name: A, config: {}}, {id: B, name: B, config: {}}], metrics: [{id: cost, name: cost, type: t, aggregation: a, direction: sideways}]}",
      ].join("\n")
    );
    const fw = new ABTestingFramework(file);
    expect(fw.listExperiments().map((e) => e.id)).toEqual(["good"]);
  });
});

describe("persistence", () => {
  it("keeps direction, primary_metric and guardrails across a restart, with identical results live and replayed", () => {
    const file = path.join(tmp, "metrics.jsonl");
    const exp = experiment([metric("cost", { direction: "lower_is_better" }), metric("quality", { guardrail: true })], { primary_metric: "cost" });
    const live = new ABTestingFramework(noExperimentsFile, file);
    live.createExperiment(exp);
    fill(live, { cost: -1, quality: -1 });
    const before = JSON.stringify({ r: live.getExperimentResults("x"), w: live.recommendWinner("x") });
    live.close();

    const replayed = new ABTestingFramework(noExperimentsFile, file);
    try {
      expect(JSON.stringify({ r: replayed.getExperimentResults("x"), w: replayed.recommendWinner("x") })).toBe(before);
      expect(replayed.getExperimentResults("x")!.statistical_analysis.winner_withheld_by).toEqual(["quality"]);
    } finally {
      replayed.close();
    }
  });
});
