import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The examples and item shapes that tools/list shows a client are run, not trusted. An example that stops working, or a schema
 * that stops describing what the handler needs, fails here. Everything runs in memory or in a temp folder, with the gateway in
 * mock mode and every network call turned into a failure.
 */

type Tool = { name: string; description: string; inputSchema: any };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-schema-examples-"));
let server: typeof import("../src/server");
let tools: Tool[];
const tool = (name: string) => tools.find((t) => t.name === name)!;
const prop = (name: string, key: string) => tool(name).inputSchema.properties[key];
const saved = { ...process.env };
const realFetch = global.fetch;

beforeAll(async () => {
  process.env.RULES_FILE = path.join(tmp, "rules.yaml");
  process.env.EXPERIMENTS_FILE = path.join(tmp, "no-experiments.yaml");
  delete process.env.AB_DATA_FILE;
  for (const key of Object.keys(process.env)) if (/^GATEWAY_/.test(key)) delete process.env[key];
  (global as any).fetch = () => {
    throw new Error("network attempt in a schema example test");
  };
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.isolateModules(() => {
    server = require("../src/server");
  });
  tools = ((await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as any).result.tools;
});
afterAll(() => {
  (global as any).fetch = realFetch;
  jest.restoreAllMocks();
  process.env = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const reply: any = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return { isError: !!reply.result.isError, body: JSON.parse(reply.result.content[0].text) };
};

/** every path (tool.property) that carries an `examples` keyword, at any depth */
function examplePaths(): string[] {
  const found: string[] = [];
  const walk = (node: any, where: string[]) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((x) => walk(x, where));
    for (const [key, value] of Object.entries(node)) {
      if (key === "examples") found.push(where.join("."));
      walk(value, key === "properties" ? where : [...where, key]);
    }
  };
  for (const t of tools) walk(t.inputSchema, [t.name]);
  return found.sort();
}

describe("examples are exactly the ones this file runs", () => {
  it("lists the same (tool, property) paths in both directions", () => {
    expect(examplePaths()).toEqual(["aggregate_apis.apis", "create_experiment.metrics", "create_experiment.variants", "record_metric.metrics", "update_rules.rules"]);
  });
});

describe("the examples run through the handler", () => {
  it("aggregate_apis: the example answers with source mock and no failure", async () => {
    const example = prop("aggregate_apis", "apis").examples[0];
    const { isError, body } = await call("aggregate_apis", { apis: example });
    expect(isError).toBe(false);
    expect(body.count).toBe(example.length);
    expect(body).not.toHaveProperty("failed");
    expect(body.data.map((r: any) => r.source)).toEqual(Array(example.length).fill("mock"));
  });

  it("update_rules: the example is accepted and routes what its description says", async () => {
    const example = prop("update_rules", "rules").examples[0];
    expect((await call("update_rules", { rules: example })).body).toEqual({ status: "success", message: `Updated ${example.length} rules` });
    expect((await call("apply_routing_rules", { task_type: "qa", task_complexity: "low" })).body).toMatchObject({ provider: "claude-haiku", rule_id: "simple-tasks" });
    expect((await call("apply_routing_rules", { task_type: "development" })).body).toMatchObject({ provider: "claude-sonnet", rule_id: "default" });
  });

  it("A/B: the variants, metrics and record_metric examples work as one chain", async () => {
    const variants = prop("create_experiment", "variants").examples[0];
    const metrics = prop("create_experiment", "metrics").examples[0];
    expect((await call("create_experiment", { id: "chain", name: "n", hypothesis: "h", variants, metrics })).body).toEqual({ status: "success", experiment_id: "chain" });
    const assigned = (await call("assign_variant", { experiment_id: "chain", user_id: "u1" })).body;
    expect(variants.map((v: any) => v.id)).toContain(assigned.variant_id);
    const recorded = prop("record_metric", "metrics").examples[0];
    expect(Object.keys(recorded).sort()).toEqual(metrics.map((m: any) => m.id).sort());
    expect((await call("record_metric", { experiment_id: "chain", variant_id: assigned.variant_id, metrics: recorded })).body).toEqual({ status: "recorded" });
    const results = await call("get_experiment_results", { experiment_id: "chain" });
    expect(results.isError).toBe(false);
    expect(results.body.status).toBe("incomplete");
  });

  it("record_metric: the example written in its description equals the examples entry", () => {
    const schema = prop("record_metric", "metrics");
    const written = schema.description.match(/e\.g\. (\{[^}]*\})/);
    expect(written).not.toBeNull();
    expect(JSON.parse(written![1].replace(/(\w+):/g, '"$1":'))).toEqual(schema.examples[0]);
  });
});

