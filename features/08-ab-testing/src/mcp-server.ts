import * as fs from "fs";
import * as yaml from "yaml";

interface Variant {
  id: string;
  name: string;
  config: Record<string, any>;
}

interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  status: "setup" | "running" | "complete";
  variants: Variant[];
  traffic_split: number;
  metrics: Array<{
    id: string;
    name: string;
    type: string;
    aggregation: string;
  }>;
  results?: ExperimentResults;
}

interface ExperimentResults {
  status: "incomplete" | "complete";
  variant_results: Record<string, any>;
  statistical_analysis: Record<string, any>;
  winner?: string;
  confidence: number;
}

// FNV-1a + murmur3 finalizer, mapped to [0, 1) so a given user always lands in the same bucket.
function bucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // murmur3 finalizer: FNV alone mixes the high bits poorly for sequential ids.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const MIN_TOTAL_SAMPLES = 100;
const MIN_SAMPLES_PER_VARIANT = 30;
const SIGNIFICANCE_LEVEL = 0.05;

// Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7).
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

// Two-sided p-value for a t statistic. Converts t to an approximate z score
// (accurate for df >= ~25, which the per-variant sample minimum guarantees).
function twoSidedPValue(t: number, df: number): number {
  if (!isFinite(t)) return 0;
  const z = (Math.abs(t) * (1 - 1 / (4 * df))) / Math.sqrt(1 + (t * t) / (2 * df));
  return Math.min(1, erfc(z / Math.SQRT2));
}

// Approximate two-sided 95% t critical value.
function tCritical95(df: number): number {
  const z = 1.96;
  return z + (z * z * z + z) / (4 * df);
}

function sampleStats(values: number[]) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance, std: Math.sqrt(variance) };
}

class ABTestingFramework {
  private experiments: Map<string, Experiment> = new Map();
  private measurements: Array<{
    experiment_id: string;
    variant_id: string;
    metrics: Record<string, number>;
    timestamp: string;
  }> = [];
  private experimentsFile: string;

  constructor(experimentsFile: string = "./experiments.yaml") {
    this.experimentsFile = experimentsFile;
    this.loadExperiments();
  }

  private loadExperiments(): void {
    try {
      if (fs.existsSync(this.experimentsFile)) {
        const content = fs.readFileSync(this.experimentsFile, "utf-8");
        const config = yaml.parse(content);

        for (const exp of config.experiments || []) {
          try {
            this.validateExperiment(exp);
            this.experiments.set(exp.id, exp);
          } catch (error: any) {
            console.error(`Skipping invalid experiment: ${error.message}`);
          }
        }
        console.error(`Loaded ${this.experiments.size} experiments`);
      }
    } catch (error) {
      console.error("Error loading experiments:", error);
    }
  }

  private validateExperiment(experiment: Experiment): void {
    if (!experiment || typeof experiment.id !== "string") {
      throw new Error("Experiment must have a string id");
    }
    if (!experiment.variants || experiment.variants.length !== 2) {
      throw new Error("Experiment must have exactly 2 variants");
    }
    if (
      typeof experiment.traffic_split !== "number" ||
      experiment.traffic_split < 0 ||
      experiment.traffic_split > 1
    ) {
      throw new Error("traffic_split must be a number between 0 and 1");
    }
    if (!Array.isArray(experiment.metrics)) {
      throw new Error("Experiment must define a metrics array");
    }
  }

  public createExperiment(experiment: Experiment): void {
    this.validateExperiment(experiment);
    this.experiments.set(experiment.id, {
      ...experiment,
      status: "setup",
    });
  }

  public assignVariant(
    experimentId: string,
    userId?: string
  ): {
    variant_id: string;
    experiment_id: string;
  } {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    // Sticky per user when a user id is given, random otherwise.
    const draw =
      userId !== undefined && userId !== ""
        ? bucket(`${experimentId}:${userId}`)
        : Math.random();
    const variantIndex = draw < experiment.traffic_split ? 0 : 1;
    const selectedVariant = experiment.variants[variantIndex];

    return {
      variant_id: selectedVariant.id,
      experiment_id: experimentId,
    };
  }

