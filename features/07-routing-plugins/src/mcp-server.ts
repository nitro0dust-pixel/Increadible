import * as fs from "fs";
import * as yaml from "yaml";

interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: Record<string, any>;
  provider: string;
  fallback?: string[];
  reason: string;
  tags?: string[];
}

interface RulesConfig {
  metadata: {
    team: string;
    version: string;
    last_updated: string;
  };
  rules: RoutingRule[];
}

const MAX_RULES = 500;
const MAX_RULES_BYTES = 1024 * 1024;

/**
 * What is wrong with a list of rules, or null. One check for both ways rules arrive, so they cannot disagree: the update_rules tool
 * and a rules file at startup. (The file used to be trusted: a file that parsed but held a rule with no `match` made every
 * apply_routing_rules call fail with "Cannot convert undefined or null to object", and `enabled: "no"` counted as enabled.)
 */
export function rulesProblem(rules: unknown): string | null {
  if (!Array.isArray(rules)) return "rules must be an array";
  if (rules.length > MAX_RULES) return `at most ${MAX_RULES} rules are allowed (got ${rules.length})`;
  const seen = new Set<string>();
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.id !== "string" ||
      typeof rule.provider !== "string" ||
      typeof rule.priority !== "number" ||
      typeof rule.enabled !== "boolean" ||
      typeof rule.match !== "object" ||
      rule.match === null
    ) {
      return "each rule needs string id, string provider, number priority, boolean enabled and object match";
    }
    if (rule.id === "") return "a rule id must not be empty";
    if (seen.has(rule.id)) return `duplicate rule id: ${rule.id}`;
    seen.add(rule.id);
    if (!Number.isFinite(rule.priority)) return `rule ${rule.id}: priority must be a finite number`;
    if (Array.isArray(rule.match)) return `rule ${rule.id}: match must be an object of key: value pairs, not a list`;
    if (rule.fallback !== undefined && (!Array.isArray(rule.fallback) || !rule.fallback.every((f: unknown) => typeof f === "string"))) {
      return `rule ${rule.id}: fallback must be a list of provider names`;
    }
  }
  if (JSON.stringify(rules).length > MAX_RULES_BYTES) return `the rules are larger than ${MAX_RULES_BYTES / 1024} KB`;
  return null;
}

class RoutingPluginsMCP {
  private rules: RoutingRule[] = [];
  private rulesFile: string;
  // A Map, because the keys are rule ids chosen by whoever sends the rules: in a plain object an id such as "constructor" found
  // Object's own function, "+ 1" turned the count into text, and the provider share printed "NaN%".
  private stats = {
    total_requests: 0,
    rules_applied: new Map<string, number>(),
    cost_savings: {} as Record<string, string>,
  };

  constructor(rulesFile: string = "./rules.yaml") {
    this.rulesFile = rulesFile;
    this.loadRules();
  }

  private loadRules(): void {
    try {
      if (fs.existsSync(this.rulesFile)) {
        const content = fs.readFileSync(this.rulesFile, "utf-8");
        const config: RulesConfig = yaml.parse(content);
        const problem = rulesProblem(config?.rules);
        if (problem) {
          console.error(`Rules file ${this.rulesFile} is not usable (${problem}); using the built-in rules`);
          this.createDefaultRules();
          return;
        }
        this.rules = config.rules.sort((a, b) => a.priority - b.priority);
        console.error(`Loaded ${this.rules.length} routing rules`);
      } else {
        console.warn(`Rules file not found: ${this.rulesFile}`);
        this.createDefaultRules();
      }
    } catch (error) {
      console.error("Error loading rules:", error);
      this.createDefaultRules();
    }
  }

  private createDefaultRules(): void {
    this.rules = [
      {
        id: "simple-tasks",
        name: "Simple Questions & Summarization",
        enabled: true,
        priority: 10,
        match: { task_complexity: "low", task_type: ["qa", "summary"] },
        provider: "claude-haiku",
        fallback: ["claude-sonnet"],
        reason: "Haiku optimal for low-complexity tasks",
      },
      {
        id: "critical-tasks",
        name: "Security & Critical Analysis",
        enabled: true,
        priority: 5,
        match: { priority: "critical", task_type: ["security", "audit"] },
        provider: "claude-opus",
        fallback: ["gpt-4"],
        reason: "Opus required for critical decisions",
      },
      {
        id: "default",
        name: "Default Rule",
        enabled: true,
        priority: 100,
        match: {},
        provider: "claude-sonnet",
        reason: "Balanced default",
      },
    ].sort((a, b) => a.priority - b.priority);
  }

  private matchesConditions(
    request: Record<string, any>,
    conditions: Record<string, any>
  ): boolean {
    if (Object.keys(conditions).length === 0) return true;

    for (const [key, value] of Object.entries(conditions)) {
      if (!(key in request)) return false;

      if (Array.isArray(value)) {
        if (!value.includes(request[key])) return false;
      } else if (value !== request[key]) {
        return false;
      }
    }

    return true;
  }

