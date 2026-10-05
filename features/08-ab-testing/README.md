# Feature #8: A/B Testing Framework for Increadible

**Status**: Custom-built for Increadible  
**Type**: MCP Server + Analytics Framework  
**Purpose**: Compare model/prompt/provider variants with statistical rigor

## What It Does

Enables experimentation across all 7 features:
- Compare Claude models (Opus vs Sonnet vs Haiku)
- Test prompt variants against each other
- Compare providers (Claude vs GPT-4 vs others)
- Measure quality, cost, and speed tradeoffs
- Track statistical significance
- Recommend winners automatically

## Architecture

```
REQUEST ARRIVES
    ↓
[A/B Testing Framework]
├─ Assign to variant (A or B)
├─ Record baseline
└─ Route to appropriate handler
    ↓
[Variant A] vs [Variant B]
├─ Model A vs Model B
├─ Prompt A vs Prompt B
├─ Provider A vs Provider B
└─ Record both outcomes
    ↓
[Measurement Layer]
├─ Quality (human/metric score)
├─ Cost (from agentacct #6)
├─ Speed (latency)
├─ Token efficiency (token-optimizer #3)
└─ User satisfaction
    ↓
[Analysis Engine]
├─ Statistical significance test
├─ Confidence intervals
├─ Effect size calculation
├─ Winner recommendation
└─ Cost/quality tradeoff analysis
    ↓
[Dashboard + Insights]
├─ Real-time results
├─ Historical trends
├─ Cost vs quality visualization
└─ Automated winner selection
```

## Example Experiments

### Experiment 1: Model Comparison
```
Hypothesis: Claude Haiku achieves same quality as Opus at 1% cost

Setup:
├─ Variant A: Claude Opus (control)
├─ Variant B: Claude Haiku (treatment)
└─ Metric: Code review quality score

Results (1000 reviews):
├─ Opus: 9.5/10 avg, $0.03 cost
├─ Haiku: 9.2/10 avg, $0.0003 cost
├─ Cost savings: 99%
├─ Quality loss: 3%
└─ Recommendation: Use Haiku for code reviews ✅
```

### Experiment 2: Prompt Optimization
```
Hypothesis: Simplified prompt achieves same results with fewer tokens

Setup:
├─ Variant A: Original 2000-word prompt
├─ Variant B: Simplified 200-word prompt
└─ Metric: Accuracy on task

Results:
├─ Original: 95% accuracy, 2000 tokens
├─ Simplified: 94% accuracy, 200 tokens
├─ Token savings: 90%
├─ Accuracy loss: 1%
└─ Recommendation: Use simplified prompt ✅
```

### Experiment 3: Provider Comparison
```
Hypothesis: OmniRoute can route to cheaper provider without quality loss

Setup:
├─ Variant A: Claude (baseline)
├─ Variant B: GPT-4 (cheaper for this task)
└─ Metric: Task completion time + quality

Results:
├─ Claude: 2 sec, 9.8/10, $0.05
├─ GPT-4: 0.5 sec, 9.7/10, $0.02
├─ Cost savings: 60%
├─ Speed gain: 75%
└─ Recommendation: Use GPT-4 for this task ✅
```

## Integration with All 8 Features

```
Feature #1 (OmniRoute): Route variant decisions
Feature #2 (Claude-Mem): Track memory impact
Feature #3 (token-optimizer): Measure token savings
Feature #4 (gstack): Compare skill quality
Feature #6 (agentacct): Calculate cost differences
Feature #7 (Routing Plugins): Test different rules
Feature #8 (A/B Testing): Central coordination
```

## Files

- `src/mcp_server.ts` - MCP server implementation
- `src/experiment_engine.ts` - Experiment setup & tracking
- `src/analysis_engine.ts` - Statistical analysis
- `src/dashboard.ts` - Results visualization
- `examples/` - Example experiments
- `INTEGRATION_GUIDE.md` - Full integration guide (to be created)
