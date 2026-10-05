# Feature #7: Custom Routing Plugins for Increadible

**Status**: Custom-built for Increadible  
**Type**: MCP Server + Configuration Framework  
**Purpose**: Team-specific routing rules that enhance OmniRoute (#1)

## What It Does

Allows teams to define custom routing rules without modifying OmniRoute. Rules include:
- Industry-specific provider selection
- Cost-based routing (prefer cheaper providers)
- Performance-based routing (prefer faster providers)
- Quality-based routing (prefer higher quality)
- Custom failover strategies
- Task-type-specific rules

## Architecture

```
REQUEST ARRIVES
    ↓
[Routing Plugins Engine]
├─ Load rules (YAML/JSON)
├─ Evaluate conditions
├─ Select provider
└─ Return to OmniRoute
    ↓
[OmniRoute #1]
├─ Routes to selected provider
└─ Executes with fallback
    ↓
[agentacct #6] tracks cost + performance
```

## Example Rules

```yaml
# rules.yaml
rules:
  - name: "Code Review Tasks"
    match:
      skill: "code_review"
    provider: "claude-haiku"  # Cheapest for this task
    
  - name: "Complex Analysis"
    match:
      skill: "analysis"
      complexity: "high"
    provider: "claude-opus"  # Best quality
    
  - name: "Real-time Response"
    match:
      response_time_sla: "< 1s"
    provider: "gpt-4"  # Fastest
    priority: 1  # Highest priority
```

## Integration Path

1. Create MCP server wrapper
2. Load rules from config files
3. Hook into OmniRoute routing decision
4. Track rule effectiveness with agentacct #6
5. A/B test different rules with Feature #8

## Files

- `src/mcp_server.ts` - MCP server implementation
- `src/rules_engine.ts` - Rule evaluation logic
- `examples/` - Example rule configurations
- `INTEGRATION_GUIDE.md` - Full integration guide (to be created)
