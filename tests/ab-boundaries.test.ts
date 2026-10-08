import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ABTestingFramework, Experiment } from "../features/08-ab-testing/src/mcp-server";

/**
 * Edges of the A/B module that no test pinned until the mutation-testing pass of the audit: the lock at the exact ages where it
 * is judged, the exit hook, what start-up replays and says, every limit at the limit, the draw at the exact split, the options
 * and the environment, the multi-variant and guardrail decisions in the cases that were never run, and what the tools do with
 * the answer. A mutation of each line below (a `>` made `>=`, a branch removed, a call deleted) passed the whole suite before.
 */

const realFs: typeof fs = require("fs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-ab-edges-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
const tracked: ABTestingFramework[] = [];
afterEach(() => {
  for (const ab of tracked.splice(0)) ab.close();
  jest.restoreAllMocks();
});

let counter = 0;
const fileIn = (name: string) => path.join(tmp, `${counter++}-${name}`);
const NO_YAML = path.join(tmp, "no-such-experiments.yaml");
const open = (dataFile?: string, options?: ConstructorParameters<typeof ABTestingFramework>[2], yamlFile = NO_YAML) => {
  const ab = new ABTestingFramework(yamlFile, dataFile, options);
  tracked.push(ab);
  return ab;
};
const lockOf = (file: string) => `${file}.lock`;
const logged = () => errors.mock.calls.map((c) => c.map(String).join(" "));

function exp(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: "exp-1",
    name: "n",
    hypothesis: "h",
    status: "running",
    variants: [
      { id: "A", name: "a", config: {} },
      { id: "B", name: "b", config: {} },
    ],
    traffic_split: 0.5,
    metrics: [{ id: "quality", name: "Quality", type: "continuous", aggregation: "mean" }],
    ...overrides,
  } as Experiment;
}
const experimentLine = (e: Experiment) => JSON.stringify({ type: "experiment", experiment: e });
const measurementLine = (variant: string, metrics: unknown, experiment = "exp-1") =>
  JSON.stringify({ type: "measurement", experiment_id: experiment, variant_id: variant, metrics, timestamp: "t" });

describe("the lock, judged at the exact ages", () => {
  const T = 1_800_000_000_000;
  const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid!;
  const plant = (file: string, info: Record<string, unknown>, ageMs: number) => {
    fs.writeFileSync(lockOf(file), JSON.stringify({ ...info, started: "earlier", token: "someone-else" }));
    const t = new Date(T - ageMs);
    fs.utimesSync(lockOf(file), t, t);
  };
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(T)); // the clock stands still, so an age is exactly what was planted

  it("holds a lock from another machine that was refreshed exactly 15 s ago as 'cannot be checked', and takes it over 1 ms later", () => {
    const file = fileIn("age15.jsonl");
    plant(file, { pid: 1, host: "some-other-pod" }, 15_000);
    expect(() => open(file, { lockWaitMs: 0 })).toThrow(/held by pid 1 on some-other-pod \(started earlier\) and was refreshed in the last 15s, but that process could not be checked from here/);
    plant(file, { pid: 1, host: "some-other-pod" }, 15_001);
    expect(() => open(file, { lockWaitMs: 0 })).not.toThrow();
    expect(fs.readdirSync(tmp).filter((f) => f.includes(".stale-"))).toEqual([]); // the lock moved aside is removed
  });

  it("waits for a dead local holder whose lock is 6 s old and takes over one that is 6.001 s old", () => {
    const file = fileIn("age6.jsonl");
    plant(file, { pid: deadPid(), host: os.hostname() }, 6_000);
    expect(() => open(file, { lockWaitMs: 0 })).toThrow(/could not be checked from here/);
    plant(file, { pid: deadPid(), host: os.hostname() }, 6_001);
    expect(() => open(file, { lockWaitMs: 0 })).not.toThrow();
  });

  it("counts a process it may not signal (EPERM) as alive, and one that is gone (ESRCH) as dead", () => {
    const file = fileIn("perm.jsonl");
    const kill = jest.spyOn(process, "kill");
    plant(file, { pid: 4_242_424, host: os.hostname() }, 0);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    expect(() => open(file, { lockWaitMs: 0 })).toThrow(/in use by pid 4242424 on /);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(() => open(file, { lockWaitMs: 0 })).toThrow(/could not be checked from here/); // dead, but too recent to be sure
  });

  it("reads a lock as naming a holder only when it has a numeric pid and a text host", () => {
    for (const [name, body] of [
      ["pid-only", { pid: 7 }],
      ["host-only", { host: "h" }],
      ["pid-as-text", { pid: "7", host: "h" }],
      ["host-as-number", { pid: 7, host: 9 }],
    ] as const) {
      const file = fileIn(`${name}.jsonl`);
      fs.writeFileSync(lockOf(file), JSON.stringify(body));
      fs.utimesSync(lockOf(file), new Date(T), new Date(T));
      expect(() => open(file, { lockWaitMs: 0 })).toThrow(/held by an unknown process/);
    }
    const nullLock = fileIn("null.jsonl");
    fs.writeFileSync(lockOf(nullLock), "null");
    fs.utimesSync(lockOf(nullLock), new Date(T), new Date(T));
    expect(() => open(nullLock, { lockWaitMs: 0 })).toThrow(/held by an unknown process/);
  });

  it("does not wait on an error that is not 'the lock exists'", () => {
    const file = fileIn("denied.jsonl");
    const real = realFs.writeFileSync;
    jest.spyOn(realFs, "writeFileSync").mockImplementation(((target: any, ...rest: any[]) => {
      if (String(target).endsWith(".lock")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return (real as any)(target, ...rest);
    }) as any);
    expect(() => open(file)).toThrow(/Cannot use A\/B data file .*EACCES: permission denied/);
  });
});

