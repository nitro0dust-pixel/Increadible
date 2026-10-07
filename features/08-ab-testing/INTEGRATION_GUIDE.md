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
    primary_metric: cost        # optional: the metric that decides the winner; default is the first metric
    metrics:
      - { id: cost, name: Cost per task, type: continuous, aggregation: mean, direction: lower_is_better }
      - { id: quality, name: Quality, type: continuous, aggregation: mean, guardrail: true }
```

`type` and `aggregation` are not used by the code; every metric is analysed as a continuous mean. `direction` is
`higher_is_better` (the default) or `lower_is_better`; any other value is rejected. `guardrail: true` marks a metric that
may withhold a winner but never picks one (see Results). These three fields are optional and checked only when present,
so an experiment written without them behaves exactly as before.

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `create_experiment` | `id`, `name`, `hypothesis`, `variants` (exactly 2), `metrics`, optional `traffic_split` (0..1), optional `primary_metric` | `{status, experiment_id}` |
| `assign_variant` | `experiment_id`, optional `user_id` | `{variant_id, experiment_id}`. Sticky per `(experiment, user_id)`; random if no `user_id` |
| `record_metric` | `experiment_id`, `variant_id`, `metrics{metricId: finite number}` | `{status: "recorded"}`; errors for unknown experiment/variant or non-numeric values |
| `get_experiment_results` | `experiment_id` | see below |
| `recommend_winner` | `experiment_id` | `{recommendation: "<variant id>" \| "No clear winner" \| "No clear winner (withheld by guardrail: <ids>)" \| "Insufficient data for recommendation"}` |

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
- Only the **primary** metric decides the winner (the first metric unless `primary_metric` names another); the better mean wins (the higher one unless the metric is `lower_is_better`), and only if `p < 0.05`. `confidence = 1 - p` of the primary metric.
- **Guardrails.** For each metric with `guardrail: true`, `statistical_analysis.guardrails.<id>` holds `p_value` and `significantly_worse_variant` (null when the difference is not significant). The winner is withheld (the result has no `winner` key and `statistical_analysis.winner_withheld_by` lists the guardrail ids) when a guardrail is significantly worse for the leading variant, and also when a guardrail has no data for a variant (a check that did not run is not a pass). These keys appear only for experiments that declare a guardrail. A guardrail uses the same two-sided test at the same level on the same samples, so it is weak on small samples: a guardrail that is "not significantly worse" has not been shown to be safe.
- `ci_95` is a 95% confidence interval for the mean. `effect_sizes` is Cohen's d (pooled SD).
- **Persistence** (`AB_DATA_FILE`, optional): an append-only JSONL log of created experiments and measurements,
  written before each change is applied and replayed at startup. If a write fails, the tool call returns an error and
  nothing is recorded. Without `AB_DATA_FILE`, everything is in memory and lost on restart.
  Exactly one process may own the file: a lock file (`<file>.lock`) makes a second process fail at startup with the
  holder's pid, and a write fails if the lock was lost. `AB_FSYNC=1` flushes each append to disk (a failed flush fails
  the call, but the line may already be in the file). A warning is logged once the file passes `AB_DATA_WARN_BYTES`
  (default 100 MB); it is never compacted. Library users call `close()` to hand the file over.
  Memory does not grow with the file: the module keeps only counts and a running mean and variance per variant and
  metric (the raw values stay in the file), so `get_experiment_results` takes the same time at any size, and startup
  replays the file in 1 MiB chunks.
- `create_experiment` with an id that already exists is rejected; YAML definitions override a logged experiment with the same id.
