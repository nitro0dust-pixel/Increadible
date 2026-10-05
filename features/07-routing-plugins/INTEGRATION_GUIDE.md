# Feature #7: Routing Plugins

Rule-based provider selection. Implemented in `src/mcp-server.ts` (class `RoutingPluginsMCP`),
served by the root MCP server (`src/index.ts`).

## What it does

Given a request (a JSON object), return the provider/fallback of the first **enabled** rule whose
`match` fits, evaluated in ascending `priority` order. It only *recommends* a provider; nothing here
calls a model. Feed the result to your router (e.g. OmniRoute, #1).

## Rules file

Loaded from `RULES_FILE` (default `./rules.yaml`). If the file is missing or invalid, built-in defaults are used.

```yaml
metadata: { team: Engineering, version: "1.0", last_updated: "2026-01-01T00:00:00Z" }
rules:
  - id: critical-tasks          # string, required
    name: Security & critical analysis
    enabled: true               # boolean, required (disabled rules are skipped)
    priority: 5                 # number, required; lower is evaluated first
    match:                      # object, required; {} matches everything
      priority: critical
      task_type: [security, audit]   # a list means "any of"
    provider: claude-opus       # string, required
    fallback: [gpt-4]           # optional
    reason: Opus required for critical decisions
```

Matching is exact equality (or membership for a list value) on keys of the request. A rule does not
match if the request lacks any key the rule names. There are no operators (`<`, `>`, ranges).

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `apply_routing_rules` | `task_type` (required); `task_complexity` low/medium/high; `priority` low/normal/high/critical; `response_sla`; any extra property your client sends can be matched by a rule | `{provider, fallback[], rule_id, reason}` |
| `get_rule_stats` | none | `{total_requests, rules_applied{id:n}, provider_breakdown{provider:"75.0%"}, rules_count, enabled_rules}` |
| `update_rules` | `rules`: full replacement array (validated; each needs `id`, `provider`, `priority`, `enabled`, `match`) | `{status, message}`; persists to `RULES_FILE`. Errors if the file is not writable (e.g. a read-only ConfigMap mount) |
| `suggest_rules` | none | array; `[]` until requests have been observed, otherwise a suggestion if under half of requests go to Haiku |

Rule hit counts are in memory and reset on restart.
