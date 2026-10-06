import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ABTestingFramework } from "../features/08-ab-testing/src/mcp-server";
import { GoldenDataset, fuzzDataset, namedDatasets, toJsonl } from "./helpers/ab-golden-data";
import golden from "./fixtures/ab-golden.json";

/**
 * The A/B module keeps running aggregates per variant and metric instead of every measurement (roadmap step 9).
 * tests/fixtures/ab-golden.json holds what the previous implementation (every measurement in an array) answered for
 * 120 datasets: the new one must give the same answers, recording live and replaying the data file, whatever the read size.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-ab-golden-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const noExperimentsFile = path.join(tmp, "no-experiments.yaml");
const datasets: GoldenDataset[] = [...namedDatasets(), ...Array.from({ length: 100 }, (_, i) => fuzzDataset(i + 1))];
const expected = golden.datasets as Record<string, { results: unknown; recommendation: string; sample_count: number }>;

let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

const snapshot = (fw: ABTestingFramework, id: string) => ({
  results: JSON.parse(JSON.stringify(fw.getExperimentResults(id))),
  recommendation: fw.recommendWinner(id),
  sample_count: fw.listExperiments().find((e) => e.id === id)?.sample_count,
});

function replayed(d: GoldenDataset, replayChunkBytes?: number): { fw: ABTestingFramework; file: string } {
  const file = path.join(tmp, `${d.name}-${replayChunkBytes ?? "default"}.jsonl`);
  fs.writeFileSync(file, toJsonl(d));
  return { fw: new ABTestingFramework(noExperimentsFile, file, { replayChunkBytes }), file };
}

/** Names of the datasets whose answer differs from the stored one (with the first difference, to read in the failure). */
function mismatches(answer: (d: GoldenDataset) => ReturnType<typeof snapshot>, only: GoldenDataset[] = datasets): string[] {
  return only
    .filter((d) => JSON.stringify(answer(d)) !== JSON.stringify(expected[d.name]))
    .map((d) => `${d.name}: got ${JSON.stringify(answer(d)).slice(0, 300)} want ${JSON.stringify(expected[d.name]).slice(0, 300)}`);
}

describe("running aggregates reproduce the stored answers", () => {
  it("the fixture covers every dataset, including incomplete, complete and winning ones", () => {
    expect(Object.keys(expected).sort()).toEqual(datasets.map((d) => d.name).sort());
    const statuses = datasets.map((d) => (expected[d.name].results as any).status);
    expect(statuses).toContain("incomplete");
    expect(statuses).toContain("complete");
    expect(datasets.some((d) => (expected[d.name].results as any).winner)).toBe(true);
    expect(datasets.some((d) => (expected[d.name].results as any).statistical_analysis?.p_values?.conv === 0)).toBe(true);
  });

  it("when measurements are recorded live", () => {
    expect(
      mismatches((d) => {
        const fw = new ABTestingFramework(noExperimentsFile);
        fw.createExperiment(d.experiment);
        for (const m of d.measurements) fw.recordMetric(d.experiment.id, m.variant_id, m.metrics);
        return snapshot(fw, d.experiment.id);
      })
    ).toEqual([]);
  });

  it("when the data file is replayed at startup", () => {
    expect(
      mismatches((d) => {
        const { fw } = replayed(d);
        try {
          return snapshot(fw, d.experiment.id);
        } finally {
          fw.close();
        }
      })
    ).toEqual([]);
  });

  it.each([7, 61, 4096])("when the data file is replayed %i bytes at a time", (chunk) => {
    expect(
      mismatches(
        (d) => {
          const { fw } = replayed(d, chunk);
          try {
            return snapshot(fw, d.experiment.id);
          } finally {
            fw.close();
          }
        },
        namedDatasets()
      )
    ).toEqual([]);
  });
});