describe("the lock, for as long as it is held", () => {
  it("is refreshed by a timer that does not keep the process alive, and the timer is stopped on close", () => {
    const ab = open(fileIn("timer.jsonl"));
    const timer = (ab as any).lock.timer as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    const clear = jest.spyOn(global, "clearInterval");
    ab.close();
    expect(clear).toHaveBeenCalledWith(timer);
  });

  it("is released at process exit for every instance, with one exit hook for all of them", () => {
    const onSpy = jest.spyOn(process, "on");
    let fresh!: typeof import("../features/08-ab-testing/src/mcp-server");
    jest.isolateModules(() => {
      fresh = require("../features/08-ab-testing/src/mcp-server");
    });
    const [a, b] = [fileIn("exit-a.jsonl"), fileIn("exit-b.jsonl")];
    const first = new fresh.ABTestingFramework(NO_YAML, a);
    const second = new fresh.ABTestingFramework(NO_YAML, b);
    const exitHooks = onSpy.mock.calls.filter((call) => call[0] === "exit");
    expect(exitHooks).toHaveLength(1);
    expect(fs.existsSync(lockOf(a)) && fs.existsSync(lockOf(b))).toBe(true);
    (exitHooks[0][1] as () => void)(); // what the process does when it exits
    expect(fs.existsSync(lockOf(a))).toBe(false);
    expect(fs.existsSync(lockOf(b))).toBe(false);
    first.close();
    second.close();
  });

  it("is not deleted by an exit hook when another process took it over", () => {
    const onSpy = jest.spyOn(process, "on");
    let fresh!: typeof import("../features/08-ab-testing/src/mcp-server");
    jest.isolateModules(() => {
      fresh = require("../features/08-ab-testing/src/mcp-server");
    });
    const file = fileIn("exit-taken.jsonl");
    const ab = new fresh.ABTestingFramework(NO_YAML, file);
    fs.writeFileSync(lockOf(file), JSON.stringify({ pid: 1, host: "x", started: "t", token: "someone-else" }));
    (onSpy.mock.calls.find((call) => call[0] === "exit")![1] as () => void)();
    expect(JSON.parse(fs.readFileSync(lockOf(file), "utf-8")).token).toBe("someone-else");
    ab.close();
  });
});

describe("what start-up does with the options", () => {
  it("uses 100 MiB, 1 MiB reads and 17 s of waiting unless told otherwise, and ignores a value that is not positive", () => {
    const defaults = open(fileIn("defaults.jsonl")) as any;
    expect([defaults.warnBytes, defaults.replayChunkBytes, defaults.lockWaitMs]).toEqual([100 * 1024 * 1024, 1024 * 1024, 17_000]);
    for (const bad of [0, -5, NaN]) {
      const ab = open(fileIn("bad-option.jsonl"), { warnBytes: bad, replayChunkBytes: bad }) as any;
      expect([ab.warnBytes, ab.replayChunkBytes]).toEqual([100 * 1024 * 1024, 1024 * 1024]);
      ab.close();
    }
    const set = open(fileIn("set.jsonl"), { warnBytes: 5, replayChunkBytes: 7, lockWaitMs: 0 }) as any;
    expect([set.warnBytes, set.replayChunkBytes, set.lockWaitMs]).toEqual([5, 7, 0]);
  });

  it("flushes the new data file and its directory when asked to, and an existing one not at all", () => {
    const flush = jest.spyOn(realFs, "fsyncSync");
    const file = fileIn("fsync-new.jsonl");
    open(file, { fsync: true }).close();
    expect(flush).toHaveBeenCalledTimes(2); // the file, then the directory entry
    flush.mockClear();
    open(file, { fsync: true }).close(); // it exists now: nothing is created, nothing to flush
    expect(flush).not.toHaveBeenCalled();
    open(fileIn("fsync-off.jsonl")).close();
    expect(flush).not.toHaveBeenCalled();
  });

  it("fails when flushing the file fails, and carries on when only flushing the directory fails", () => {
    const real = realFs.fsyncSync;
    let calls = 0;
    jest.spyOn(realFs, "fsyncSync").mockImplementation(((fd: number) => {
      if (++calls === 2) throw new Error("EINVAL: cannot flush a directory here");
      return real(fd);
    }) as any);
    expect(() => open(fileIn("dir-fsync.jsonl"), { fsync: true })).not.toThrow();
    jest.restoreAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(realFs, "fsyncSync").mockImplementation(() => {
      throw new Error("EIO: input/output error");
    });
    expect(() => open(fileIn("file-fsync.jsonl"), { fsync: true })).toThrow(/Cannot use A\/B data file .*EIO/);
  });

  it("closes every file it opens, in start-up and in every flush", () => {
    const file = fileIn("fds.jsonl");
    open(file).close();
    const opened = jest.spyOn(realFs, "openSync");
    const closed = jest.spyOn(realFs, "closeSync");
    const ab = open(file, { fsync: true });
    ab.createExperiment(exp());
    ab.recordMetric("exp-1", "A", { quality: 1 });
    expect(opened.mock.calls.length).toBeGreaterThan(1);
    expect(closed).toHaveBeenCalledTimes(opened.mock.calls.length);
  });
});