describe("item shapes are described, not guessed", () => {
  it("every array property of every tool has an items schema", () => {
    const missing: string[] = [];
    const walk = (node: any, where: string) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "array" && !node.items) missing.push(where);
      for (const [key, value] of Object.entries(node.properties ?? {})) walk(value, `${where}.${key}`);
      if (node.items) walk(node.items, `${where}[]`);
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    expect(missing).toEqual([]);
  });

  it("aggregate_apis items need id and endpoint, never api_id, and the description names the trap", () => {
    const apis = prop("aggregate_apis", "apis");
    expect(apis.items.required).toEqual(["id", "endpoint"]);
    expect(Object.keys(apis.items.properties).sort()).toEqual(["endpoint", "id", "params"]);
    expect(apis.maxItems).toBe(100);
    expect(apis.description).toMatch(/NOT api_id/);
    expect(prop("call_api", "api_id").description).toMatch(/aggregate_apis the same value is called id/);
    expect(tool("aggregate_apis").description).toMatch(/\(not api_id\)/);
  });

  it("update_rules, variants and metrics items name their required keys", () => {
    expect(prop("update_rules", "rules").items.required).toEqual(["id", "provider", "priority", "enabled", "match"]);
    expect(prop("create_experiment", "variants").items.required).toEqual(["id"]);
    expect(prop("create_experiment", "metrics").items.required).toEqual(["id"]);
    expect(prop("create_experiment", "metrics").items.properties.direction.enum).toEqual(["higher_is_better", "lower_is_better"]);
    expect(prop("record_metric", "metrics").additionalProperties.type).toBe("number");
  });

  it("no schema property is itself called description or examples (the contract test strips those keys)", () => {
    const bad: string[] = [];
    const walk = (node: any, where: string) => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node.properties ?? {})) {
        if (key === "description" || key === "examples") bad.push(`${where}.${key}`);
        walk(value, `${where}.${key}`);
      }
      if (node.items) walk(node.items, `${where}[]`);
      if (node.additionalProperties && typeof node.additionalProperties === "object") walk(node.additionalProperties, `${where}{}`);
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    expect(bad).toEqual([]);
  });
});

describe("prose that copies the registry stays equal to it", () => {
  it("call_api's api_id description lists exactly the ids discover_apis returns; query's categories and single-word names are real", async () => {
    const entries = (await call("discover_apis", {})).body as Array<{ id: string; name: string; category: string }>;
    const listed = prop("call_api", "api_id").description.match(/Today (.*?)\. An unknown id/)![1].split(/, | or /);
    expect(listed.sort()).toEqual(entries.map((e) => e.id).sort());
    const query = prop("discover_apis", "query").description;
    const categories = query.match(/Categories today: (.*?)\./)![1].split(", ");
    expect(categories.sort()).toEqual([...new Set(entries.map((e) => e.category))].sort());
    for (const e of entries) expect(e.name).toMatch(/^\S+$/);
    expect((await call("discover_apis", { query: "hackernews" })).body.map((e: any) => e.id)).toEqual(["hackernews"]);
    expect((await call("discover_apis", { query: "hacker news" })).body).toEqual([]);
    expect((await call("discover_apis", { query: "bitcoin" })).body).toEqual([]);
  });
});

