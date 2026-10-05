import Anthropic from "@anthropic-ai/sdk";
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

interface MetricResult {
  variant_id: string;
  metric_id: string;
  mean: number;
  std_dev: number;
  sample_size: number;
}

interface ExperimentResults {
  status: "incomplete" | "complete";
  variant_results: Record<string, any>;
  statistical_analysis: Record<string, any>;
  winner?: string;
  confidence: number;
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
          this.experiments.set(exp.id, exp);
        }
        console.log(`Loaded ${this.experiments.size} experiments`);
      }
    } catch (error) {
      console.error("Error loading experiments:", error);
    }
  }

  public createExperiment(experiment: Experiment): void {
    this.experiments.set(experiment.id, {
      ...experiment,
      status: "setup",
    });
  }

  public assignVariant(
    experimentId: string,
    _userId?: string
  ): {
    variant_id: string;
    experiment_id: string;
  } {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    // Simple random assignment based on traffic split
    const variantIndex =
      Math.random() < experiment.traffic_split ? 0 : 1;
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

    if (expMeasurements.length < 100) {
      return {
        status: "incomplete",
        variant_results: {},
        statistical_analysis: {
          message: `Need ${100 - expMeasurements.length} more samples`,
          current_samples: expMeasurements.length,
        },
        confidence: 0,
      };
    }

    // Calculate statistics by variant
    const variantStats: Record<string, any> = {};

    for (const variant of experiment.variants) {
      const variantMeasurements = expMeasurements.filter(
        (m) => m.variant_id === variant.id
      );

      const metricStats: Record<string, any> = {};

      for (const metric of experiment.metrics) {
        const values = variantMeasurements
          .map((m) => m.metrics[metric.id])
          .filter((v) => v !== undefined);

        if (values.length > 0) {
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          const variance =
            values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
            values.length;
          const stdDev = Math.sqrt(variance);

          metricStats[metric.id] = {
            mean: parseFloat(mean.toFixed(4)),
            std_dev: parseFloat(stdDev.toFixed(4)),
            ci_95: [
              parseFloat((mean - 1.96 * stdDev).toFixed(4)),
              parseFloat((mean + 1.96 * stdDev).toFixed(4)),
            ],
            sample_size: values.length,
          };
        }
      }

      variantStats[variant.id] = {
        name: variant.name,
        metrics: metricStats,
      };
    }

    // Perform statistical tests
    const pValues: Record<string, number> = {};
    const effectSizes: Record<string, number> = {};

    if (experiment.variants.length === 2) {
      const variant1Data = variantStats[experiment.variants[0].id];
      const variant2Data = variantStats[experiment.variants[1].id];

      // Simple t-test approximation (for demonstration)
      for (const metric of experiment.metrics) {
        const m1 = variant1Data.metrics[metric.id];
        const m2 = variant2Data.metrics[metric.id];

        if (m1 && m2) {
          // Cohen's d
          const pooledStd = Math.sqrt((m1.std_dev + m2.std_dev) / 2);
          const d = (m1.mean - m2.mean) / pooledStd;
          effectSizes[metric.id] = parseFloat(d.toFixed(2));

          // Approximate p-value
          const t = (m1.mean - m2.mean) / Math.sqrt(m1.std_dev + m2.std_dev);
          pValues[metric.id] = Math.min(
            1,
            Math.abs(t) > 1.96 ? 0.01 : 0.05
          );
        }
      }
    }

    // Determine winner
    let winner: string | undefined;
    const firstMetric = experiment.metrics[0];
    if (firstMetric) {
      const variant1Value = variantStats[experiment.variants[0].id].metrics[
        firstMetric.id
      ]?.mean;
      const variant2Value = variantStats[experiment.variants[1].id]?.metrics[
        firstMetric.id
      ]?.mean;

      if (variant1Value && variant2Value) {
        winner =
          variant1Value > variant2Value
            ? experiment.variants[0].id
            : experiment.variants[1].id;
      }
    }

    return {
      status: "complete",
      variant_results: variantStats,
      statistical_analysis: {
        p_values: pValues,
        effect_sizes: effectSizes,
        significance_level: 0.05,
      },
      winner,
      confidence: 0.95,
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
  switch (toolName) {
    case "create_experiment":
      abTesting.createExperiment(toolInput as Experiment);
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