describe("what replaying a data file does with each line", () => {
  const prepare = (lines: string[], ending = "\n") => {
    const file = fileIn("replay.jsonl");
    fs.writeFileSync(file, lines.join("\n") + ending);
    return file;
  };
  const summary = () => logged().find((line) => line.startsWith("Restored")) ?? "";
  const samplesOf = (ab: ABTestingFramework) => (ab.getExperimentResults("exp-1")!.statistical_analysis as any).current_samples;

  it("counts what it kept, skipped and dropped, line by line", () => {
    const file = prepare([
      experimentLine(exp()),
      "", // blank lines are not lines
      "   ",
      measurementLine("A", { quality: 1 }),
      measurementLine("B", { quality: 2 }),
      measurementLine("A", undefined), // no values: still a sample
      "null", // JSON, but not a log entry
      "5",
      '{"type":"something-else"}',
      "{torn",
      experimentLine({ ...exp({ id: "bad" }), variants: [] } as Experiment), // fails validation
      measurementLine("Z", { quality: 1 }), // a variant the experiment does not have
      measurementLine("A", { quality: "5" }), // a number as text
      measurementLine("A", { quality: null }), // what JSON makes of NaN or Infinity
      measurementLine("A", { quality: 1 }, "no-such-experiment"),
    ]);
    const ab = open(file);
    expect(summary()).toBe(`Restored 1 experiments and 3 measurements from ${file} (skipped 5 unreadable lines, dropped 4 orphaned measurements)`);
    expect(samplesOf(ab)).toBe(3);
  });

  it("counts a measurement whose metrics are null as a sample without values", () => {
    const file = prepare([experimentLine(exp()), JSON.stringify({ type: "measurement", experiment_id: "exp-1", variant_id: "A", metrics: null, timestamp: "t" }), measurementLine("A", { quality: 1 })]);
    const ab = open(file);
    expect(summary()).toBe(`Restored 1 experiments and 2 measurements from ${file}`);
    expect(samplesOf(ab)).toBe(2);
  });

  it("keeps the underlying error as the cause when the data file cannot be used", () => {
    const dir = fileIn("dir-as-data-file.jsonl");
    fs.mkdirSync(dir);
    let thrown: any;
    try {
      open(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message).toMatch(/^Cannot use A\/B data file .*EISDIR/);
    expect(thrown.cause?.code).toBe("EISDIR"); // the original error, not a copy of its message (it comes from another realm, so no instanceof)
  });

  it("creates the data file readable by its owner only, also when it has to create it again", () => {
    const file = fileIn("private.jsonl");
    const ab = open(file);
    ab.createExperiment(exp());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(file);
    const previous = process.umask(0o022); // the usual default: without an explicit mode the new file would be 0644
    try {
      ab.recordMetric("exp-1", "A", { quality: 1 });
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("restores a clean file without the parenthesis", () => {
    const file = prepare([experimentLine(exp()), measurementLine("A", { quality: 1 })]);
    open(file);
    expect(summary()).toBe(`Restored 1 experiments and 1 measurements from ${file}`);
  });

  it("keeps the experiment from the YAML file when the log defines the same id", () => {
    const yamlFile = fileIn("authoritative.yaml");
    fs.writeFileSync(yamlFile, require("yaml").stringify({ experiments: [exp({ name: "from the yaml file" })] }));
    const file = prepare([experimentLine(exp({ name: "from the log" }))]);
    const ab = open(file, undefined, yamlFile);
    expect(ab.listExperiments().map((e) => e.name)).toEqual(["from the yaml file"]);
    expect(summary()).toContain("Restored 0 experiments");
  });

  it("gives the same answer whatever size the reads are, including a character split between two reads", () => {
    const lines = [experimentLine(exp({ name: "naïve — 日本語 😀" })), ...Array.from({ length: 12 }, (_, i) => measurementLine(i % 2 ? "A" : "B", { quality: i }))];
    const file = prepare(lines, "\n");
    const reference = open(file);
    const expected = { names: reference.listExperiments(), samples: samplesOf(reference), summary: summary() };
    reference.close();
    for (const chunk of [1, 2, 3, 5, 7, 13, 64, lines[0].length, lines[0].length + 1, 100_000]) {
      errors.mockClear();
      const ab = open(file, { replayChunkBytes: chunk });
      expect({ names: ab.listExperiments(), samples: samplesOf(ab), summary: summary() }).toEqual(expected);
      ab.close();
    }
    expect(expected.names[0].name).toBe("naïve — 日本語 😀");
    expect(expected.samples).toBe(12);
  });

  it("passes on a last line that has no newline, ends it with one, and counts that byte", () => {
    const file = prepare([experimentLine(exp()), measurementLine("A", { quality: 1 })], ""); // torn: no final newline
    const size = fs.statSync(file).size;
    // The next measurement is this long; the limit is set so that only the extra newline byte puts the file over it.
    const next = Buffer.byteLength(JSON.stringify({ type: "measurement", experiment_id: "exp-1", variant_id: "A", metrics: { quality: 1 }, timestamp: new Date().toISOString() }) + "\n");
    const ab = open(file, { warnBytes: size + next });
    expect(samplesOf(ab)).toBe(1);
    expect(fs.readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
    expect(fs.statSync(file).size).toBe(size + 1);
    expect(logged().some((line) => line.includes("It is never compacted"))).toBe(false);
    ab.recordMetric("exp-1", "A", { quality: 1 });
    expect(fs.statSync(file).size).toBe(size + 1 + next);
    expect(logged().some((line) => line.includes("It is never compacted"))).toBe(true); // size + 1 + next is over size + next
  });

  it("warns once the file is over the limit, not at it, and reports the size in whole MiB", () => {
    const file = fileIn("big.jsonl");
    fs.writeFileSync(file, "\n".repeat(3 * 1048576));
    open(file, { warnBytes: 3 * 1048576 }).close();
    expect(logged().some((line) => line.includes("It is never compacted"))).toBe(false);
    open(file, { warnBytes: 3 * 1048576 - 1 });
    expect(logged()).toContain(`A/B data file ${file} is 3 MB. It is never compacted: plan a rollup or rotation before it grows much further (see DEPLOYMENT.md)`);
  });
});

describe("the limits on a new experiment, at the limit", () => {
  const ids = (n: number) => "i".repeat(n);

  it("allows an id of 200 characters and refuses 201, for experiments, variants and metrics", () => {
    const withIds = (e: number, v: number, m: number) =>
      exp({ id: ids(e), variants: [{ id: ids(v), name: "a", config: {} }, { id: "B", name: "b", config: {} }], metrics: [{ id: ids(m), name: "m", type: "continuous", aggregation: "mean" }] });
    expect(() => open().createExperiment(withIds(200, 200, 200))).not.toThrow();
    expect(() => open().createExperiment(withIds(201, 1, 1))).toThrow("Experiment id is longer than 200 characters");
    expect(() => open().createExperiment(withIds(1, 201, 1))).toThrow("Variant id is longer than 200 characters");
    expect(() => open().createExperiment(withIds(1, 1, 201))).toThrow("Metric id is longer than 200 characters");
  });

  it("allows a definition of exactly 64 KiB and refuses one character more", () => {
    const sized = (extra: number) => exp({ hypothesis: "x".repeat(extra) });
    const base = JSON.stringify(sized(0)).length;
    expect(JSON.stringify(sized(65_536 - base)).length).toBe(65_536);
    expect(() => open().createExperiment(sized(65_536 - base))).not.toThrow();
    expect(() => open().createExperiment(sized(65_536 - base + 1))).toThrow("The experiment definition is larger than 64 KB");
  });

  it("keeps primary_metric and weights in the log when given, and writes neither when not", () => {
    const file = fileIn("fields.jsonl");
    const ab = open(file);
    ab.createExperiment(exp({ id: "plain" }));
    ab.createExperiment(
      exp({
        id: "full",
        variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }, { id: "C", name: "c", config: {} }],
        weights: [1, 2, 1],
        primary_metric: "quality",
      })
    );
    const [plain, full] = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l).experiment);
    expect(Object.keys(plain)).toEqual(["id", "name", "hypothesis", "variants", "traffic_split", "metrics", "status"]);
    expect(full).toMatchObject({ weights: [1, 2, 1], primary_metric: "quality" });
  });
});

describe("experiments from the YAML file: what is kept and what is said about the rest", () => {
  const load = (document: unknown) => {
    const file = fileIn("experiments.yaml");
    fs.writeFileSync(file, typeof document === "string" ? document : require("yaml").stringify(document));
    errors.mockClear();
    const ab = open(undefined, undefined, file);
    return { ab, said: logged() };
  };
  const three = [{ id: "A", name: "a" }, { id: "B", name: "b" }, { id: "C", name: "c" }];
  const metrics = [{ id: "quality", name: "q", type: "continuous", aggregation: "mean" }];
  const base = { id: "x", name: "n", hypothesis: "h", traffic_split: 0.5, metrics };

  it("says nothing about a missing file, and loads nothing from a file with no experiments key", () => {
    expect(load("metadata: {}\n").said).toEqual(["Loaded 0 experiments"]);
    const missing = open(undefined, undefined, path.join(tmp, "missing-yaml.yaml"));
    expect(missing.listExperiments()).toEqual([]);
    expect(logged().some((line) => line.includes("Error loading experiments"))).toBe(false);
  });

  it.each([
    ["a duplicate id among three variants", { ...base, variants: [three[0], three[0], three[2]] }, "Duplicate variant id: A"],
    ["an empty id among three variants", { ...base, variants: [three[0], { id: "", name: "x" }, three[2]] }, "Every variant must have a non-empty string id"],
    ["a variant that is not an object among three", { ...base, variants: [three[0], null, three[2]] }, "Every variant must have a non-empty string id"],
    ["weights of the wrong count", { ...base, variants: three, weights: [1, 2] }, "weights must be 3 positive numbers, one per variant"],
    ["a weight of zero", { ...base, variants: three, weights: [1, 0, 1] }, "weights must be 3 positive numbers, one per variant"],
    ["a negative weight", { ...base, variants: three, weights: [1, -1, 1] }, "weights must be 3 positive numbers, one per variant"],
    ["a weight as text", { ...base, variants: three, weights: [1, "2", 1] }, "weights must be 3 positive numbers, one per variant"],
    ["a weight that is not finite", { ...base, variants: three, weights: [1, ".inf", 1] }, "weights must be 3 positive numbers, one per variant"],
    ["weights that are not a list", { ...base, variants: three, weights: 5 }, "weights must be 3 positive numbers, one per variant"],
    ["a direction nobody knows", { ...base, variants: three, metrics: [{ ...metrics[0], direction: "sideways" }] }, "Metric quality: direction must be one of higher_is_better, lower_is_better"],
    ["a guardrail that is text", { ...base, variants: three, metrics: [metrics[0], { id: "g", name: "g", type: "continuous", aggregation: "mean", guardrail: "yes" }] }, "Metric g: guardrail must be true or false"],
    ["a primary metric that is not a metric", { ...base, variants: three, primary_metric: "nope" }, "primary_metric nope is not one of the experiment's metrics"],
    ["a first metric that is a guardrail", { ...base, variants: three, metrics: [{ ...metrics[0], guardrail: true }] }, "The first metric quality decides the winner by default, so it cannot be a guardrail; set primary_metric"],
    ["a split outside 0 to 1", { ...base, variants: three, traffic_split: 1.5 }, "traffic_split must be a number between 0 and 1"],
    ["a split that is not a number", { ...base, variants: three, traffic_split: ".nan" }, "traffic_split must be a number between 0 and 1"],
    ["a split as text", { ...base, variants: three, traffic_split: "0.5" }, "traffic_split must be a number between 0 and 1"],
    ["no metrics list", { ...base, variants: three, metrics: "x" }, "Experiment must define a metrics array"],
    ["one variant", { ...base, variants: [three[0]] }, "Experiment must have between 2 and 10 variants"],
    ["eleven variants", { ...base, variants: Array.from({ length: 11 }, (_, i) => ({ id: `v${i}`, name: "v" })) }, "Experiment must have between 2 and 10 variants"],
  ])("skips an experiment with %s, and says why", (_name, experiment, message) => {
    const { ab, said } = load({ experiments: [experiment] });
    expect(said).toContain(`Skipping invalid experiment: ${message}`);
    expect(said).toContain("Loaded 0 experiments");
    expect(ab.listExperiments()).toEqual([]);
  });

  it("loads experiments with 2 to 10 variants, valid weights, directions and a guardrail after the first metric", () => {
    const good = [
      { ...base, id: "two", variants: three.slice(0, 2) },
      { ...base, id: "ten", variants: Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, name: "v" })) },
      { ...base, id: "weighted", variants: three, weights: [1, 2, 3.5] },
      { ...base, id: "directed", variants: three, metrics: [{ ...metrics[0], direction: "lower_is_better" }, { id: "g", name: "g", type: "continuous", aggregation: "mean", guardrail: true }] },
      { ...base, id: "named-primary", variants: three, primary_metric: "g", metrics: [{ ...metrics[0], guardrail: true }, { id: "g", name: "g", type: "continuous", aggregation: "mean" }] },
      { ...base, id: "split-0", traffic_split: 0, variants: three.slice(0, 2) },
      { ...base, id: "split-1", traffic_split: 1, variants: three.slice(0, 2) },
    ];
    const { ab, said } = load({ experiments: good });
    expect(said).toEqual(["Loaded 7 experiments"]);
    expect(ab.listExperiments().map((e) => e.id)).toEqual(good.map((g) => g.id));
  });

  it("keeps a two-variant experiment whose variants have no ids, as it always did", () => {
    const { ab, said } = load({ experiments: [{ ...base, variants: [{ name: "a" }, { name: "b" }] }] });
    expect(said).toEqual(["Loaded 1 experiments"]);
    expect(ab.listExperiments()).toHaveLength(1);
  });

  it("keeps an experiment with an empty entry among its metrics, and its results do not fail", () => {
    const { ab } = load({ experiments: [{ ...base, variants: three.slice(0, 2), metrics: [metrics[0], null] }] });
    ab.recordMetric("x", "A", { quality: 1 });
    expect(() => ab.getExperimentResults("x")).not.toThrow();
    expect(() => ab.recordMetric("x", "A", { nope: 1 })).toThrow("Unknown metric nope for experiment x: its metrics are quality, ");
  });
});