describe("replaying the data file in chunks", () => {
  // Lines of every kind a data file can hold, with multi-byte characters in the names so that a read boundary can fall
  // inside a character: UTF-8 for an experiment name, a blank line, an unreadable line, a measurement for an unknown
  // experiment, CRLF line endings, and a last line torn by a crash (no newline). Valid measurements: 120 plus the CRLF one;
  // unreadable: the broken line, the unknown type and the torn tail; orphaned: the one for the unknown experiment.
  const experiment = {
    ...namedDatasets()[0].experiment,
    id: "exp-ünï",
    name: "実験 ✓ 𝒳",
  };
  const measurement = (i: number, extra: object = {}) =>
    JSON.stringify({
      type: "measurement",
      experiment_id: experiment.id,
      variant_id: i % 2 ? "control" : "treatment",
      metrics: { conv: 10 + (i % 5), rev: i },
      timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      ...extra,
    });
  const lines = [
    JSON.stringify({ type: "experiment", experiment }),
    ...Array.from({ length: 120 }, (_, i) => measurement(i)),
    "",
    "{this is not json",
    JSON.stringify({ type: "measurement", experiment_id: "unknown", variant_id: "x", metrics: { a: 1 }, timestamp: "t" }),
    JSON.stringify({ type: "noise" }),
    measurement(121) + "\r", // CRLF
  ];
  const whole = lines.join("\n") + "\n" + measurement(122).slice(0, 40); // torn last line

  const open = (content: string, chunk?: number) => {
    const file = path.join(tmp, `chunks-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(file, content);
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    let fw: ABTestingFramework;
    let log: string;
    try {
      fw = new ABTestingFramework(noExperimentsFile, file, { replayChunkBytes: chunk });
      log = spy.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith("Restored")) ?? "";
    } finally {
      spy.mockRestore();
    }
    const state = {
      listed: fw.listExperiments(),
      results: JSON.stringify(fw.getExperimentResults(experiment.id)),
      log: log.replace(file, "<file>"),
      afterwards: fs.readFileSync(file, "utf8"),
    };
    fw.close();
    return state;
  };

  let memo: ReturnType<typeof open> | undefined;
  const reference = () => (memo ??= open(whole));

  it("the reference replay counts what it should", () => {
    expect(reference().log).toBe(
      "Restored 1 experiments and 121 measurements from <file> (skipped 3 unreadable lines, dropped 1 orphaned measurements)"
    );
    expect(reference().listed).toEqual([{ id: experiment.id, name: "実験 ✓ 𝒳", status: "setup", sample_count: 121 }]);
  });

  it("gives the same state for every read size from 1 byte to past the end of the file", () => {
    const bad: number[] = [];
    const sizes = [...Array.from({ length: 320 }, (_, i) => i + 1), 1000, 4096, 8191, Buffer.byteLength(whole) - 1, Buffer.byteLength(whole), Buffer.byteLength(whole) + 1];
    for (const chunk of sizes) {
      if (JSON.stringify(open(whole, chunk)) !== JSON.stringify(reference())) bad.push(chunk);
    }
    expect(bad).toEqual([]);
  });

  it("terminates a torn last line so the next append starts on its own line, and leaves a complete file alone", () => {
    expect(reference().afterwards).toBe(whole + "\n");
    const complete = lines.join("\n") + "\n";
    expect(open(complete, 13).afterwards).toBe(complete);
  });

  it("handles an empty file and a file of blank lines", () => {
    for (const content of ["", "\n", "\n\n\n", "   \n\t\n"]) {
      const state = open(content, 2);
      expect(state.listed).toEqual([]);
      expect(state.log).toBe("Restored 0 experiments and 0 measurements from <file>");
      expect(state.afterwards).toBe(content);
    }
  });

  it("a file whose only content is a torn line is terminated and counted as unreadable", () => {
    const state = open('{"type":"measurement","experi', 5);
    expect(state.log).toBe("Restored 0 experiments and 0 measurements from <file> (skipped 1 unreadable lines, dropped 0 orphaned measurements)");
    expect(state.afterwards).toBe('{"type":"measurement","experi\n');
  });
});

describe("series of identical values", () => {
  const experiment = { ...namedDatasets()[0].experiment, id: "constant", metrics: [namedDatasets()[0].experiment.metrics[0]] };
  const answer = (control: number, treatment: number, nControl: number, nTreatment: number) => {
    const fw = new ABTestingFramework(noExperimentsFile);
    fw.createExperiment(experiment);
    for (let i = 0; i < Math.max(nControl, nTreatment); i++) {
      if (i < nControl) fw.recordMetric("constant", "control", { conv: control });
      if (i < nTreatment) fw.recordMetric("constant", "treatment", { conv: treatment });
    }
    return fw.getExperimentResults("constant")!;
  };

  it("two identical constants are never told apart, whatever the values and sample sizes", () => {
    // 59 times 0.1 is not exactly 5.9: a mean computed as sum / n would differ between 59 and 60 samples by a rounding error.
    for (const c of [0.1, 0.7, 1 / 3, 123456.789, -0.3]) {
      for (const [a, b] of [[59, 60], [30, 80], [100, 31], [50, 50], [47, 53]]) {
        const r = answer(c, c, a, b);
        expect(r.statistical_analysis.p_values).toEqual({ conv: 1 });
        expect(r.statistical_analysis.effect_sizes).toEqual({ conv: 0 });
        expect(r.winner).toBeUndefined();
        expect(r.confidence).toBe(0);
      }
    }
  });

  it("two different constants are told apart with certainty, and the higher one wins", () => {
    const r = answer(0.1, 0.2, 59, 60);
    expect(r.statistical_analysis.p_values).toEqual({ conv: 0 });
    expect(r.winner).toBe("treatment");
    expect(r.confidence).toBe(1);
    expect(answer(0.2, 0.1, 59, 60).winner).toBe("control");
  });
});

describe("the module no longer holds one record per measurement", () => {
  it("keeps only a handful of numbers per experiment, however many measurements it has seen", () => {
    const d = namedDatasets()[0];
    const fw = new ABTestingFramework(noExperimentsFile);
    fw.createExperiment(d.experiment);
    for (let i = 0; i < 20_000; i++) fw.recordMetric(d.experiment.id, i % 2 ? "control" : "treatment", { conv: i % 9, rev: i });
    // Nothing the instance holds may scale with the 20 000 measurements: no array or map close to that size, at any depth.
    const sizes: number[] = [];
    const walk = (v: unknown, depth: number): void => {
      if (!v || typeof v !== "object" || depth > 6) return;
      if (Array.isArray(v)) sizes.push(v.length);
      if (v instanceof Map) sizes.push(v.size);
      const children = v instanceof Map ? [...v.values()] : Object.values(v as object);
      for (const c of children) walk(c, depth + 1);
    };
    walk(fw, 0);
    expect(Math.max(...sizes)).toBeLessThan(100);
    expect(fw.listExperiments()[0].sample_count).toBe(20_000);
  });

  it("a measurement without a metrics object counts as a sample and no longer makes the results call throw", () => {
    const d = namedDatasets()[0];
    const fw = new ABTestingFramework(noExperimentsFile);
    fw.createExperiment(d.experiment);
    for (let i = 0; i < 120; i++) fw.recordMetric(d.experiment.id, i % 2 ? "control" : "treatment", undefined as any);
    const r = fw.getExperimentResults(d.experiment.id)!;
    expect(r.status).toBe("complete");
    expect(r.statistical_analysis.p_values).toEqual({});
    expect(fw.listExperiments()[0].sample_count).toBe(120);
  });
});
