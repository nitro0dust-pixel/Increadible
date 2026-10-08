import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ABTestingFramework, holmAdjust } from "../features/08-ab-testing/src/mcp-server";
import { rng } from "./helpers/ab-golden-data";
import assignGolden from "./fixtures/ab-assign-golden.json";

/**
 * More than two variants (roadmap step 12, second half). Rules under test:
 *  - an experiment with two variants behaves exactly as before: the same sticky assignments (tests/fixtures/ab-assign-golden.json,
 *    recorded from the previous implementation) and the same results (tests/ab-golden.test.ts);
 *  - more variants share traffic equally, or by `weights`;
 *  - a variant wins only if it is significantly better than every other one, after Holm's correction over all pairs.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-ab-variants-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const noExperimentsFile = path.join(tmp, "none.yaml");

let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

const ids = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)); // A, B, C ...
const experiment = (variantIds: string[], metrics: any[], extra: Record<string, unknown> = {}): any => ({
  id: "x",
  name: "x",
  hypothesis: "h",
  status: "setup",
  variants: variantIds.map((id) => ({ id, name: id, config: {} })),
  traffic_split: 0.5,
  metrics,
  ...extra,
});
const metric = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, type: "continuous", aggregation: "mean", ...extra });
const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** Same idea as tests/ab-metrics.test.ts: all variants share one noise draw per measurement, so a shift of 0 is exactly "no difference". */
function fill(
  fw: ABTestingFramework,
  shifts: Record<string, Record<string, number>>,
  options: { n?: number; seed?: number; counts?: Record<string, number>; skip?: Record<string, string[]> } = {}
) {
  const { n = 60, seed = 1, counts = {}, skip = {} } = options;
  const r = rng(seed);
  const metricIds = [...new Set(Object.values(shifts).flatMap((s) => Object.keys(s)))];
  for (let i = 0; i < n; i++) {
    const noise = Object.fromEntries(metricIds.map((m) => [m, normal(r)]));
    for (const [v, shift] of Object.entries(shifts)) {
      if (i >= (counts[v] ?? n)) continue;
      const metrics: Record<string, number> = {};
      for (const m of metricIds) if (!(skip[v] ?? []).includes(m)) metrics[m] = 10 + (shift[m] ?? 0) + noise[m];
      fw.recordMetric("x", v, metrics);
    }
  }
}

function run(exp: any, shifts: Record<string, Record<string, number>>, options: Parameters<typeof fill>[2] = {}) {
  const fw = new ABTestingFramework(noExperimentsFile);
  fw.createExperiment(exp);
  fill(fw, shifts, options);
  return { fw, results: fw.getExperimentResults("x")!, recommendation: fw.recommendWinner("x") };
}
const shifts = (byVariant: Record<string, number>, m = "quality") => Object.fromEntries(Object.entries(byVariant).map(([v, s]) => [v, { [m]: s }]));

describe("assignment", () => {
  const users = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
  const shares = (fw: ABTestingFramework, variantIds: string[], n: number) => {
    const count: Record<string, number> = Object.fromEntries(variantIds.map((v) => [v, 0]));
    for (const u of users(n)) count[fw.assignVariant("x", u).variant_id] += 1;
    return Object.fromEntries(variantIds.map((v) => [v, count[v] / n]));
  };
  const open = (exp: any) => {
    const fw = new ABTestingFramework(noExperimentsFile);
    fw.createExperiment(exp);
    return fw;
  };

  it("keeps every sticky assignment of an experiment with two variants (recorded from the previous implementation)", () => {
    const bad: string[] = [];
    for (const c of assignGolden.cases) {
      const fw = new ABTestingFramework(noExperimentsFile);
      fw.createExperiment({ ...experiment(["A", "B"], []), id: c.experiment, traffic_split: c.split });
      const got = assignGolden.users.map((u) => fw.assignVariant(c.experiment, u).variant_id).join("");
      if (got !== c.assigned) bad.push(`split ${c.split} ${c.experiment}`);
    }
    expect(assignGolden.cases.length).toBe(27);
    expect(bad).toEqual([]);
  });

  it("is sticky: the same user lands on the same variant, for any number of variants", () => {
    for (const n of [3, 5, 10]) {
      const fw = open(experiment(ids(n), []));
      for (const u of users(200)) expect(fw.assignVariant("x", u).variant_id).toBe(fw.assignVariant("x", u).variant_id);
    }
  });

  it("splits traffic equally over more than two variants", () => {
    for (const n of [3, 10]) {
      const s = shares(open(experiment(ids(n), [])), ids(n), 60000);
      for (const v of ids(n)) expect({ n, v, off: Math.abs(s[v] - 1 / n) < 0.01 }).toEqual({ n, v, off: true });
    }
  });

  it("splits traffic by weights, which override traffic_split", () => {
    const s = shares(open(experiment(["A", "B", "C"], [], { weights: [1, 2, 1] })), ["A", "B", "C"], 30000);
    expect(Math.abs(s.A - 0.25)).toBeLessThan(0.012);
    expect(Math.abs(s.B - 0.5)).toBeLessThan(0.012);
    expect(Math.abs(s.C - 0.25)).toBeLessThan(0.012);
    const two = shares(open(experiment(["A", "B"], [], { weights: [1, 3], traffic_split: 0.5 })), ["A", "B"], 30000);
    expect(Math.abs(two.A - 0.25)).toBeLessThan(0.012);
  });

  it("reads weights as relative: [1, 2, 1] and [3, 6, 3] assign every user identically", () => {
    const a = open(experiment(["A", "B", "C"], [], { weights: [1, 2, 1] }));
    const b = open(experiment(["A", "B", "C"], [], { weights: [3, 6, 3] }));
    const differ = users(5000).filter((u) => a.assignVariant("x", u).variant_id !== b.assignVariant("x", u).variant_id);
    expect(differ).toEqual([]);
  });

  it("reaches every variant without a user id (random assignment)", () => {
    const fw = open(experiment(ids(4), []));
    const seen = new Set(Array.from({ length: 400 }, () => fw.assignVariant("x").variant_id));
    expect([...seen].sort()).toEqual(ids(4));
  });
});