describe("variants and metrics that are not objects", () => {
  const two = [{ id: "A", name: "a" }, { id: "B", name: "b" }];
  it("loads from the YAML file an experiment with an empty metric entry that names a primary metric", () => {
    const file = fileIn("null-metric.yaml");
    fs.writeFileSync(file, require("yaml").stringify({ experiments: [{ id: "x", name: "n", hypothesis: "h", traffic_split: 0.5, variants: two, primary_metric: "quality", metrics: [null, { id: "quality", name: "q", type: "continuous", aggregation: "mean" }] }] }));
    errors.mockClear();
    const ab = open(undefined, undefined, file);
    expect(logged()).toEqual(["Loaded 1 experiments"]);
    expect(ab.listExperiments()).toHaveLength(1);
  });

  it("refuses to create one, saying the id is missing, instead of failing on the empty entry", () => {
    expect(() => open().createExperiment(exp({ variants: [null as any, { id: "B", name: "b", config: {} }] }))).toThrow("Variant id must be a non-empty string");
    expect(() => open().createExperiment(exp({ metrics: [null as any] }))).toThrow("Metric id must be a non-empty string");
  });
});

describe("the draw that picks a variant, at the exact split", () => {
  const assign = (ab: ABTestingFramework, draw: number, user?: string) => {
    jest.spyOn(Math, "random").mockReturnValue(draw);
    return ab.assignVariant("exp-1", user).variant_id;
  };

  it("sends a draw equal to the split to the second variant, and one below it to the first", () => {
    const ab = open();
    ab.createExperiment(exp({ traffic_split: 0.5 }));
    expect([assign(ab, 0.4999999), assign(ab, 0.5), assign(ab, 0.75)]).toEqual(["A", "B", "B"]);
    const none = open();
    none.createExperiment(exp({ traffic_split: 0 }));
    expect([assign(none, 0), assign(none, 0.99)]).toEqual(["B", "B"]);
    const all = open();
    all.createExperiment(exp({ traffic_split: 1 }));
    expect([assign(all, 0), assign(all, 0.9999999)]).toEqual(["A", "A"]);
  });

  it("sends a draw equal to a cumulative weight to the next variant", () => {
    const ab = open();
    ab.createExperiment(exp({ variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }, { id: "C", name: "c", config: {} }], weights: [1, 1, 2] }));
    expect([0, 0.2499, 0.25, 0.4999, 0.5, 0.9999].map((d) => assign(ab, d))).toEqual(["A", "A", "B", "B", "C", "C"]);
  });

  it("shares traffic equally among variants without weights", () => {
    const ab = open();
    ab.createExperiment(exp({ variants: [1, 2, 3, 4].map((n) => ({ id: `v${n}`, name: "v", config: {} })) }));
    expect([0, 0.2499, 0.25, 0.5, 0.75, 0.9999].map((d) => assign(ab, d))).toEqual(["v1", "v1", "v2", "v3", "v4", "v4"]);
  });

  it("draws at random for no user and for an empty user id, and by the user for any other", () => {
    const ab = open();
    ab.createExperiment(exp());
    expect([assign(ab, 0.1), assign(ab, 0.9)]).toEqual(["A", "B"]); // no user
    expect([assign(ab, 0.1, ""), assign(ab, 0.9, "")]).toEqual(["A", "B"]); // an empty id is no user
    const sticky = new Set([0.1, 0.9, 0.5].map((d) => assign(ab, d, "user-42")));
    expect(sticky.size).toBe(1); // the same user lands on the same variant whatever the dice say
  });
});

