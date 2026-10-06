/**
 * Deterministic A/B datasets for the golden-master test (tests/ab-golden.test.ts).
 *
 * Only integer arithmetic, +, -, * and / are used to make the numbers (no Math.log/sin/cos, whose last digits can differ
 * between engines), so the same seed gives the same measurements everywhere. Values are rounded to a fixed number of
 * decimals, like real metrics.
 */

export interface GoldenMeasurement {
  variant_id: string;
  metrics: Record<string, number>;
}

export interface GoldenDataset {
  name: string;
  experiment: {
    id: string;
    name: string;
    hypothesis: string;
    status: "setup";
    traffic_split: number;
    variants: Array<{ id: string; name: string; config: Record<string, never> }>;
    metrics: Array<{ id: string; name: string; type: string; aggregation: string }>;
  };
  measurements: GoldenMeasurement[];
}

/** mulberry32: a 32-bit PRNG that needs only Math.imul and shifts. Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
};

/** Irwin-Hall: the sum of 12 uniforms minus 6 is close to a standard normal. */
const bell = (r: () => number): number => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += r();
  return s - 6;
};

type Shape = "bell" | "constant" | "two-valued" | "integers" | "heavy-tail" | "offset" | "tiny" | "negative";
const SHAPES: Shape[] = ["bell", "constant", "two-valued", "integers", "heavy-tail", "offset", "tiny", "negative"];

function value(shape: Shape, shift: number, r: () => number): number {
  switch (shape) {
    case "bell":
      return round(50 + shift + bell(r) * 10, 3);
    case "constant":
      return round(7 + shift, 1);
    case "two-valued":
      return r() < 0.5 ? 1 + shift : 2;
    case "integers":
      return Math.floor(r() * 10) + shift;
    case "heavy-tail": {
      const u = r();
      return round(10 + shift + (u < 0.97 ? bell(r) : bell(r) * 40), 2);
    }
    case "offset":
      return round(1e9 + shift * 100 + bell(r) * 3, 3);
    case "tiny":
      return round(1e-4 + shift * 1e-5 + bell(r) * 1e-5, 9);
    case "negative":
      return round(-20 + shift + bell(r) * 5, 3);
  }
}

function build(
  name: string,
  metricIds: string[],
  counts: [number, number],
  gen: (metric: string, variant: 0 | 1, r: () => number) => number | undefined,
  seed: number
): GoldenDataset {
  const r = rng(seed);
  const variantIds = ["control", "treatment"];
  const measurements: GoldenMeasurement[] = [];
  // Interleave the variants the way live traffic would, with the leftover of the longer one at the end.
  const longest = Math.max(counts[0], counts[1]);
  for (let i = 0; i < longest; i++) {
    for (const v of [0, 1] as const) {
      if (i >= counts[v]) continue;
      const metrics: Record<string, number> = {};
      for (const m of metricIds) {
        const x = gen(m, v, r);
        if (x !== undefined) metrics[m] = x;
      }
      measurements.push({ variant_id: variantIds[v], metrics });
    }
  }
  return {
    name,
    experiment: {
      id: `exp-${name}`,
      name,
      hypothesis: "golden",
      status: "setup", // what createExperiment records
      traffic_split: 0.5,
      variants: variantIds.map((id) => ({ id, name: id.toUpperCase(), config: {} })),
      metrics: metricIds.map((id) => ({ id, name: id, type: "continuous", aggregation: "mean" })),
    },
    measurements,
  };
}

