/**
 * AB_LAZY_OPEN: the A/B data is opened on the first A/B tool call instead of at start-up.
 *
 * Why it exists: a desktop client (Claude Desktop) starts several copies of one server (the chat, probes for other session types)
 * with the same data folder and kills them at will. Opened at start-up, a data file held by another copy, a lock left by a copy that
 * was killed, or a folder that cannot be used ends or freezes the whole process before it has answered the handshake: the client
 * logged "Request timed out" after 60 s. With AB_LAZY_OPEN the handshake and the other tools never depend on the data file, a
 * failure is the error of one A/B call, and the next call tries again. The default (open at start-up, fail at once) is what the
 * deployments rely on and is kept; these tests hold both.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-lazy-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

type AbModule = typeof import("../features/08-ab-testing/src/mcp-server");

/** Loads a fresh copy of the A/B module with exactly these variables, the way a new server process would. */
function load(env: Record<string, string>): AbModule {
  const names = ["AB_DATA_FILE", "AB_LAZY_OPEN", "AB_FSYNC", "EXPERIMENTS_FILE"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, { EXPERIMENTS_FILE: path.join(tmp, "no-experiments.yaml"), ...env });
  try {
    let mod!: AbModule;
    jest.isolateModules(() => {
      mod = require("../features/08-ab-testing/src/mcp-server");
    });
    return mod;
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

const experiment = (id = "e1") => ({
  id,
  name: "n",
  hypothesis: "h",
  variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
  metrics: [{ id: "quality", name: "q", type: "continuous", aggregation: "mean" }],
});
const call = async (mod: AbModule, tool: string, input: Record<string, unknown>) => JSON.parse(await mod.processToolCall(tool, input));
const freshFolder = (name: string) => path.join(tmp, name);
/** A lock that looks like it belongs to a live process on this machine: the parent of this process. */
const liveHolderLock = (file: string) => fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.ppid, host: os.hostname(), started: new Date().toISOString(), token: "held" }));

describe("lazyOpenFromEnv", () => {
  it("accepts 1, true and yes in any case, and nothing else (as AB_FSYNC does)", () => {
    const { lazyOpenFromEnv } = load({});
    for (const yes of ["1", "true", "TRUE", "True", "yes", "YES"]) expect({ yes, on: lazyOpenFromEnv(yes) }).toEqual({ yes, on: true });
    for (const no of [undefined, "", "0", "false", "no", "on", "tru", " true", "true "]) expect({ no, on: lazyOpenFromEnv(no) }).toEqual({ no, on: false });
  });
});

describe("with AB_LAZY_OPEN", () => {
  it("touches nothing when the module loads: no folder, no data file, no lock", () => {
    const file = path.join(freshFolder("untouched"), "deeper", "ab-data.jsonl");
    load({ AB_DATA_FILE: file, AB_LAZY_OPEN: "true" });
    expect(fs.existsSync(freshFolder("untouched"))).toBe(false);
  });

  it("opens the data on the first A/B call: the folder, the file and the lock appear then", async () => {
    const file = path.join(freshFolder("first-call"), "ab-data.jsonl");
    const mod = load({ AB_DATA_FILE: file, AB_LAZY_OPEN: "true" });
    expect(await call(mod, "create_experiment", experiment())).toEqual({ status: "success", experiment_id: "e1" });
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    expect(await call(mod, "assign_variant", { experiment_id: "e1", user_id: "alice" })).toMatchObject({ experiment_id: "e1" }); // the same open store serves the next call
  });

  it("turns a data file held by another live process into that call's error, never a crash, and recovers when the holder is gone", async () => {
    const file = path.join(freshFolder("held"), "ab-data.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    liveHolderLock(file);
    const mod = load({ AB_DATA_FILE: file, AB_LAZY_OPEN: "true" }); // loading is fine
    const refused = await call(mod, "create_experiment", experiment());
    expect(refused.error).toMatch(/Cannot use A\/B data file .*in use by pid \d+/);
    expect(await call(mod, "create_experiment", experiment())).toHaveProperty("error"); // and again: still an error, not a crash
    fs.rmSync(`${file}.lock`);
    expect(await call(mod, "create_experiment", experiment())).toEqual({ status: "success", experiment_id: "e1" }); // the next call tries again
    expect(fs.readFileSync(file, "utf8")).toContain('"e1"');
  });

  it("does not wait for a lock it cannot check (another machine, refreshed a moment ago): it says so at once and says when to try again", async () => {
    const file = path.join(freshFolder("unverifiable"), "ab-data.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 4242, host: "some-other-machine", started: new Date().toISOString(), token: "x" }));
    const mod = load({ AB_DATA_FILE: file, AB_LAZY_OPEN: "true" });
    const started = Date.now();
    const refused = await call(mod, "get_experiment_results", { experiment_id: "e1" });
    expect(Date.now() - started).toBeLessThan(2000); // the default would sleep for up to 17 s, freezing the whole process
    expect(refused.error).toMatch(/could not be checked from here.*try again/s);
  });

  it("turns a data folder that cannot be used into that call's error, and the other modules' tools are unaffected", async () => {
    const blocker = path.join(tmp, "a-file-not-a-folder");
    fs.writeFileSync(blocker, "x");
    const mod = load({ AB_DATA_FILE: path.join(blocker, "sub", "ab-data.jsonl"), AB_LAZY_OPEN: "true" });
    expect((await call(mod, "create_experiment", experiment())).error).toMatch(/Cannot use A\/B data file/);
    expect((await call(mod, "assign_variant", { experiment_id: "e1", user_id: "u" })).error).toMatch(/Cannot use A\/B data file/);
    expect(await call(mod, "no_such_tool", {})).toEqual({ error: "Unknown tool" });
  });

  it("still validates a call's arguments before it needs the data (a bad call is a bad call, held or not)", async () => {
    const file = path.join(freshFolder("validate"), "ab-data.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    liveHolderLock(file);
    const mod = load({ AB_DATA_FILE: file, AB_LAZY_OPEN: "true" });
    expect(await call(mod, "get_experiment_results", { experiment_id: 7 })).toEqual({ error: "experiment_id must be a string" });
    expect(await call(mod, "record_metric", { experiment_id: "e", variant_id: "A", metrics: [1] })).toHaveProperty("error", expect.stringMatching(/metrics must be an object/));
  });
});

describe("without AB_LAZY_OPEN (the default, which the deployments rely on)", () => {
  it("opens the data when the module loads, creating the folder and the file", () => {
    const file = path.join(freshFolder("eager"), "ab-data.jsonl");
    load({ AB_DATA_FILE: file });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
  });

  it("refuses to load at once when a live process holds the data file: the server does not start", () => {
    const file = path.join(freshFolder("eager-held"), "ab-data.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    liveHolderLock(file);
    expect(() => load({ AB_DATA_FILE: file })).toThrow(/Cannot use A\/B data file .*in use by pid/);
  });

  it("treats every value other than 1, true and yes as off", () => {
    const file = path.join(freshFolder("eager-off"), "ab-data.jsonl");
    load({ AB_DATA_FILE: file, AB_LAZY_OPEN: "false" });
    expect(fs.existsSync(file)).toBe(true);
  });
});