describe("recording, and what a measurement without values is", () => {
  it("counts a measurement without values as a sample, and none of its absent values", () => {
    const ab = open();
    ab.createExperiment(exp());
    ab.recordMetric("exp-1", "A", {});
    ab.recordMetric("exp-1", "A", undefined as any);
    expect(ab.listExperiments()[0].sample_count).toBe(2);
  });

  it("refuses a value that is not a finite number, with the metric's name", () => {
    const ab = open();
    ab.createExperiment(exp());
    for (const bad of [NaN, Infinity, "1", null, undefined, {}]) {
      expect(() => ab.recordMetric("exp-1", "A", { quality: bad as any })).toThrow("Metric quality must be a finite number");
    }
    expect(() => ab.recordMetric("exp-1", "A", { quality: 1e15 })).not.toThrow();
    expect(() => ab.recordMetric("exp-1", "A", { quality: -1e15 })).not.toThrow();
    expect(() => ab.recordMetric("exp-1", "A", { quality: 1e15 + 1 })).toThrow(/must be between -1e15 and 1e15/);
  });
});

/** Decisions between three variants and with guardrails, in the cases no test ran. 40 measurements per variant (60 for two). */
describe("results for several variants and for guardrails", () => {
  const NOISE = [-0.2, -0.1, 0, 0.1, 0.2];
  const variants = ["A", "B", "C"];
  type Plan = Record<string, { score?: number | null; cost?: number | null }>;
  /** `null` leaves the metric out for that variant; a number is its mean, with a little noise (or none when `flat`). */
  function run(plan: Plan, options: { two?: boolean; flat?: boolean; guard?: boolean; lowerPrimary?: boolean } = {}) {
    const ids = options.two ? ["A", "B"] : variants;
    const metricList: any[] = [{ id: "score", name: "score", type: "continuous", aggregation: "mean", ...(options.lowerPrimary ? { direction: "lower_is_better" } : {}) }];
    if (options.guard !== false) metricList.push({ id: "cost", name: "cost", type: "continuous", aggregation: "mean", direction: "lower_is_better", guardrail: true });
    const ab = open();
    ab.createExperiment(exp({ variants: ids.map((id) => ({ id, name: id, config: {} })), metrics: metricList }));
    for (const id of ids) {
      for (let i = 0; i < (options.two ? 60 : 40); i++) {
        const noise = options.flat ? 0 : NOISE[i % 5];
        const m: Record<string, number> = {};
        const p = plan[id] ?? {};
        if (p.score !== null && p.score !== undefined) m.score = p.score + noise;
        if (p.cost !== null && p.cost !== undefined && options.guard !== false) m.cost = p.cost + noise;
        ab.recordMetric("exp-1", id, m);
      }
    }
    return ab.getExperimentResults("exp-1")!;
  }
  const even = { A: { score: 10, cost: 1 }, B: { score: 20, cost: 1 }, C: { score: 10, cost: 1 } };

  it("picks the variant that beats every other, and keeps it when the guardrail is no worse for it", () => {
    const r = run(even);
    expect(r.winner).toBe("B");
    const g = r.statistical_analysis.guardrails.cost;
    expect(g.leader).toBe("B");
    expect(g.comparisons.map((c: any) => [c.against, c.leader_significantly_worse, typeof c.p_value])).toEqual([["A", false, "number"], ["C", false, "number"]]);
    expect(r.statistical_analysis.winner_withheld_by).toBeUndefined();
  });

  it("keeps the winner when it is cheaper on a lower-is-better guardrail", () => {
    const r = run({ ...even, B: { score: 20, cost: 0.5 } });
    expect(r.winner).toBe("B");
    expect(r.statistical_analysis.guardrails.cost.comparisons.every((c: any) => c.leader_significantly_worse === false && c.p_value < 0.05)).toBe(true);
  });

  it("withholds the winner when the guardrail is significantly worse for it, and says which guardrail", () => {
    const r = run({ ...even, B: { score: 20, cost: 5 } });
    expect(r.winner).toBeUndefined();
    expect(r.statistical_analysis.winner_withheld_by).toEqual(["cost"]);
    expect(r.statistical_analysis.guardrails.cost.comparisons.map((c: any) => c.leader_significantly_worse)).toEqual([true, true]);
    expect(open().recommendWinner("nope")).toBe("Insufficient data for recommendation");
  });

  it("withholds the winner when the guardrail has no data for one of the comparisons (a missing check is not a pass)", () => {
    const r = run({ A: { score: 10, cost: 1 }, B: { score: 20, cost: 1 }, C: { score: 10, cost: null } });
    expect(r.winner).toBeUndefined();
    expect(r.statistical_analysis.winner_withheld_by).toEqual(["cost"]);
    const byOther = Object.fromEntries(r.statistical_analysis.guardrails.cost.comparisons.map((c: any) => [c.against, c]));
    expect(byOther.C).toEqual({ against: "C", p_value: null, leader_significantly_worse: false });
    expect(typeof byOther.A.p_value).toBe("number");
  });

  it("has no leader and no comparisons when the primary metric is missing for a variant, and picks no winner", () => {
    const r = run({ A: { score: 10, cost: 1 }, B: { score: 20, cost: 1 }, C: { score: null, cost: 1 } });
    expect(r.winner).toBeUndefined();
    expect(r.confidence).toBe(0);
    expect(r.statistical_analysis.guardrails.cost).toEqual({ leader: null, comparisons: [] });
    expect(r.variant_results.C.metrics.score).toBeUndefined();
    expect(r.variant_results.C.metrics.cost).toBeDefined();
  });

  it("names the first variant as the leader when all of them tie, and calls no pair better", () => {
    const r = run({ A: { score: 10, cost: 1 }, B: { score: 10, cost: 1 }, C: { score: 10, cost: 1 } });
    expect(r.winner).toBeUndefined();
    expect(r.statistical_analysis.guardrails.cost.leader).toBe("A");
    expect(r.statistical_analysis.comparisons.every((c: any) => c.better === null && c.p_value === 1)).toBe(true);
  });

  it("gives the adjusted p-value of the primary metric only, an effect size when there is one, and says which is better", () => {
    const r = run(even);
    const rows = r.statistical_analysis.comparisons as any[];
    expect(rows).toHaveLength(6); // 3 pairs x 2 metrics
    for (const row of rows) {
      expect("adjusted_p_value" in row).toBe(row.metric === "score");
      expect(typeof row.effect_size).toBe("number");
    }
    const ab = rows.find((c) => c.metric === "score" && c.a === "A" && c.b === "B");
    expect(ab.better).toBe("B");
    const cost = rows.find((c) => c.metric === "cost" && c.a === "A" && c.b === "B");
    expect(cost.better).toBeNull(); // equal costs
    expect(r.statistical_analysis.primary_metric).toBe("score");
    expect(r.statistical_analysis.correction).toMatch(/Holm/);
  });

  it("gives no effect size when the values do not vary but differ, and a p-value of 0", () => {
    const r = run({ A: { score: 1, cost: 1 }, B: { score: 2, cost: 1 }, C: { score: 3, cost: 1 } }, { flat: true });
    const rows = r.statistical_analysis.comparisons as any[];
    const score = rows.filter((c) => c.metric === "score");
    expect(score.every((c) => c.p_value === 0 && !("effect_size" in c))).toBe(true);
    const cost = rows.filter((c) => c.metric === "cost");
    expect(cost.every((c) => c.p_value === 1 && c.effect_size === 0)).toBe(true);
    expect(r.winner).toBe("C");
    expect(r.confidence).toBe(1);
  });

  it("with two variants: keeps the winner when only the loser is worse on the guardrail, and withholds it when the winner is", () => {
    const loserWorse = run({ A: { score: 20, cost: 1 }, B: { score: 10, cost: 5 } }, { two: true });
    expect(loserWorse.winner).toBe("A");
    expect(loserWorse.statistical_analysis.guardrails.cost).toMatchObject({ significantly_worse_variant: "B" });
    expect(loserWorse.statistical_analysis.winner_withheld_by).toBeUndefined();

    const winnerWorse = run({ A: { score: 20, cost: 5 }, B: { score: 10, cost: 1 } }, { two: true });
    expect(winnerWorse.winner).toBeUndefined();
    expect(winnerWorse.statistical_analysis.guardrails.cost).toMatchObject({ significantly_worse_variant: "A" });
    expect(winnerWorse.statistical_analysis.winner_withheld_by).toEqual(["cost"]);

    const noDifference = run({ A: { score: 20, cost: 1 }, B: { score: 10, cost: 1 } }, { two: true });
    expect(noDifference.statistical_analysis.guardrails.cost.significantly_worse_variant).toBeNull();
    expect(noDifference.winner).toBe("A");
  });

  it("with two variants: withholds a winner when the guardrail has no data, and reports the effect size and p-value of each metric", () => {
    const missing = run({ A: { score: 20, cost: 1 }, B: { score: 10, cost: null } }, { two: true });
    expect(missing.winner).toBeUndefined();
    expect(missing.statistical_analysis.guardrails.cost).toEqual({ p_value: null, significantly_worse_variant: null });
    expect(missing.statistical_analysis.winner_withheld_by).toEqual(["cost"]);
    expect(Object.keys(missing.statistical_analysis.p_values)).toEqual(["score"]); // no p-value for a metric with no pair
    const plain = run({ A: { score: 20 }, B: { score: 10 } }, { two: true, guard: false });
    expect(plain.statistical_analysis.guardrails).toBeUndefined();
    expect(typeof plain.statistical_analysis.effect_sizes.score).toBe("number");
    expect(plain.statistical_analysis.significance_level).toBe(0.05);
  });

  it("does not call a guardrail worse for a difference that is there but not significant (two variants)", () => {
    const slightlyWorse = run({ A: { score: 20, cost: 1.01 }, B: { score: 10, cost: 1 } }, { two: true });
    const g = slightlyWorse.statistical_analysis.guardrails.cost;
    expect(g.p_value).toBeGreaterThan(0.05);
    expect(g.significantly_worse_variant).toBeNull();
    expect(slightlyWorse.winner).toBe("A"); // the winner is slightly dearer, within the noise: it stays
    expect(slightlyWorse.statistical_analysis.winner_withheld_by).toBeUndefined();
    const slightlyBetter = run({ A: { score: 20, cost: 1 }, B: { score: 10, cost: 1.01 } }, { two: true });
    expect(slightlyBetter.statistical_analysis.guardrails.cost.significantly_worse_variant).toBeNull();
  });

  it("does not call the leader worse on a guardrail for a difference that is not significant (three variants)", () => {
    const r = run({ A: { score: 10, cost: 1 }, B: { score: 20, cost: 1.01 }, C: { score: 10, cost: 1 } });
    const comparisons = r.statistical_analysis.guardrails.cost.comparisons;
    expect(comparisons.map((c: any) => c.against)).toEqual(["A", "C"]);
    for (const c of comparisons) {
      expect(c.p_value).toBeGreaterThan(0.05);
      expect(c.leader_significantly_worse).toBe(false);
    }
    expect(r.winner).toBe("B");
  });

  it("lists no guardrail as withholding a winner there is none to withhold", () => {
    const three = run({ A: { score: 10, cost: 1 }, B: { score: 10, cost: 1 }, C: { score: 10, cost: null } });
    expect(three.winner).toBeUndefined();
    expect(three.statistical_analysis.guardrails.cost.comparisons.some((c: any) => c.p_value === null)).toBe(true);
    expect(three.statistical_analysis.winner_withheld_by).toBeUndefined();
    const two = run({ A: { score: 10, cost: 1 }, B: { score: 10, cost: null } }, { two: true });
    expect(two.winner).toBeUndefined();
    expect(two.statistical_analysis.winner_withheld_by).toBeUndefined();
  });

  it("names the first variant as the leader of a tie when lower is better, too", () => {
    const r = run({ A: { score: 10, cost: 1 }, B: { score: 10, cost: 1 }, C: { score: 10, cost: 1 } }, { lowerPrimary: true });
    expect(r.statistical_analysis.guardrails.cost.leader).toBe("A");
    expect(r.winner).toBeUndefined();
    const lower = run({ A: { score: 20, cost: 1 }, B: { score: 10, cost: 1 }, C: { score: 20, cost: 1 } }, { lowerPrimary: true });
    expect(lower.winner).toBe("B"); // the lowest wins when lower is better
  });

  it("compares a metric that two variants have only two values of, and none that has fewer than two", () => {
    const build = (extraA: number, extraB: number) => {
      const ab = open();
      ab.createExperiment(exp({ metrics: [{ id: "quality", name: "q", type: "continuous", aggregation: "mean" }, { id: "extra", name: "e", type: "continuous", aggregation: "mean" }] }));
      for (let i = 0; i < 60; i++) {
        ab.recordMetric("exp-1", "A", i < extraA ? { quality: 10 + NOISE[i % 5], extra: 1 + NOISE[i % 5] } : { quality: 10 + NOISE[i % 5] });
        ab.recordMetric("exp-1", "B", i < extraB ? { quality: 20 + NOISE[i % 5], extra: 2 + NOISE[i % 5] } : { quality: 20 + NOISE[i % 5] });
      }
      return ab.getExperimentResults("exp-1")!.statistical_analysis.p_values;
    };
    expect(typeof build(2, 2).extra).toBe("number");
    expect(build(1, 2).extra).toBeUndefined();
    expect(build(2, 1).extra).toBeUndefined();
    expect(typeof build(2, 2).quality).toBe("number");
  });

  it("reports the 95% interval of a variant with the t value of its size: the table up to 29 degrees of freedom, the formula from 30", () => {
    const ab = open();
    ab.createExperiment(exp());
    for (let i = 0; i < 70; i++) {
      if (i < 30) ab.recordMetric("exp-1", "A", { quality: 10 + NOISE[i % 5] });
      ab.recordMetric("exp-1", "B", { quality: 20 + NOISE[i % 5] });
    }
    const tOf = (m: any) => (((m.ci_95[1] - m.ci_95[0]) / 2) * Math.sqrt(m.sample_size)) / m.std_dev;
    const { A, B } = ab.getExperimentResults("exp-1")!.variant_results;
    expect(A.metrics.quality.sample_size).toBe(30);
    expect(tOf(A.metrics.quality)).toBeCloseTo(2.0452, 2); // Student t, 29 degrees of freedom (table value 2.0452)
    expect(tOf(B.metrics.quality)).toBeCloseTo(1.9949, 2); // 69 degrees of freedom (1.9949)
    expect(A.metrics.quality.ci_95[0]).toBeLessThan(A.metrics.quality.mean);
    expect(B.metrics.quality.ci_95[1]).toBeGreaterThan(B.metrics.quality.mean);
  });
});

