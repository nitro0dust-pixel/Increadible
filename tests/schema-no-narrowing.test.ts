import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A schema that clients read must never refuse what the handler accepts (the item schemas, bounds and enums added to tools/list are
 * advisory, but a client that validates would turn every refusal into a call that never reaches the server). Each row below is run
 * through the real handler and through a small validator for exactly the keywords the schemas use, and the two answers are pinned.
 * The validator throws on a keyword it does not know, so a later keyword cannot be skipped in silence.
 */

type Schema = any;
const ANNOTATIONS = new Set(["description", "examples", "default"]);
const KEYWORDS = new Set(["type", "required", "properties", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "additionalProperties", "enum"]);
const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isFinite(v) ? "number" : "other") : typeof v);

/** violations of `value` against `schema`; empty when it fits */
function violations(schema: Schema, value: unknown, where = "$"): string[] {
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`validator does not know the keyword "${key}" at ${where}`);
  const out: string[] = [];
  if (schema.type !== undefined) {
    const allowed: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const name of allowed) if (!["object", "array", "string", "number", "boolean", "null"].includes(name)) throw new Error(`validator does not know the type "${name}" at ${where}`);
    if (!allowed.includes(kind(value))) return [`${where}: ${kind(value)} is not ${allowed.join("|")}`];
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${where}: not in enum`);
  if (typeof value === "string") {
    const length = [...value].length; // JSON Schema counts code points, never more than the UTF-16 units the handler counts
    if (schema.minLength !== undefined && length < schema.minLength) out.push(`${where}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) out.push(`${where}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${where}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => out.push(...violations(schema.items, item, `${where}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) if (!(name in object)) out.push(`${where}: missing ${name}`);
    for (const [name, sub] of Object.entries<Schema>(schema.properties ?? {})) if (name in object && object[name] !== undefined) out.push(...violations(sub, object[name], `${where}.${name}`));
    const extra = schema.additionalProperties;
    if (extra !== undefined && extra !== true && extra !== false && (extra === null || typeof extra !== "object")) throw new Error(`validator does not know additionalProperties ${JSON.stringify(extra)} at ${where}`);
    for (const [name, v] of Object.entries(object)) {
      if ((schema.properties ?? {})[name]) continue;
      if (extra === false) out.push(`${where}.${name}: not allowed`);
      else if (extra && typeof extra === "object") out.push(...violations(extra, v, `${where}.${name}`));
    }
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-no-narrowing-"));
let server: typeof import("../src/server");
let schemas: Record<string, Schema>;
const saved = { ...process.env };
beforeAll(async () => {
  process.env.RULES_FILE = path.join(tmp, "rules.yaml");
  process.env.EXPERIMENTS_FILE = path.join(tmp, "none.yaml");
  delete process.env.AB_DATA_FILE;
  for (const key of Object.keys(process.env)) if (/^GATEWAY_/.test(key)) delete process.env[key];
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.isolateModules(() => {
    server = require("../src/server");
  });
  const list: any = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  schemas = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t.inputSchema]));
  await call("create_experiment", { id: "rm", name: "n", hypothesis: "h", variants: [{ id: "A" }, { id: "B" }], metrics: [{ id: "quality" }, { id: "cost" }] });
});
afterAll(() => {
  jest.restoreAllMocks();
  process.env = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});
const call = async (name: string, args: Record<string, unknown>) => {
  const reply: any = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return { isError: !!reply.result.isError, text: reply.result.content[0].text as string };
};

let n = 0;
const V = (...ids: string[]) => ids.map((id) => ({ id }));
const exp = (over: Record<string, unknown> = {}) => ({ id: `e${++n}`, name: "n", hypothesis: "h", variants: V("A", "B"), metrics: [{ id: "m" }], ...over });
const rule = (over: Record<string, unknown> = {}) => ({ id: "r", provider: "p", priority: 1, enabled: true, match: {}, ...over });
const rules = (count: number) => Array.from({ length: count }, (_, i) => rule({ id: `r${i}`, priority: i }));
const calls = (count: number) => Array.from({ length: count }, () => ({ id: "hackernews", endpoint: "" }));
const rec = (metrics: unknown) => ({ experiment_id: "rm", variant_id: "A", metrics });

