import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ABTestingFramework } from "../features/08-ab-testing/src/mcp-server";

/**
 * What a new write may carry and what a tool call must look like (audit findings AB-3 to AB-7). Found by probing:
 * a single finite 1.7e308 made the mean 2.8e306 and the deviation, interval, p-value and confidence null for good (the log is
 * append-only, so nothing can undo it); metrics of null, an array or an unknown id were accepted and stored; an unknown experiment
 * answered with the text "null"; an object user id put every such caller in one bucket; and the 95% interval of a metric with few
 * values was far too narrow (df 1: 4.33 against 12.71).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-ab-inputs-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const none = path.join(tmp, "none.yaml");
let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

const exp = (id = "e"): any => ({
  id, name: id, hypothesis: "h", status: "setup", traffic_split: 0.5,
  variants: [{ id: "A", name: "A", config: {} }, { id: "B", name: "B", config: {} }],
  metrics: [{ id: "cost", name: "cost", type: "continuous", aggregation: "mean", direction: "lower_is_better" }, { id: "quality", name: "quality", type: "continuous", aggregation: "mean" }],
});

describe("record_metric limits (AB-3)", () => {
  it("rejects a value that would spoil the statistics for good, and accepts the largest allowed", () => {
    const fw = new ABTestingFramework(none);
    fw.createExperiment(exp());
    for (const bad of [1.7e308, -1.7e308, 1e15 + 1e3, -1e16]) {
      expect(() => fw.recordMetric("e", "A", { cost: bad })).toThrow("must be between -1e15 and 1e15");
    }
    expect(() => fw.recordMetric("e", "A", { cost: 1e15 })).not.toThrow();
    expect(() => fw.recordMetric("e", "A", { cost: -1e15 })).not.toThrow();
    expect(() => fw.recordMetric("e", "A", { cost: Infinity })).toThrow("finite number");
    expect(() => fw.recordMetric("e", "A", { cost: NaN })).toThrow("finite number");
    expect(() => fw.recordMetric("e", "A", { cost: "5" as any })).toThrow("finite number");
  });

  it("an experiment with the largest allowed values still gives finite statistics", () => {
    const fw = new ABTestingFramework(none);
    fw.createExperiment(exp());
    for (let i = 0; i < 60; i++) {
      fw.recordMetric("e", "A", { cost: 1e15 - i });
      fw.recordMetric("e", "B", { cost: -1e15 + i * 2 });
    }
    const r: any = fw.getExperimentResults("e");
    expect(r.status).toBe("complete");
    const text = JSON.stringify(r);
    expect(text).not.toContain("null");
    expect(Number.isFinite(r.variant_results.A.metrics.cost.mean)).toBe(true);
    expect(Number.isFinite(r.variant_results.A.metrics.cost.std_dev)).toBe(true);
  });

  it("a rejected value is not written to the data file", () => {
    const file = path.join(tmp, "rejected.jsonl");
    const fw = new ABTestingFramework(none, file);
    try {
      fw.createExperiment(exp("r"));
      const before = fs.readFileSync(file, "utf8");
      expect(() => fw.recordMetric("r", "A", { cost: 1e300 })).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    } finally {
      fw.close();
    }
  });
});

describe("record_metric rejects a metric the experiment does not define (AB-5)", () => {
  it("names the metrics it does define", () => {
    const fw = new ABTestingFramework(none);
    fw.createExperiment(exp());
    expect(() => fw.recordMetric("e", "A", { cost_usd: 1 })).toThrow("Unknown metric cost_usd for experiment e: its metrics are cost, quality");
    expect(() => fw.recordMetric("e", "A", { cost: 1, qualty: 2 })).toThrow("Unknown metric qualty");
    expect(() => fw.recordMetric("e", "A", { cost: 1, quality: 2 })).not.toThrow();
    expect(() => fw.recordMetric("e", "A", { cost: 1 })).not.toThrow(); // a measurement may carry only some of the metrics
  });

  it("a rejected measurement is not counted as a sample", () => {
    const fw = new ABTestingFramework(none);
    fw.createExperiment(exp());
    expect(() => fw.recordMetric("e", "A", { typo: 1 })).toThrow();
    expect(fw.listExperiments()[0].sample_count).toBe(0);
  });
});

describe("tool boundary (AB-4, AB-5)", () => {
  let tool: typeof import("../features/08-ab-testing/src/mcp-server");
  beforeAll(() => {
    process.env.EXPERIMENTS_FILE = path.join(tmp, "tool-none.yaml");
    delete process.env.AB_DATA_FILE;
    jest.isolateModules(() => {
      tool = require("../features/08-ab-testing/src/mcp-server");
    });
  });
  afterAll(() => {
    delete process.env.EXPERIMENTS_FILE;
  });
  const call = async (name: string, input: any) => JSON.parse(await tool.processToolCall(name, input));

  it("answers an unknown experiment with an error, never the text null", async () => {
    expect(await call("get_experiment_results", { experiment_id: "nope" })).toEqual({ error: "Experiment not found: nope" });
    expect(await call("recommend_winner", { experiment_id: "nope" })).toEqual({ error: "Experiment not found: nope" });
    expect(await call("assign_variant", { experiment_id: "nope" })).toEqual({ error: "Experiment not found: nope" });
  });

  it("checks the type of the identifiers", async () => {
    for (const name of ["assign_variant", "record_metric", "get_experiment_results", "recommend_winner"]) {
      expect(await call(name, {})).toEqual({ error: "experiment_id must be a string" });
      expect(await call(name, { experiment_id: 5 })).toEqual({ error: "experiment_id must be a string" });
    }
    expect(await call("record_metric", { experiment_id: "x", metrics: {} })).toEqual({ error: "variant_id must be a string" });
  });

  it("requires metrics to be an object, not null, an array or a scalar", async () => {
    await call("create_experiment", exp("t1"));
    for (const metrics of [null, undefined, [1, 2], 5, "cost=1", true]) {
      expect(await call("record_metric", { experiment_id: "t1", variant_id: "A", metrics })).toEqual({
        error: 'metrics must be an object of numbers, such as {"cost": 0.02}',
      });
    }
    expect(await call("record_metric", { experiment_id: "t1", variant_id: "A", metrics: { cost: 0.02 } })).toEqual({ status: "recorded" });
  });

  it("takes a string or a number as the user id, and nothing else", async () => {
    await call("create_experiment", exp("t2"));
    const byString = await call("assign_variant", { experiment_id: "t2", user_id: "42" });
    const byNumber = await call("assign_variant", { experiment_id: "t2", user_id: 42 });
    expect(byNumber).toEqual(byString); // 42 and "42" are the same user
    for (const user_id of [{ a: 1 }, [1], true]) {
      expect(await call("assign_variant", { experiment_id: "t2", user_id })).toEqual({ error: "user_id must be a string or a number" });
    }
    expect((await call("assign_variant", { experiment_id: "t2", user_id: null })).variant_id).toMatch(/^[AB]$/);
    expect((await call("assign_variant", { experiment_id: "t2" })).variant_id).toMatch(/^[AB]$/);
  });

  it("create_experiment returns a plain error for a malformed definition, and creates nothing", async () => {
    expect((await call("create_experiment", { ...exp("dupe"), variants: [{ id: "A" }, { id: "A" }] })).error).toBe("Duplicate variant id: A");
    expect((await call("get_experiment_results", { experiment_id: "dupe" })).error).toBe("Experiment not found: dupe");
  });
});

// An independent exact Student-t quantile (regularised incomplete beta by continued fraction, then bisection). Nothing is shared with
// the module, so a wrong entry in its table cannot hide behind the same mistake here.
function lgamma(x: number): number {
  const c = [76.1800917294715, -86.5053203294168, 24.0140982408309, -1.23173957245015, 1.208650973866179e-3, -5.395239384953e-6];
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (let j = 0; j < 6; j++) s += c[j] / ++y;
  return -t + Math.log((2.5066282746310007 * s) / x);
}
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
const twoSidedP = (t: number, df: number) => ibeta(df / 2, 0.5, df / (df + t * t));
function exactCritical95(df: number): number {
  let lo = 0, hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (twoSidedP(mid, df) > 0.05) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

describe("the 95% interval of a metric with few values (AB-7)", () => {
  const interval = (n: number) => {
    const fw = new ABTestingFramework(none);
    fw.createExperiment(exp("ci"));
    // 60 records per arm without the metric carry the experiment over the sample gates; then n values per arm with a known spread.
    for (let i = 0; i < 60; i++) { fw.recordMetric("ci", "A", {}); fw.recordMetric("ci", "B", {}); }
    for (let i = 0; i < n; i++) { fw.recordMetric("ci", "A", { quality: i % 2 === 0 ? 9 : 11 }); fw.recordMetric("ci", "B", { quality: i % 2 === 0 ? 4 : 6 }); }
    const m = (fw.getExperimentResults("ci") as any).variant_results.A.metrics.quality;
    return { width: m.ci_95[1] - m.ci_95[0], std: m.std_dev, n: m.sample_size as number };
  };

  it("the oracle agrees with the textbook (so the check below can be trusted)", () => {
    expect(exactCritical95(1)).toBeCloseTo(12.7062, 3);
    expect(exactCritical95(10)).toBeCloseTo(2.2281, 3);
    expect(exactCritical95(29)).toBeCloseTo(2.0452, 3);
  });

  it("uses the exact t critical value for every sample size from 2 to 30 values", () => {
    for (let n = 2; n <= 30; n++) {
      const { width, std, n: size } = interval(n);
      expect(size).toBe(n);
      const exact = (2 * exactCritical95(n - 1) * std) / Math.sqrt(n);
      // The module's mean and spread are rounded to 4 places in the result, so the width is compared within that rounding.
      expect({ n, off: Math.abs(width - exact) < 3e-4 * Math.max(1, exact) }).toEqual({ n, off: true });
    }
  });

  it("from 31 values up the interval is the formula the stored answers were made with (within its own approximation)", () => {
    for (const n of [31, 61, 200]) {
      const { width, std } = interval(n);
      const z = 1.96;
      const formula = z + (z ** 3 + z) / (4 * (n - 1));
      expect(Math.abs(width - (2 * formula * std) / Math.sqrt(n))).toBeLessThan(2e-4 * Math.max(1, width));
      const exact = (2 * exactCritical95(n - 1) * std) / Math.sqrt(n);
      expect(Math.abs(width - exact) / exact).toBeLessThan(0.002); // and it is within 0.2% of the exact interval there
    }
  });
});