describe("validation", () => {
  const create = (exp: any) => new ABTestingFramework(noExperimentsFile).createExperiment(exp);

  it("accepts two to ten variants and rejects anything else", () => {
    for (const n of [2, 3, 10]) expect(() => create(experiment(ids(n), []))).not.toThrow();
    for (const n of [0, 1, 11]) expect(() => create(experiment(ids(n), []))).toThrow("between 2 and 10 variants");
  });

  it("rejects an empty or duplicate variant id when there are more than two", () => {
    expect(() => create(experiment(["A", "B", "A"], []))).toThrow("Duplicate variant id: A");
    expect(() => create(experiment(["A", "B", ""], []))).toThrow("non-empty string id");
    expect(() => create({ ...experiment(["A", "B", "C"], []), variants: [{ id: "A" }, { id: "B" }, { name: "no id" }] })).toThrow("non-empty string id");
  });

  it("rejects the same for a NEW two-variant experiment (audit AB-2), but a stored one written before still loads", () => {
    // Created now: duplicate ids merge both arms, missing ids leave assign_variant with no variant to return.
    expect(() => create(experiment(["A", "A"], [metric("m")]))).toThrow("Duplicate variant id: A");
    expect(() => create(experiment(["A", ""], [metric("m")]))).toThrow("Variant id must be a non-empty string");
    expect(() => create({ ...experiment(["A", "B"], [metric("m")]), variants: [{ name: "x" }, { name: "y" }] })).toThrow("Variant id must be a non-empty string");
    expect(() => create({ ...experiment(["A", "B"], [metric("m")]), id: "" })).toThrow("Experiment id must be a non-empty string");
    expect(() => create({ ...experiment(["A", "B"], [metric("m")]), id: "e".repeat(201) })).toThrow("longer than 200 characters");
    expect(() => create(experiment(["A", "B"], [metric("m"), metric("m")]))).toThrow("Duplicate metric id: m");
    expect(() => create(experiment(["A", "B"], [metric("")]))).toThrow("Metric id must be a non-empty string");
    // "__proto__" as an id makes the variant (or metric) vanish from the results, so it cannot be created.
    expect(() => create(experiment(["A", "__proto__"], [metric("m")]))).toThrow('Variant id cannot be "__proto__"');
    expect(() => create(experiment(["A", "B"], [metric("__proto__")]))).toThrow('Metric id cannot be "__proto__"');
    expect(() => create({ ...experiment(["A", "B"], [metric("m")]), hypothesis: "h".repeat(70 * 1024) })).toThrow("larger than 64 KB");
    // What the old rule was really protecting: a data file written before must still load. Replay does not use these checks.
    const file = path.join(tmp, "legacy-two-variant.jsonl");
    const legacy = { ...experiment(["A", "A"], [metric("m")]), id: "legacy" };
    fs.writeFileSync(file, JSON.stringify({ type: "experiment", experiment: legacy }) + "\n");
    const fw = new ABTestingFramework(noExperimentsFile, file);
    try {
      expect(fw.listExperiments().map((e) => e.id)).toEqual(["legacy"]);
    } finally {
      fw.close();
    }
  });

  it("keeps only the fields the module uses (anything else would be stored in the log for good)", () => {
    const file = path.join(tmp, "whitelist.jsonl");
    const fw = new ABTestingFramework(noExperimentsFile, file);
    try {
      fw.createExperiment({ ...experiment(["A", "B"], [metric("m")]), id: "w", results: { junk: true }, notes: "x".repeat(1000), primary_metric: "m", weights: [1, 3] });
      const stored = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n")[0]).experiment;
      expect(Object.keys(stored).sort()).toEqual(["hypothesis", "id", "metrics", "name", "primary_metric", "status", "traffic_split", "variants", "weights"]);
      expect(stored.status).toBe("setup");
    } finally {
      fw.close();
    }
  });

  it("rejects weights that are not one positive number per variant", () => {
    for (const weights of [[1, 2], [1, 2, 3, 4], [1, 0, 1], [1, -1, 1], [1, Infinity, 1], [1, NaN, 1], ["1", 2, 3], 5, "1,2,3"]) {
      expect({ weights, rejected: (() => { try { create(experiment(["A", "B", "C"], [], { weights })); return false; } catch { return true; } })() }).toEqual({ weights, rejected: true });
    }
    expect(() => create(experiment(["A", "B", "C"], [], { weights: [1, 2, 3] }))).not.toThrow();
    expect(() => create(experiment(["A", "B"], [], { weights: [1, 3] }))).not.toThrow();
  });
});

