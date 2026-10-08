import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ABTestingFramework, processToolCall } from "../features/08-ab-testing/src/mcp-server";

/**
 * Guards of the A/B module that no test exercised until the audit (the coverage report listed their lines as never run):
 * the range of traffic_split, the shape of an experiment, a measurement for a variant that is not in the experiment, what replay
 * does with a stored experiment that is no longer valid, and what start-up does with an unreadable or empty experiments file.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-ab-guards-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const none = path.join(tmp, "none.yaml");
let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());
const logged = () => errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

const exp = (extra: Record<string, unknown> = {}): any => ({
  id: "e", name: "e", hypothesis: "h", status: "setup", traffic_split: 0.5,
  variants: [{ id: "A", name: "A", config: {} }, { id: "B", name: "B", config: {} }],
  metrics: [{ id: "cost", name: "cost", type: "continuous", aggregation: "mean" }],
  ...extra,
});

describe("traffic_split", () => {
  it.each([-0.1, 1.1, NaN, Infinity, -Infinity, "0.5", null, undefined])("is refused when it is %p", (bad) => {
    expect(() => new ABTestingFramework(none).createExperiment(exp({ traffic_split: bad }))).toThrow("traffic_split must be a number between 0 and 1");
  });

  it.each([0, 0.5, 1])("accepts %p, the ends of the range included", (ok) => {
    expect(() => new ABTestingFramework(none).createExperiment(exp({ traffic_split: ok }))).not.toThrow();
  });
});

describe("the shape of an experiment", () => {
  it.each([5, null, undefined, {}])("needs a string id (not %p)", (id) => {
    expect(() => new ABTestingFramework(none).createExperiment(exp({ id }))).toThrow("Experiment must have a string id");
  });

  it.each(["cost", null, undefined, { cost: 1 }])("needs a metrics array (not %p)", (metrics) => {
    expect(() => new ABTestingFramework(none).createExperiment(exp({ metrics }))).toThrow("Experiment must define a metrics array");
  });

  it("answers an unknown tool name with an error, not an exception", async () => {
    expect(JSON.parse(await processToolCall("no_such_tool", {}))).toEqual({ error: "Unknown tool" });
  });
});

describe("a measurement for a variant that is not in the experiment", () => {
  it("is refused and leaves the data file and the results as they were", () => {
    const file = path.join(tmp, "unknown-variant.jsonl");
    const fw = new ABTestingFramework(none, file);
    fw.createExperiment(exp());
    fw.recordMetric("e", "A", { cost: 1 });
    const before = fs.readFileSync(file, "utf8");
    expect(() => fw.recordMetric("e", "Z", { cost: 1 })).toThrow("Variant Z is not part of experiment e");
    expect(() => fw.recordMetric("e", "__proto__", { cost: 1 })).toThrow("is not part of experiment e");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect((fw.getExperimentResults("e") as any).statistical_analysis.current_samples).toBe(1); // only the valid measurement
    fw.close();
  });
});

describe("replay of a data file that holds an experiment which is no longer valid", () => {
  it("skips it, drops its measurements, restores everything else, and says how many", () => {
    const file = path.join(tmp, "replay-invalid.jsonl");
    const writer = new ABTestingFramework(none, file);
    writer.createExperiment(exp());
    writer.recordMetric("e", "A", { cost: 1 });
    writer.close();
    const invalid = { ...exp({ id: "bad" }), variants: [{ id: "A", name: "A", config: {} }] }; // a single variant: not an experiment
    fs.appendFileSync(
      file,
      [
        JSON.stringify({ type: "experiment", experiment: invalid }),
        JSON.stringify({ type: "measurement", experiment_id: "bad", variant_id: "A", metrics: { cost: 5 } }),
        JSON.stringify({ type: "measurement", experiment_id: "e", variant_id: "B", metrics: { cost: 2 } }),
      ].join("\n") + "\n"
    );
    const reader = new ABTestingFramework(none, file);
    expect(reader.hasExperiment("e")).toBe(true);
    expect(reader.hasExperiment("bad")).toBe(false);
    expect((reader.getExperimentResults("e") as any).statistical_analysis.current_samples).toBe(2); // the one of "bad" is not among them
    expect(logged()).toContain("Restored 1 experiments and 2 measurements");
    expect(logged()).toContain("skipped 1 unreadable lines, dropped 1 orphaned measurements");
    reader.close();
  });
});

describe("the experiments file at start-up", () => {
  it("an empty file means no experiments, and is not an error", () => {
    const file = path.join(tmp, "empty.yaml");
    fs.writeFileSync(file, "");
    const fw = new ABTestingFramework(file);
    expect(fw.hasExperiment("e")).toBe(false);
    expect(logged()).toContain("Loaded 0 experiments");
    expect(logged()).not.toContain("Error loading experiments");
  });

  it("a file that is not YAML is reported and does not stop the server", () => {
    const file = path.join(tmp, "broken.yaml");
    fs.writeFileSync(file, "experiments: [unclosed");
    const fw = new ABTestingFramework(file);
    expect(fw.hasExperiment("e")).toBe(false);
    expect(logged()).toContain("Error loading experiments");
  });

  it("an experiment in it that is not valid is skipped by name of the problem, the valid ones load", () => {
    const file = path.join(tmp, "mixed.yaml");
    fs.writeFileSync(
      file,
      "experiments:\n" +
        "  - {id: good, name: g, hypothesis: h, traffic_split: 0.5, variants: [{id: A, name: A, config: {}}, {id: B, name: B, config: {}}], metrics: []}\n" +
        "  - {id: wide, name: w, hypothesis: h, traffic_split: 3, variants: [{id: A, name: A, config: {}}, {id: B, name: B, config: {}}], metrics: []}\n" +
        "  - {id: nan, name: n, hypothesis: h, traffic_split: .nan, variants: [{id: A, name: A, config: {}}, {id: B, name: B, config: {}}], metrics: []}\n"
    );
    const fw = new ABTestingFramework(file);
    expect(fw.hasExperiment("good")).toBe(true);
    expect(fw.hasExperiment("wide")).toBe(false);
    expect(fw.hasExperiment("nan")).toBe(false);
    expect(logged()).toContain("Skipping invalid experiment: traffic_split must be a number between 0 and 1");
    expect(logged()).toContain("Loaded 1 experiments");
  });
});
