/**
 * The contract of `tools/list`: the 13 tools a client sees, in order, with the input schema of each. A client builds its calls from
 * these, so a changed type, a dropped `required` or a lost enum value is a change of the interface, and has to be made on purpose
 * (here) and not by accident. Descriptions are prose and are only required to exist. The mutation-testing pass of the audit found
 * that nothing checked any of this: emptying every schema object in the three modules left the whole suite green.
 */

type ServerModule = typeof import("../src/server");
let server: ServerModule;

beforeAll(() => {
  process.env.RULES_FILE = "/nonexistent/increadible-rules.yaml";
  process.env.EXPERIMENTS_FILE = "/nonexistent/increadible-experiments.yaml";
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.isolateModules(() => {
    server = require("../src/server");
  });
});
afterAll(() => jest.restoreAllMocks());

const string = { type: "string" };
const EXPECTED: Array<[string, Record<string, unknown>, string[] | undefined]> = [
  [
    "apply_routing_rules",
    {
      task_type: string,
      task_complexity: { type: "string", enum: ["low", "medium", "high"] },
      priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
      response_sla: string,
    },
    ["task_type"],
  ],
  ["get_rule_stats", {}, []],
  ["update_rules", { rules: { type: "array" } }, ["rules"]],
  ["suggest_rules", {}, []],
  [
    "create_experiment",
    {
      id: string,
      name: string,
      hypothesis: string,
      variants: { type: "array" },
      traffic_split: { type: "number" },
      metrics: { type: "array" },
      primary_metric: string,
      weights: { type: "array" },
    },
    ["id", "name", "hypothesis", "variants", "metrics"],
  ],
  ["assign_variant", { experiment_id: string, user_id: { type: ["string", "number"] } }, ["experiment_id"]],
  ["record_metric", { experiment_id: string, variant_id: string, metrics: { type: "object" } }, ["experiment_id", "variant_id", "metrics"]],
  ["get_experiment_results", { experiment_id: string }, ["experiment_id"]],
  ["recommend_winner", { experiment_id: string }, ["experiment_id"]],
  ["discover_apis", { query: string }, undefined],
  ["call_api", { api_id: string, endpoint: string, params: { type: "object" } }, ["api_id", "endpoint"]],
  ["aggregate_apis", { apis: { type: "array" } }, ["apis"]],
  ["get_api_stats", {}, undefined],
];

const stripDescriptions = (schema: unknown) => JSON.parse(JSON.stringify(schema, (key, value) => (key === "description" ? undefined : value)));

describe("tools/list", () => {
  let tools: Array<{ name: string; description: string; inputSchema: any }>;
  beforeAll(async () => {
    const reply: any = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    tools = reply.result.tools;
  });

  it("lists the 13 tools in order: routing, A/B testing, API gateway", () => {
    expect(tools.map((t) => t.name)).toEqual(EXPECTED.map(([name]) => name));
  });

  it.each(EXPECTED)("%s has the input schema clients rely on", (name, properties, required) => {
    const tool = tools.find((t) => t.name === name)!;
    expect(stripDescriptions(tool.inputSchema)).toEqual({ type: "object", properties, ...(required ? { required } : {}) });
  });

  it("describes every tool in words", () => {
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.trim().length).toBeGreaterThan(10);
    }
  });

  it("tells a client in create_experiment's description about metric directions and guardrails", () => {
    const create = tools.find((t) => t.name === "create_experiment")!;
    expect(create.description).toMatch(/lower_is_better/);
    expect(create.description).toMatch(/higher_is_better/);
    expect(create.description).toMatch(/guardrail/);
  });
});