describe("holmAdjust", () => {
  it("matches the textbook step-down values", () => {
    // sorted 0.01, 0.03, 0.04 -> 3*0.01, max(.03, 2*0.03), max(.06, 1*0.04)
    expect(holmAdjust([0.01, 0.04, 0.03]).map((x) => +x.toFixed(10))).toEqual([0.03, 0.06, 0.06]);
  });
  it("leaves a single p-value unchanged, caps at 1, and never lowers a p-value", () => {
    expect(holmAdjust([0.037])).toEqual([0.037]);
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
    for (const p of [[0.2, 0.001, 0.5, 0.04], [0.05, 0.05, 0.05], [1, 1], [0, 0.5]]) {
      const adj = holmAdjust(p);
      p.forEach((v, i) => {
        expect(adj[i]).toBeGreaterThanOrEqual(v);
        expect(adj[i]).toBeLessThanOrEqual(1);
      });
    }
  });
  it("keeps the order of the p-values (a smaller p never gets a larger adjusted value)", () => {
    const p = [0.2, 0.001, 0.5, 0.04, 0.04, 0.9];
    const adj = holmAdjust(p);
    for (let i = 0; i < p.length; i++) for (let j = 0; j < p.length; j++) if (p[i] < p[j]) expect(adj[i]).toBeLessThanOrEqual(adj[j]);
  });
});