describe("the tools: what they answer, and the environment that sets the module up", () => {
  const ENV = ["EXPERIMENTS_FILE", "AB_DATA_FILE", "AB_FSYNC", "AB_DATA_WARN_BYTES"];
  /** A fresh copy of the module built with `env`, since it builds its one framework when it is loaded. */
  function freshTools(env: Record<string, string>) {
    const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, env);
    let mod!: typeof import("../features/08-ab-testing/src/mcp-server");
    try {
      jest.isolateModules(() => {
        mod = require("../features/08-ab-testing/src/mcp-server");
      });
    } finally {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    return async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await mod.processToolCall(name, input));
  }
  const definition = (id = "t-1") => ({
    id, name: "n", hypothesis: "h", variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
    metrics: [{ id: "quality", name: "q", type: "continuous", aggregation: "mean" }],
  });

  it("answers create_experiment with the id, defaults the split to one half, and records through record_metric", async () => {
    const tool = freshTools({ EXPERIMENTS_FILE: NO_YAML });
    expect(await tool("create_experiment", definition())).toEqual({ status: "success", experiment_id: "t-1" });
    expect(await tool("create_experiment", definition())).toEqual({ error: "Experiment already exists: t-1" });
    for (let i = 0; i < 120; i++) expect(await tool("record_metric", { experiment_id: "t-1", variant_id: i % 2 ? "A" : "B", metrics: { quality: (i % 2 ? 10 : 20) + NOISE_AT(i) } })).toEqual({ status: "recorded" });
    const results = await tool("get_experiment_results", { experiment_id: "t-1" });
    expect(results.status).toBe("complete");
    expect(results.variant_results.A.metrics.quality.sample_size).toBe(60); // the tool really recorded them
    expect(await tool("recommend_winner", { experiment_id: "t-1" })).toEqual({ recommendation: "B" });
  });

  it("assigns a number as a user id the same as its text, picks at random for null or none, and refuses other types", async () => {
    const tool = freshTools({ EXPERIMENTS_FILE: NO_YAML });
    await tool("create_experiment", definition());
    const byNumber = await tool("assign_variant", { experiment_id: "t-1", user_id: 12345 });
    expect(byNumber).toEqual(await tool("assign_variant", { experiment_id: "t-1", user_id: "12345" }));
    const draw = jest.spyOn(Math, "random");
    for (const [value, expected] of [[0.1, "A"], [0.9, "B"]] as const) {
      draw.mockReturnValue(value); // with no user the dice decide, so both answers must be reachable
      expect((await tool("assign_variant", { experiment_id: "t-1" })).variant_id).toBe(expected);
      expect((await tool("assign_variant", { experiment_id: "t-1", user_id: null })).variant_id).toBe(expected);
      expect((await tool("assign_variant", { experiment_id: "t-1", user_id: "" })).variant_id).toBe(expected);
    }
    for (const bad of [{}, [], true]) expect(await tool("assign_variant", { experiment_id: "t-1", user_id: bad })).toEqual({ error: "user_id must be a string or a number" });
  });

  it("reads the experiments file, the data file, AB_FSYNC and AB_DATA_WARN_BYTES from the environment", async () => {
    const yamlFile = fileIn("env.yaml");
    fs.writeFileSync(yamlFile, require("yaml").stringify({ experiments: [exp({ id: "from-env" })] }));
    const dataFile = fileIn("env-data.jsonl");
    fs.writeFileSync(dataFile, "x".repeat(50) + "\n");
    const flush = jest.spyOn(realFs, "fsyncSync");
    const tool = freshTools({ EXPERIMENTS_FILE: yamlFile, AB_DATA_FILE: dataFile, AB_FSYNC: "yes", AB_DATA_WARN_BYTES: "10" });
    expect((await tool("get_experiment_results", { experiment_id: "from-env" })).status).toBe("incomplete"); // the experiments file was read
    expect(logged().some((line) => line.startsWith(`A/B data file ${dataFile} is 0 MB. It is never compacted`))).toBe(true); // the limit of 10 bytes
    flush.mockClear();
    await tool("create_experiment", definition("written"));
    expect(flush).toHaveBeenCalledTimes(1); // AB_FSYNC took effect
    expect(fs.readFileSync(dataFile, "utf-8")).toContain('"id":"written"'); // and the data file is the one named
    expect(fs.existsSync(lockOf(dataFile))).toBe(true);
  });

  it("uses the defaults for an unusable AB_DATA_WARN_BYTES, no data file without AB_DATA_FILE, and leaves AB_FSYNC off", async () => {
    const flush = jest.spyOn(realFs, "fsyncSync");
    const tool = freshTools({ EXPERIMENTS_FILE: NO_YAML, AB_DATA_WARN_BYTES: "lots" });
    await tool("create_experiment", definition("memory-only"));
    expect(flush).not.toHaveBeenCalled();
    expect((await tool("get_experiment_results", { experiment_id: "memory-only" })).status).toBe("incomplete");
  });
});

const NOISE_AT = (i: number) => [-0.2, -0.1, 0, 0.1, 0.2][i % 5];