describe("prose carries no limit numbers: counts live in schema keywords, which schema-no-narrowing reads", () => {
  const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|twenty|hundred|thousand|million|twice|half)\b/gi;
  // Every number written in a description of any tool when this guard was added. They are format examples or pre-existing text, not
  // limits. A new or changed number fails here until it is pinned on purpose, with a reason; a limit belongs in a keyword
  // (maxItems, maxLength, minimum, ...), where schema-no-narrowing ties it to the handler.
  const PINNED: Record<string, string[]> = {
    "apply_routing_rules.response_sla": ["1"], // "(e.g., '< 1s')"
    "create_experiment (tool)": ["two", "ten", "two"], // "two to ten variants": tied to variants.minItems and maxItems by the next test
    "record_metric.metrics": ["8.5", "0.02"], // "e.g. {quality: 8.5, cost: 0.02}": tied to examples[0] by the test above
  };
  const numbersIn = (text: string) => [...(text.match(/\d+(?:\.\d+)?(?:e\d+)?/g) ?? []), ...(text.match(NUMBER_WORDS) ?? [])].map((x) => x.toLowerCase());

  function numbersInProse(): Record<string, string[]> {
    const found: Record<string, string[]> = {};
    const walk = (node: any, where: string) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${where}[${i}]`));
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string") {
          const hit = numbersIn(value);
          if (hit.length) found[where] = hit;
        } else if (key !== "examples" && key !== "default") walk(value, key === "properties" ? where : `${where}.${key}`);
      }
    };
    for (const t of tools) {
      const hit = numbersIn(t.description);
      if (hit.length) found[`${t.name} (tool)`] = hit;
      walk(t.inputSchema, t.name);
    }
    return found;
  }

  it("finds exactly the pinned numbers in every description of every tool", () => {
    expect(numbersInProse()).toEqual(PINNED);
  });

  it("the one pinned bound, 'two to ten variants', equals the variants keywords", () => {
    expect(tool("create_experiment").description).toMatch(/with two to ten variants/);
    const variants = prop("create_experiment", "variants");
    expect([variants.minItems, variants.maxItems]).toEqual([2, 10]);
  });
});

describe("behaviour that prose names is real", () => {
  it("'__proto__' is refused as an experiment id, a variant id and a metric id, and the prose says so", async () => {
    expect(prop("create_experiment", "variants").items.properties.id.description).toMatch(/not '__proto__'/);
    expect(prop("create_experiment", "metrics").items.properties.id.description).toMatch(/not '__proto__'/);
    const make = (id: string, variants: unknown[], metrics: unknown[]) => call("create_experiment", { id, name: "n", hypothesis: "h", variants, metrics });
    expect((await make("proto-ok", [{ id: "a" }, { id: "b" }], [{ id: "m" }])).isError).toBe(false);
    expect((await make("__proto__", [{ id: "a" }, { id: "b" }], [{ id: "m" }])).isError).toBe(true);
    expect((await make("e1", [{ id: "__proto__" }, { id: "b" }], [{ id: "m" }])).isError).toBe(true);
    expect((await make("e2", [{ id: "a" }, { id: "b" }], [{ id: "__proto__" }])).isError).toBe(true);
  });

  it("a rule value matches by exact equality: the number does not match the same digits as text", async () => {
    expect(prop("update_rules", "rules").items.properties.match.description).toMatch(/a number never matches text that looks like it/);
    const rule = { id: "num", provider: "p-num", priority: 1, enabled: true, match: { level: 5 } };
    expect((await call("update_rules", { rules: [rule] })).isError).toBe(false);
    expect((await call("apply_routing_rules", { task_type: "x", level: "5" })).body).toMatchObject({ rule_id: "default" });
    expect((await call("apply_routing_rules", { task_type: "x", level: 5 })).body).toMatchObject({ rule_id: "num", provider: "p-num" });
  });
});

describe("the guardrail prose: a guardrail with too little data withholds a winner", () => {
  it("withholds without data on the guardrail, and not once it is recorded for every variant", async () => {
    expect(prop("create_experiment", "metrics").items.properties.guardrail.description).toMatch(/also when it has too little data to judge/);
    const metrics = [{ id: "score" }, { id: "cost", direction: "lower_is_better", guardrail: true }];
    const make = async (id: string, withGuardrail: boolean) => {
      expect((await call("create_experiment", { id, name: "n", hypothesis: "h", variants: [{ id: "a" }, { id: "b" }], metrics })).isError).toBe(false);
      for (let i = 0; i < 60; i++) {
        for (const [variant, base] of [["a", 10], ["b", 20]] as const) {
          const values: Record<string, number> = { score: base + (i % 5) };
          if (withGuardrail) values.cost = 1 + (i % 3) * 0.01;
          expect((await call("record_metric", { experiment_id: id, variant_id: variant, metrics: values })).isError).toBe(false);
        }
      }
      return (await call("recommend_winner", { experiment_id: id })).body;
    };
    expect(JSON.stringify(await make("no-guardrail-data", false))).toContain("No clear winner (withheld by guardrail: cost)");
    expect(JSON.stringify(await make("with-guardrail-data", true))).not.toContain("No clear winner");
  });
});