describe("results with more than two variants", () => {
  const q = [metric("quality")];

  it("names the one variant that is significantly better than every other, and reports every pair", () => {
    const { results, recommendation } = run(experiment(ids(3), q), shifts({ A: 0, B: 0, C: 1 }));
    expect(results.winner).toBe("C");
    expect(recommendation).toBe("C");
    const a = results.statistical_analysis;
    expect(a.p_values).toBeUndefined(); // the flat maps are the two-variant shape
    expect(a.primary_metric).toBe("quality");
    expect(a.correction).toContain("Holm");
    expect(a.comparisons.map((c: any) => `${c.a}${c.b}`)).toEqual(["AB", "AC", "BC"]);
    expect(a.comparisons.find((c: any) => c.a === "A" && c.b === "B")).toMatchObject({ p_value: 1, better: null });
    expect(a.comparisons.find((c: any) => c.a === "A" && c.b === "C")).toMatchObject({ better: "C" });
    // the confidence is that of the leader's weakest comparison, adjusted
    const mine = a.comparisons.filter((c: any) => c.a === "C" || c.b === "C");
    expect(results.confidence).toBe(parseFloat((1 - Math.max(...mine.map((c: any) => c.adjusted_p_value))).toFixed(4)));
    expect(Object.keys(results.variant_results)).toEqual(["A", "B", "C"]);
  });

  it("reports the confidence of the leader's WEAKEST comparison (the one against the closest rival), not the strongest", () => {
    // C beats A by 1.0 and B by 0.5, so the two comparisons have very different p-values.
    const { results } = run(experiment(ids(3), q), shifts({ A: 0, B: 0.5, C: 1 }), { n: 120 });
    const mine = results.statistical_analysis.comparisons.filter((c: any) => c.a === "C" || c.b === "C");
    const adjusted = mine.map((c: any) => c.adjusted_p_value);
    expect(Math.max(...adjusted)).toBeGreaterThan(Math.min(...adjusted) * 100); // the two differ by orders of magnitude
    expect(results.confidence).toBe(parseFloat((1 - Math.max(...adjusted)).toFixed(4)));
    expect(results.confidence).toBeLessThan(parseFloat((1 - Math.min(...adjusted)).toFixed(4)));
    expect(results.winner).toBe("C");
  });

  it("names no winner when the two best variants cannot be told apart", () => {
    const { results, recommendation } = run(experiment(ids(3), q), shifts({ A: 0, B: 1, C: 1 }));
    expect(results.winner).toBeUndefined();
    expect(recommendation).toBe("No clear winner");
    expect(results.statistical_analysis.comparisons.find((c: any) => c.a === "B" && c.b === "C").p_value).toBe(1);
  });

  it("uses Holm's correction: a leader that beats each rival at p about 0.03 wins against one rival but not against two", () => {
    const s = 0.153; // with 400 paired measurements this gives a raw p of about 0.03 against each rival
    const two = run(experiment(["A", "B"], q), shifts({ A: 0, B: s }), { n: 400 });
    const three = run(experiment(ids(3), q), shifts({ A: 0, B: s, C: 0 }), { n: 400 });
    const rawTwo = two.results.statistical_analysis.p_values.quality;
    expect(rawTwo).toBeGreaterThan(1 / 60); // above the 0.05 / 3 that three comparisons would need
    expect(rawTwo).toBeLessThan(0.05);
    expect(two.results.winner).toBe("B");
    const vsRivals = three.results.statistical_analysis.comparisons.filter((c: any) => c.a === "B" || c.b === "B");
    for (const c of vsRivals) {
      expect(c.p_value).toBeLessThan(0.05); // significant on its own ...
      expect(c.adjusted_p_value).toBeGreaterThanOrEqual(0.05); // ... but not after correcting for three comparisons
    }
    expect(three.results.winner).toBeUndefined();
  });

  it("applies each metric's direction: the lowest mean wins on a lower_is_better primary metric", () => {
    const exp = experiment(ids(4), [metric("cost", { direction: "lower_is_better" })]);
    expect(run(exp, shifts({ A: 0, B: 0, C: -1, D: 0 }, "cost")).results.winner).toBe("C");
    expect(run(experiment(ids(4), [metric("cost")]), shifts({ A: 0, B: 0, C: -1, D: 0 }, "cost")).results.winner).toBeUndefined(); // higher is better: C is the worst
  });

  it("stays incomplete until every variant has 30 measurements, and lists the counts", () => {
    const { results } = run(experiment(ids(3), q), shifts({ A: 0, B: 0, C: 1 }), { counts: { C: 20 } });
    expect(results.status).toBe("incomplete");
    expect(results.statistical_analysis.samples_per_variant).toEqual({ A: 60, B: 60, C: 20 });
  });

  it("names no winner when a variant has no data on the primary metric (it cannot be compared with)", () => {
    const { results } = run(experiment(ids(3), q), shifts({ A: 0, B: 0, C: 1 }), { skip: { C: ["quality"] } });
    expect(results.status).toBe("complete");
    expect(results.winner).toBeUndefined();
    expect(results.confidence).toBe(0);
  });

  it("is symmetric under negating the data and flipping the direction (25 random three-variant datasets)", () => {
    const bad: string[] = [];
    const winners: string[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed * 104729);
      const sh = { A: 0, B: (r() - 0.5) * 3, C: (r() - 0.5) * 3 }; // far enough apart that many datasets have a winner
      const n = 50 + Math.floor(r() * 40);
      const direct = new ABTestingFramework(noExperimentsFile);
      const negated = new ABTestingFramework(noExperimentsFile);
      direct.createExperiment(experiment(ids(3), [metric("m")]));
      negated.createExperiment(experiment(ids(3), [metric("m", { direction: "lower_is_better" })]));
      const rr = rng(seed);
      for (let i = 0; i < n; i++) {
        const z = normal(rr);
        for (const v of ids(3)) {
          const x = 10 + (sh as any)[v] + z * (v === "C" ? 1.3 : 1);
          direct.recordMetric("x", v, { m: x });
          negated.recordMetric("x", v, { m: -x });
        }
      }
      const a = direct.getExperimentResults("x")!;
      const b = negated.getExperimentResults("x")!;
      const strip = (res: any) => res.statistical_analysis.comparisons.map((c: any) => [c.a, c.b, c.p_value, c.adjusted_p_value]);
      if (a.winner !== b.winner || a.confidence !== b.confidence || JSON.stringify(strip(a)) !== JSON.stringify(strip(b))) bad.push(`seed ${seed}: ${a.winner}/${b.winner}`);
      if (a.winner) winners.push(a.winner);
    }
    expect(bad).toEqual([]);
    // not vacuous: many datasets have a winner, and each variant wins some
    expect(winners.length).toBeGreaterThanOrEqual(10);
    expect([...new Set(winners)].sort()).toEqual(["A", "B", "C"]);
  });

  it("names the same winner whatever order the variants are listed in (all six orders of three)", () => {
    const base = shifts({ A: 0, B: 0.2, C: 1 });
    const reference = run(experiment(["A", "B", "C"], q), base);
    expect(reference.results.winner).toBe("C");
    for (const order of [["A", "C", "B"], ["B", "A", "C"], ["B", "C", "A"], ["C", "A", "B"], ["C", "B", "A"]]) {
      const got = run(experiment(order, q), base);
      expect({ order, winner: got.results.winner, confidence: got.results.confidence }).toEqual({ order, winner: "C", confidence: reference.results.confidence });
    }
  });
});

