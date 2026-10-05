# Feature #8: A/B Testing

Two-variant experiments with a significance test. Implemented in `src/mcp-server.ts`
(class `ABTestingFramework`), served by the root MCP server.

## Experiment definition

```yaml
experiments:                    # optional file, EXPERIMENTS_FILE; invalid entries are skipped
  - id: sonnet-vs-haiku
    name: Sonnet vs Haiku on QA
    hypothesis: Haiku quality is as good for low-complexity QA
    status: running             # setup | running | complete (informational only)
    traffic_split: 0.5          # probability of the FIRST variant; default 0.5 via the tool
    variants:                   # exactly 2
      - { id: A, name: sonnet, config: {} }
      - { id: B, name: haiku, config: {} }
    metrics:
      - { id: quality, name: Quality, type: continuous, aggregation: mean }
```

`type` and `aggregation` are not used by the code; every metric is analysed as a continuous mean.

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `create_experiment` | `id`, `name`, `hypothesis`, `variants` (exactly 2), `metrics`, optional `traffic_split` (0..1) | `{status, experiment_id}` |
| `assign_variant` | `experiment_id`, optional `user_id` | `{variant_id, experiment_id}`. Sticky per `(experiment, user_id)`; random if no `user_id` |
| `record_metric` | `experiment_id`, `variant_id`, `metrics{metricId: finite number}` | `{status: "recorded"}`; errors for unknown experiment/variant or non-numeric values |
| `get_experiment_results` | `experiment_id` | see below |
| `recommend_winner` | `experiment_id` | `{recommendation: "<variant id>" \| "No clear winner" \| "Insufficient data for recommendation"}` |

## Results

```json
{
  "status": "complete",
  "variant_results": { "A": { "name": "...", "metrics": { "quality": { "mean": 9.9, "std_dev": 1.1, "ci_95": [9.6, 10.2], "sample_size": 60 } } } },
  "statistical_analysis": { "test": "Welch t-test (normal approximation of t, two-sided)", "p_values": { "quality": 0.0001 }, "effect_sizes": { "quality": 4.6 }, "significance_level": 0.05 },
  "winner": "A",
  "confidence": 0.9999
}
```

- `status` is `incomplete` (with `confidence: 0` and a message) until there are >= 100 measurements in total and >= 30 per variant.
- Only the **first** metric decides the winner; the higher mean wins, and only if `p < 0.05`. `confidence = 1 - p`.
- `ci_95` is a 95% confidence interval for the mean. `effect_sizes` is Cohen's d (pooled SD).
- Measurements are stored in memory and are lost on restart; run one replica.