  public applyRoutingRules(request: Record<string, any>): {
    provider: string;
    fallback: string[];
    rule_id: string;
    reason: string;
  } {
    this.stats.total_requests++;

    // Find matching rule (sorted by priority)
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (this.matchesConditions(request, rule.match)) {
        this.stats.rules_applied.set(rule.id, (this.stats.rules_applied.get(rule.id) ?? 0) + 1);

        return {
          provider: rule.provider,
          fallback: rule.fallback || [],
          rule_id: rule.id,
          reason: rule.reason,
        };
      }
    }

    // Fallback to default
    return {
      provider: "claude-sonnet",
      fallback: [],
      rule_id: "default",
      reason: "No matching rule, using default",
    };
  }

  public getStats(): Record<string, any> {
    return {
      total_requests: this.stats.total_requests,
      rules_applied: Object.fromEntries(this.stats.rules_applied),
      provider_breakdown: this.calculateProviderBreakdown(),
      rules_count: this.rules.length,
      enabled_rules: this.rules.filter((r) => r.enabled).length,
    };
  }

  private calculateProviderBreakdown(): Record<string, string> {
    const counts: Record<string, number> = {};
    const total = this.stats.total_requests;

    for (const [ruleId, count] of this.stats.rules_applied) {
      const rule = this.rules.find((r) => r.id === ruleId);
      if (rule) {
        counts[rule.provider] = (counts[rule.provider] || 0) + count;
      }
    }

    const breakdown: Record<string, string> = {};
    for (const [provider, count] of Object.entries(counts)) {
      const percentage = ((count as number) / total) * 100;
      breakdown[provider] = `${percentage.toFixed(1)}%`;
    }

    return breakdown;
  }

  public updateRules(newRules: RoutingRule[]): void {
    const problem = rulesProblem(newRules);
    if (problem) throw new Error(problem);
    const sorted = [...newRules].sort((a, b) => a.priority - b.priority);
    // Write first, then switch: when the write fails (a read-only ConfigMap mount, a full disk) the call reports an error AND the
    // live rules are unchanged. They used to be replaced before the write, so the error was true but routing had changed anyway.
    this.saveRules(sorted);
    this.rules = sorted;
  }

  private saveRules(rules: RoutingRule[]): void {
    const config: RulesConfig = {
      metadata: {
        team: "Engineering",
        version: "1.0",
        last_updated: new Date().toISOString(),
      },
      rules,
    };

    // A temporary file renamed over the target: a crash in the middle leaves the old file whole, not a truncated one (which the
    // next start would have discarded in favour of the built-in rules).
    const tmp = `${this.rulesFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, yaml.stringify(config));
      fs.renameSync(tmp, this.rulesFile);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to remove */
      }
      throw error;
    }
  }
}

// Initialize MCP server
const routingPlugins = new RoutingPluginsMCP(
  process.env.RULES_FILE || "./rules.yaml"
);

// Tool: Apply routing rules
export const applyRoutingRulesTool = {
  name: "apply_routing_rules",
  description:
    "Apply team-specific routing rules to optimize provider selection",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_type: {
        type: "string",
        description:
          "Type of task: qa, summary, security, development, analysis, code_review, etc.",
      },
      task_complexity: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Estimated complexity of the task",
      },
      priority: {
        type: "string",
        enum: ["low", "normal", "high", "critical"],
        description: "Priority level of the task",
      },
      response_sla: {
        type: "string",
        description: "Required response time SLA (e.g., '< 1s')",
      },
    },
    required: ["task_type"],
  },
};

// Tool: Get routing statistics
export const getRoutingStatsTool = {
  name: "get_rule_stats",
  description:
    "Get statistics on routing rule application and provider breakdown",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

// Tool: Update routing rules
export const updateRulesTool = {
  name: "update_rules",
  description: "Update routing rules configuration",
  inputSchema: {
    type: "object" as const,
    properties: {
      rules: {
        type: "array",
        description: "New routing rules array",
      },
    },
    required: ["rules"],
  },
};

// Tool: Suggest optimized rules
export const suggestRulesTool = {
  name: "suggest_rules",
  description:
    "Suggest optimized routing rules based on current statistics",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
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
    case "apply_routing_rules": {
      const result = routingPlugins.applyRoutingRules(toolInput);
      return JSON.stringify(result);
    }

    case "get_rule_stats": {
      const stats = routingPlugins.getStats();
      return JSON.stringify(stats);
    }

    case "update_rules": {
      routingPlugins.updateRules(toolInput.rules);
      return JSON.stringify({
        status: "success",
        message: `Updated ${toolInput.rules.length} rules`,
      });
    }

    case "suggest_rules": {
      const stats = routingPlugins.getStats();
      const haikuShare = parseFloat(stats.provider_breakdown["claude-haiku"] ?? "0");
      const suggestions =
        stats.total_requests === 0
          ? []
          : haikuShare < 50
          ? [
              {
                type: "optimization",
                suggestion:
                  "Less than half of requests go to a low-cost model; review whether low-complexity tasks can be routed to Haiku",
                current_low_cost_share: `${haikuShare.toFixed(1)}%`,
              },
            ]
          : [];
      return JSON.stringify(suggestions);
    }

    default:
      return JSON.stringify({ error: "Unknown tool" });
  }
}

// Export for use in Increadible
export { RoutingPluginsMCP, RulesConfig, RoutingRule };