/** Hand-picked situations: each exercises one branch of the statistics. */
export function namedDatasets(): GoldenDataset[] {
  const bellGen = (shift: number) => (_m: string, v: 0 | 1, r: () => number) => value("bell", v === 1 ? shift : 0, r);
  return [
    build("clear-winner-treatment", ["conv", "rev"], [300, 300], bellGen(8), 1),
    build("clear-winner-control", ["conv", "rev"], [300, 300], bellGen(-8), 2),
    build("no-difference", ["conv"], [400, 400], bellGen(0), 3),
    build("below-total-minimum", ["conv"], [49, 50], bellGen(5), 4),
    build("exactly-total-minimum", ["conv"], [50, 50], bellGen(5), 5),
    build("one-variant-below-minimum", ["conv"], [99, 29], bellGen(5), 6),
    build("one-variant-at-minimum", ["conv"], [200, 30], bellGen(5), 7),
    build("constant-equal", ["conv"], [60, 60], (_m, _v, r) => value("constant", 0, r), 8),
    build("constant-different", ["conv"], [60, 60], (_m, v, r) => value("constant", v === 1 ? 1 : 0, r), 9),
    build("constant-inexact-float", ["conv"], [60, 60], () => 0.1, 10),
    build("unbalanced", ["conv", "rev"], [5000, 60], bellGen(3), 11),
    build(
      "metric-missing-on-some",
      ["conv", "rev", "never"],
      [200, 200],
      (m, v, r) => (m === "never" ? undefined : m === "rev" && r() < 0.6 ? undefined : value("bell", v === 1 ? 4 : 0, r)),
      12
    ),
    build(
      "metric-seen-once-per-variant",
      ["conv", "rare"],
      [100, 100],
      (m, v, r) => (m === "rare" ? (r() < 0.01 ? 5 + v : undefined) : value("bell", 0, r)),
      13
    ),
    build("metric-seen-in-one-variant-only", ["conv", "only-a"], [100, 100], (m, v, r) => (m === "only-a" && v === 1 ? undefined : value("bell", 0, r)), 14),
    build("large-offset", ["conv"], [150, 150], (_m, v, r) => value("offset", v === 1 ? 1 : 0, r), 15),
    build("tiny-scale", ["conv"], [150, 150], (_m, v, r) => value("tiny", v === 1 ? 1 : 0, r), 16),
    build("negative-values", ["conv"], [150, 150], (_m, v, r) => value("negative", v === 1 ? 2 : 0, r), 17),
    build("heavy-tail", ["conv"], [200, 200], (_m, v, r) => value("heavy-tail", v === 1 ? 1 : 0, r), 18),
    build("two-valued", ["conv"], [200, 200], (_m, v, r) => value("two-valued", 0, r), 19),
    build("no-metrics-on-measurements", ["conv"], [80, 80], () => undefined, 20),
  ];
}

/** Randomised experiments: a different mix of sizes, shapes and missing metrics per seed. */
export function fuzzDataset(seed: number): GoldenDataset {
  const r = rng(seed * 7919 + 13);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const metricCount = 1 + Math.floor(r() * 3);
  const metricIds = Array.from({ length: metricCount }, (_, i) => `m${i}`);
  const sizes = [0, 1, 5, 29, 30, 31, 50, 99, 100, 150, 150, 400, 400, 400];
  const counts: [number, number] = [pick(sizes), pick(sizes)];
  const shapes = metricIds.map(() => pick(SHAPES));
  const shift = pick([0, 0, 1, 3, 10]);
  const presence = pick([1, 1, 0.9, 0.5, 0.05]);
  return build(
    `fuzz-${seed}`,
    metricIds,
    counts,
    (m, v, rr) => {
      if (rr() >= presence) return undefined;
      return value(shapes[metricIds.indexOf(m)], v === 1 ? shift : 0, rr);
    },
    seed
  );
}

/** The data file the server would have written for this dataset (one experiment line, then the measurements). */
export function toJsonl(d: GoldenDataset): string {
  const lines = [JSON.stringify({ type: "experiment", experiment: d.experiment })];
  d.measurements.forEach((m, i) =>
    lines.push(
      JSON.stringify({
        type: "measurement",
        experiment_id: d.experiment.id,
        variant_id: m.variant_id,
        metrics: m.metrics,
        timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      })
    )
  );
  return lines.join("\n") + "\n";
}