  public recordMetric(
    experimentId: string,
    variantId: string,
    metrics: Record<string, number>
  ): void {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }
    if (!experiment.variants.some((v) => v.id === variantId)) {
      throw new Error(`Variant ${variantId} is not part of experiment ${experimentId}`);
    }
    for (const [key, value] of Object.entries(metrics ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Metric ${key} must be a finite number`);
      }
    }
    this.measurements.push({
      experiment_id: experimentId,
      variant_id: variantId,
      metrics,
      timestamp: new Date().toISOString(),
    });
  }

  public getExperimentResults(experimentId: string): ExperimentResults | null {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    // Filter measurements for this experiment
    const expMeasurements = this.measurements.filter(
      (m) => m.experiment_id === experimentId
    );

    if (expMeasurements.length < MIN_TOTAL_SAMPLES) {
      return {
        status: "incomplete",
        variant_results: {},
        statistical_analysis: {
          message: `Need ${MIN_TOTAL_SAMPLES - expMeasurements.length} more samples`,
          current_samples: expMeasurements.length,
        },
        confidence: 0,
      };
    }

    const perVariant = experiment.variants.map(
      (v) => expMeasurements.filter((m) => m.variant_id === v.id).length
    );
    if (perVariant.some((n) => n < MIN_SAMPLES_PER_VARIANT)) {
      return {
        status: "incomplete",
        variant_results: {},
        statistical_analysis: {
          message: `Need at least ${MIN_SAMPLES_PER_VARIANT} samples per variant`,
          current_samples: expMeasurements.length,
          samples_per_variant: Object.fromEntries(
            experiment.variants.map((v, i) => [v.id, perVariant[i]])
          ),
        },
        confidence: 0,
      };
    }

    const [vA, vB] = experiment.variants;
    const variantStats: Record<string, any> = {};
    const pValues: Record<string, number> = {};
    const effectSizes: Record<string, number> = {};
    const meansByMetric: Record<string, [number, number]> = {};

    for (const variant of experiment.variants) {
      variantStats[variant.id] = { name: variant.name, metrics: {} };
    }

    for (const metric of experiment.metrics) {
      const groups = [vA, vB].map((v) =>
        sampleStats(
          expMeasurements
            .filter((m) => m.variant_id === v.id)
            .map((m) => m.metrics[metric.id])
            .filter((x) => x !== undefined)
        )
      );

      [vA, vB].forEach((v, i) => {
        const g = groups[i];
        if (g.n === 0) return;
        const half = g.n > 1 ? (tCritical95(g.n - 1) * g.std) / Math.sqrt(g.n) : 0;
        variantStats[v.id].metrics[metric.id] = {
          mean: parseFloat(g.mean.toFixed(4)),
          std_dev: parseFloat(g.std.toFixed(4)),
          ci_95: [
            parseFloat((g.mean - half).toFixed(4)),
            parseFloat((g.mean + half).toFixed(4)),
          ],
          sample_size: g.n,
        };
      });

      const [g1, g2] = groups;
      if (g1.n < 2 || g2.n < 2) continue;

      meansByMetric[metric.id] = [g1.mean, g2.mean];
      const diff = g1.mean - g2.mean;
      const se2 = g1.variance / g1.n + g2.variance / g2.n;

      // Welch's t-test
      if (se2 === 0) {
        pValues[metric.id] = diff === 0 ? 1 : 0;
      } else {
        const df =
          (se2 * se2) /
          ((g1.variance / g1.n) ** 2 / (g1.n - 1) +
            (g2.variance / g2.n) ** 2 / (g2.n - 1));
        pValues[metric.id] = parseFloat(twoSidedPValue(diff / Math.sqrt(se2), df).toPrecision(4));
      }

      // Cohen's d with pooled standard deviation
      const pooled = Math.sqrt(
        ((g1.n - 1) * g1.variance + (g2.n - 1) * g2.variance) / (g1.n + g2.n - 2)
      );
      if (pooled > 0) effectSizes[metric.id] = parseFloat((diff / pooled).toFixed(2));
      else if (diff === 0) effectSizes[metric.id] = 0;
    }

    // Winner: first metric only, higher mean is better, and only if significant.
    let winner: string | undefined;
    let confidence = 0;
    const primary = experiment.metrics[0];
    if (primary && pValues[primary.id] !== undefined) {
      const p = pValues[primary.id];
      confidence = parseFloat((1 - p).toFixed(4));
      const [m1, m2] = meansByMetric[primary.id];
      if (p < SIGNIFICANCE_LEVEL && m1 !== m2) {
        winner = m1 > m2 ? vA.id : vB.id;
      }
    }

    return {
      status: "complete",
      variant_results: variantStats,
      statistical_analysis: {
        test: "Welch t-test (normal approximation of t, two-sided)",
        p_values: pValues,
        effect_sizes: effectSizes,
        significance_level: SIGNIFICANCE_LEVEL,
      },
      winner,
      confidence,
    };
  }

  public recommendWinner(experimentId: string): string {
    const results = this.getExperimentResults(experimentId);
    if (!results || results.status !== "complete") {
      return "Insufficient data for recommendation";
    }

    return results.winner || "No clear winner";
  }

  public listExperiments(): Array<{
    id: string;
    name: string;
    status: string;
    sample_count: number;
  }> {
    return Array.from(this.experiments.values()).map((exp) => ({
      id: exp.id,
      name: exp.name,
      status: exp.status,
      sample_count: this.measurements.filter(
        (m) => m.experiment_id === exp.id
      ).length,
    }));
  }
}

// Initialize framework
const abTesting = new ABTestingFramework(
  process.env.EXPERIMENTS_FILE || "./experiments.yaml"
);

// Tool: Create experiment
export const createExperimentTool = {
  name: "create_experiment",
  description: "Create a new A/B testing experiment",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      hypothesis: { type: "string" },
      variants: { type: "array" },
      traffic_split: { type: "number" },
      metrics: { type: "array" },
    },
    required: ["id", "name", "hypothesis", "variants", "metrics"],
  },
};

// Tool: Assign variant
export const assignVariantTool = {
  name: "assign_variant",
  description: "Assign a user to a variant in an experiment",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
      user_id: { type: "string" },
    },
    required: ["experiment_id"],
  },
};

// Tool: Record metric
export const recordMetricTool = {
  name: "record_metric",
  description: "Record a metric for an experiment variant",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
      variant_id: { type: "string" },
      metrics: { type: "object" },
    },
    required: ["experiment_id", "variant_id", "metrics"],
  },
};

// Tool: Get results
export const getResultsTool = {
  name: "get_experiment_results",
  description: "Get statistical analysis results for an experiment",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
    },
    required: ["experiment_id"],
  },
};

// Tool: Recommend winner
export const recommendWinnerTool = {
  name: "recommend_winner",
  description: "Get a recommendation for the winning variant",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
    },
    required: ["experiment_id"],
  },
};

// Process tool calls
export async function processToolCall(
  toolName: string,
  toolInput: Record<string, any>
): Promise<string> {
  try {
    return await dispatchToolCall(toolName, toolInput);
  } catch (error: any) {
    return JSON.stringify({ error: error.message });
  }
}

async function dispatchToolCall(
  toolName: string,
  toolInput: Record<string, any>
): Promise<string> {
  switch (toolName) {
    case "create_experiment":
      abTesting.createExperiment({
        traffic_split: 0.5,
        ...toolInput,
      } as Experiment);
      return JSON.stringify({ status: "success", experiment_id: toolInput.id });

    case "assign_variant":
      return JSON.stringify(
        abTesting.assignVariant(
          toolInput.experiment_id,
          toolInput.user_id
        )
      );

    case "record_metric":
      abTesting.recordMetric(
        toolInput.experiment_id,
        toolInput.variant_id,
        toolInput.metrics
      );
      return JSON.stringify({ status: "recorded" });

    case "get_experiment_results":
      return JSON.stringify(
        abTesting.getExperimentResults(toolInput.experiment_id)
      );

    case "recommend_winner":
      return JSON.stringify({
        recommendation: abTesting.recommendWinner(toolInput.experiment_id),
      });

    default:
      return JSON.stringify({ error: "Unknown tool" });
  }
}

export { ABTestingFramework, Experiment };