// [label, tool, args, what is pinned]: both = handler and schema accept; neither = both refuse; handlerOnly = the schema is STRICTER than the handler (pre-existing, listed on purpose)
type Row = [string, string, () => Record<string, unknown>, "both" | "neither" | "handlerOnly"];
const ROWS: Row[] = [
  ["rules []", "update_rules", () => ({ rules: [] }), "both"],
  ["a rule with only the required keys", "update_rules", () => ({ rules: [rule()] }), "both"],
  ["a rule with every optional key, an odd name and an extra key", "update_rules", () => ({ rules: [rule({ name: 5, reason: 7, tags: { a: 1 }, fallback: ["x"], extra: 1, priority: -1.5 })] }), "both"],
  ["equal priorities", "update_rules", () => ({ rules: [rule({ id: "a" }), rule({ id: "b" })] }), "both"],
  ["exactly 500 rules", "update_rules", () => ({ rules: rules(500) }), "both"],
  ["501 rules", "update_rules", () => ({ rules: rules(501) }), "neither"],
  ["enabled as text", "update_rules", () => ({ rules: [rule({ enabled: "yes" })] }), "neither"],
  ["match as a list", "update_rules", () => ({ rules: [rule({ match: [] })] }), "neither"],
  ["aggregate []", "aggregate_apis", () => ({ apis: [] }), "both"],
  ["aggregate exactly 100", "aggregate_apis", () => ({ apis: calls(100) }), "both"],
  ["aggregate 101", "aggregate_apis", () => ({ apis: calls(101) }), "neither"],
  ["aggregate item with an extra key", "aggregate_apis", () => ({ apis: [{ id: "hackernews", endpoint: "/x", extra: 1 }] }), "both"],
  ["aggregate params null, absent, nested", "aggregate_apis", () => ({ apis: [{ id: "hackernews", endpoint: "/x", params: null }, { id: "hackernews", endpoint: "/y" }, { id: "hackernews", endpoint: "/z", params: { a: { b: [1] } } }] }), "both"],
  ["aggregate item that names api_id", "aggregate_apis", () => ({ apis: [{ api_id: "hackernews", endpoint: "/x" }] }), "neither"],
  ["aggregate item without endpoint", "aggregate_apis", () => ({ apis: [{ id: "hackernews" }] }), "neither"],
  ["variants: two ids only", "create_experiment", () => exp(), "both"],
  ["variants: ten ids", "create_experiment", () => exp({ variants: V(..."abcdefghij".split("")) }), "both"],
  ["variants: eleven ids", "create_experiment", () => exp({ variants: V(..."abcdefghijk".split("")) }), "neither"],
  ["variants: one", "create_experiment", () => exp({ variants: V("A") }), "neither"],
  ["variants: no id", "create_experiment", () => exp({ variants: [{ name: "x" }, { name: "y" }] }), "neither"],
  ["variants: numeric name, string config, null config", "create_experiment", () => exp({ variants: [{ id: "A", name: 5, config: "s" }, { id: "B", config: null }] }), "both"],
  ["variant id of 200 characters", "create_experiment", () => exp({ variants: V("a".repeat(200), "B") }), "both"],
  ["variant id of 201 characters", "create_experiment", () => exp({ variants: V("a".repeat(201), "B") }), "neither"],
  ["metrics []", "create_experiment", () => exp({ metrics: [] }), "both"],
  ["metric with type, aggregation, extra, numeric name", "create_experiment", () => exp({ metrics: [{ id: "m", name: 5, type: "continuous", aggregation: "mean", extra: 1 }] }), "both"],
  ["metric with direction and guardrail", "create_experiment", () => exp({ metrics: [{ id: "m" }, { id: "c", direction: "lower_is_better", guardrail: true }] }), "both"],
  ["metric without id", "create_experiment", () => exp({ metrics: [{ name: "no id" }] }), "neither"],
  ["metric direction sideways", "create_experiment", () => exp({ metrics: [{ id: "m", direction: "sideways" }] }), "neither"],
  ["metric id of 200 characters", "create_experiment", () => exp({ metrics: [{ id: "a".repeat(200) }] }), "both"],
  ["weights for two variants", "create_experiment", () => exp({ weights: [1, 2] }), "both"],
  ["weights for ten variants", "create_experiment", () => exp({ variants: V(..."abcdefghij".split("")), weights: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), "both"],
  ["weights of one", "create_experiment", () => exp({ weights: [1] }), "neither"],
  ["traffic_split 0 and 1", "create_experiment", () => [exp({ traffic_split: 0 }), exp({ traffic_split: 1 })] as any, "both"],
  ["without name and hypothesis (the schema requires them, the handler does not)", "create_experiment", () => ({ id: `e${++n}`, variants: V("A", "B"), metrics: [{ id: "m" }] }), "handlerOnly"],
  ["name 5 and hypothesis 6 (the schema says string)", "create_experiment", () => exp({ name: 5, hypothesis: 6 }), "handlerOnly"],
  ["record_metric {}", "record_metric", () => rec({}), "both"],
  ["record_metric 1e15 and -1e15", "record_metric", () => rec({ quality: 1e15, cost: -1e15 }), "both"],
  ["record_metric 1e16", "record_metric", () => rec({ quality: 1e16 }), "neither"],
  ["record_metric a text value", "record_metric", () => rec({ quality: "5" }), "neither"],
  ["call_api endpoint of 2000 characters", "call_api", () => ({ api_id: "coingecko", endpoint: "x".repeat(2000) }), "both"],
  ["call_api endpoint ' ?#' and a full URL, nested params", "call_api", () => ({ api_id: "coingecko", endpoint: "https://x/y z?a#b", params: { q: { nested: [1] } } }), "both"],
  ["call_api params null", "call_api", () => ({ api_id: "coingecko", endpoint: "/x", params: null }), "both"],
  ["discover_apis {} and ''", "discover_apis", () => ({ query: "" }), "both"],
  ["discover_apis query null", "discover_apis", () => ({ query: null }), "handlerOnly"],
  ["assign_variant user_id null", "assign_variant", () => ({ experiment_id: "rm", user_id: null }), "handlerOnly"],
  ["assign_variant user_id 42", "assign_variant", () => ({ experiment_id: "rm", user_id: 42 }), "both"],
  ["apply_routing_rules {} (task_type is required in the schema only)", "apply_routing_rules", () => ({}), "handlerOnly"],
  ["apply_routing_rules task_type 123", "apply_routing_rules", () => ({ task_type: 123 }), "handlerOnly"],
  ["apply_routing_rules task_complexity bogus", "apply_routing_rules", () => ({ task_type: "qa", task_complexity: "bogus" }), "handlerOnly"],
  ["apply_routing_rules priority 7", "apply_routing_rules", () => ({ task_type: "qa", priority: 7 }), "handlerOnly"],
  ["apply_routing_rules response_sla 5 and an extra key", "apply_routing_rules", () => ({ task_type: "qa", response_sla: 5, team: "a" }), "handlerOnly"],
];

describe("what the schemas refuse against what the handlers accept", () => {
  it.each(ROWS)("%s", async (_label, tool, make, pinned) => {
    const made = make() as any;
    const argsList: Array<Record<string, unknown>> = Array.isArray(made) ? made : [made];
    for (const args of argsList) {
      const handler = !(await call(tool, args)).isError;
      const schema = violations(schemas[tool], args).length === 0;
      expect({ handler, schema }).toEqual({ both: { handler: true, schema: true }, neither: { handler: false, schema: false }, handlerOnly: { handler: true, schema: false } }[pinned]);
    }
  });

  it("the validator itself refuses: an unknown keyword throws, and a wrong type, bound and missing key are reported", () => {
    expect(() => violations({ type: "object", pattern: "x" }, {})).toThrow(/does not know the keyword "pattern"/);
    expect(() => violations({ type: "integer" }, 1)).toThrow(/does not know the type "integer"/);
    expect(violations({ type: "object", additionalProperties: false }, { a: 1 })).toHaveLength(1);
    expect(violations({ type: "object", additionalProperties: { type: "number" } }, { a: "x" })).toHaveLength(1);
    expect(violations({ type: "array", maxItems: 1 }, [1, 2])).toHaveLength(1);
    expect(violations({ type: "object", required: ["id"] }, {})).toHaveLength(1);
    expect(violations({ type: ["string", "number"] }, null)).toHaveLength(1);
    expect(violations({ type: "number", maximum: 1 }, 2)).toHaveLength(1);
  });

  it("ties each number in the schemas to the handler: accepted at the bound, refused one beyond", async () => {
    const bound = (tool: string, ...path: string[]) => path.reduce((node: any, key) => node[key], schemas[tool]);
    expect(bound("aggregate_apis", "properties", "apis", "maxItems")).toBe(100);
    expect(bound("update_rules", "properties", "rules", "maxItems")).toBe(500);
    expect([bound("create_experiment", "properties", "variants", "minItems"), bound("create_experiment", "properties", "variants", "maxItems")]).toEqual([2, 10]);
    expect(bound("create_experiment", "properties", "variants", "items", "properties", "id", "maxLength")).toBe(200);
    expect(bound("create_experiment", "properties", "metrics", "items", "properties", "id", "maxLength")).toBe(200);
    expect(bound("record_metric", "properties", "metrics", "additionalProperties", "maximum")).toBe(1e15);
    expect(bound("record_metric", "properties", "metrics", "additionalProperties", "minimum")).toBe(-1e15);
  });
});