describe("guardrails with more than two variants", () => {
  const exp = (extra: Record<string, unknown> = {}) =>
    experiment(ids(3), [metric("cost", { direction: "lower_is_better" }), metric("quality", { guardrail: true })], extra);
  const two = (cost: Record<string, number>, quality: Record<string, number>) =>
    Object.fromEntries(ids(3).map((v) => [v, { cost: cost[v], quality: quality[v] }]));

  it("compares the leader with every other variant, and reports each comparison", () => {
    const { results } = run(exp(), two({ A: 0, B: 0, C: -1 }, { A: 0, B: 0, C: 0 }));
    expect(results.winner).toBe("C");
    expect(results.statistical_analysis.guardrails.quality).toMatchObject({ leader: "C" });
    expect(results.statistical_analysis.guardrails.quality.comparisons.map((c: any) => [c.against, c.p_value, c.leader_significantly_worse])).toEqual([
      ["A", 1, false],
      ["B", 1, false],
    ]);
  });

  it("withholds the winner when it is significantly worse than even one other variant on a guardrail", () => {
    const { results, recommendation } = run(exp(), two({ A: 0, B: 0, C: -1 }, { A: 0, B: 1, C: 0 })); // C is cheapest, but B has better quality
    expect(results.winner).toBeUndefined();
    expect(results.statistical_analysis.winner_withheld_by).toEqual(["quality"]);
    const bad = results.statistical_analysis.guardrails.quality.comparisons.filter((c: any) => c.leader_significantly_worse);
    expect(bad.map((c: any) => c.against)).toEqual(["B"]);
    expect(recommendation).toBe("No clear winner (withheld by guardrail: quality)");
  });

  it("keeps the winner when the guardrail is better for it than for the others", () => {
    const { results } = run(exp(), two({ A: 0, B: 0, C: -1 }, { A: 0, B: 0, C: 1 }));
    expect(results.winner).toBe("C");
  });

  it("withholds the winner when the guardrail has no data for some variant", () => {
    const { results } = run(exp(), two({ A: 0, B: 0, C: -1 }, { A: 0, B: 0, C: 0 }), { skip: { B: ["quality"] } });
    expect(results.winner).toBeUndefined();
    expect(results.statistical_analysis.winner_withheld_by).toEqual(["quality"]);
    expect(results.statistical_analysis.guardrails.quality.comparisons.find((c: any) => c.against === "B").p_value).toBeNull();
  });
});

describe("persistence", () => {
  it("keeps variants and weights across a restart, with identical results and assignments live and replayed", () => {
    const file = path.join(tmp, "variants.jsonl");
    const live = new ABTestingFramework(noExperimentsFile, file);
    live.createExperiment(experiment(ids(3), [metric("quality")], { weights: [1, 2, 1] }));
    fill(live, shifts({ A: 0, B: 0, C: 1 }));
    const snapshot = (fw: ABTestingFramework) =>
      JSON.stringify({ r: fw.getExperimentResults("x"), w: fw.recommendWinner("x"), a: Array.from({ length: 300 }, (_, i) => fw.assignVariant("x", `u${i}`).variant_id) });
    const before = snapshot(live);
    live.close();
    const replayed = new ABTestingFramework(noExperimentsFile, file);
    try {
      expect(snapshot(replayed)).toBe(before);
      expect(JSON.parse(before).r.winner).toBe("C");
    } finally {
      replayed.close();
    }
  });
});
