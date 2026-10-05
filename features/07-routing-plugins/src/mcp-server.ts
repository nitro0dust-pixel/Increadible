import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as yaml from "yaml";
import * as path from "path";

const client = new Anthropic();

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

class RoutingPluginsMCP {
  private rules: RoutingRule[] = [];
  private rulesFile: string;
  private stats = {
    total_requests: 0,
    rules_applied: {} as Record<string, number>,
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
        this.rules = config.rules.sort((a, b) => a.priority - b.priority);
        console.log(`Loaded ${this.rules.length} routing rules`);
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
    ];
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
        this.stats.rules_applied[rule.id] =
          (this.stats.rules_applied[rule.id] || 0) + 1;

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
      rules_applied: this.stats.rules_applied,
      provider_breakdown: this.calculateProviderBreakdown(),
      rules_count: this.rules.length,
      enabled_rules: this.rules.filter((r) => r.enabled).length,
    };
  }

  private calculateProviderBreakdown(): Record<string, string> {
    const counts: Record<string, number> = {};
    const total = this.stats.total_requests;

    for (const [ruleId, count] of Object.entries(this.stats.rules_applied)) {
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
    this.rules = newRules.sort((a, b) => a.priority - b.priority);
    this.saveRules();
  }

  private saveRules(): void {
    const config: RulesConfig = {
      metadata: {
        team: "Engineering",
        version: "1.0",
        last_updated: new Date().toISOString(),
      },
      rules: this.rules,
    };

    fs.writeFileSync(this.rulesFile, yaml.stringify(config));
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
      const suggestions = [
        {
          type: "optimization",
          suggestion:
            "Route more low-complexity tasks to Haiku for cost savings",
          potential_savings: "70-80%",
        },
      ];
      return JSON.stringify(suggestions);
    }

    default:
      return JSON.stringify({ error: "Unknown tool" });
  }
}

// Export for use in Increadible
export { RoutingPluginsMCP, RulesConfig, RoutingRule };
