import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

interface Variant {
  id: string;
  name: string;
  config: Record<string, any>;
}

interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  status: "setup" | "running" | "complete";
  variants: Variant[];
  traffic_split: number;
  metrics: Array<{
    id: string;
    name: string;
    type: string;
    aggregation: string;
  }>;
  results?: ExperimentResults;
}

interface ExperimentResults {
  status: "incomplete" | "complete";
  variant_results: Record<string, any>;
  statistical_analysis: Record<string, any>;
  winner?: string;
  confidence: number;
}

// FNV-1a + murmur3 finalizer, mapped to [0, 1) so a given user always lands in the same bucket.
function bucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // murmur3 finalizer: FNV alone mixes the high bits poorly for sequential ids.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const MIN_TOTAL_SAMPLES = 100;
const MIN_SAMPLES_PER_VARIANT = 30;
const SIGNIFICANCE_LEVEL = 0.05;

// Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7).
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

// Two-sided p-value for a t statistic. Converts t to an approximate z score
// (accurate for df >= ~25, which the per-variant sample minimum guarantees).
function twoSidedPValue(t: number, df: number): number {
  if (!isFinite(t)) return 0;
  const z = (Math.abs(t) * (1 - 1 / (4 * df))) / Math.sqrt(1 + (t * t) / (2 * df));
  return Math.min(1, erfc(z / Math.SQRT2));
}

// Approximate two-sided 95% t critical value.
function tCritical95(df: number): number {
  const z = 1.96;
  return z + (z * z * z + z) / (4 * df);
}

function sampleStats(values: number[]) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance, std: Math.sqrt(variance) };
}

interface Measurement {
  experiment_id: string;
  variant_id: string;
  metrics: Record<string, number>;
  timestamp: string;
}

type LogEntry =
  | { type: "experiment"; experiment: Experiment }
  | ({ type: "measurement" } & Measurement);

// ---- single-writer lock for the data file -------------------------------------------------------
//
// The data file has exactly one writer. A lock file next to it (`<data file>.lock`) enforces that:
// it is created exclusively, refreshed every LOCK_HEARTBEAT_MS while the process lives, and removed
// on clean exit. A lock whose holder is provably alive makes startup fail at once; a lock left by a
// dead holder is taken over. This is a guard against accidental double starts (two Claude Desktop
// windows, a second replica on a shared volume), not a distributed lock: if two starters race for
// the same stale lock at the same instant, both can win. Every write re-checks that the lock is
// still ours and fails closed if it is not.

const LOCK_HEARTBEAT_MS = 3_000;
const LOCK_STALE_MS = 15_000;
const DEFAULT_WARN_BYTES = 100 * 1024 * 1024;

interface HeldLock {
  path: string;
  token: string;
  timer: NodeJS.Timeout;
}

const heldLocks = new Map<string, HeldLock>();
let exitHookInstalled = false;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === "EPERM"; // exists, but owned by someone else
  }
}

function readLockFile(lockPath: string): { pid: number; host: string; started?: string; token?: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    return typeof parsed?.pid === "number" && typeof parsed?.host === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function holdsLock(lock: HeldLock): boolean {
  return readLockFile(lock.path)?.token === lock.token;
}

function releaseLock(lock: HeldLock): void {
  clearInterval(lock.timer);
  heldLocks.delete(lock.path);
  if (holdsLock(lock)) fs.rmSync(lock.path, { force: true });
}

function releaseAllLocks(): void {
  for (const lock of [...heldLocks.values()]) {
    try {
      releaseLock(lock);
    } catch {
      /* exiting anyway */
    }
  }
}

type LockVerdict = "held" | "stale" | "unknown";

function judgeLock(lockPath: string): LockVerdict {
  let age: number;
  try {
    age = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return "stale"; // vanished between our attempt and now: just try again
  }
  if (age > LOCK_STALE_MS) return "stale"; // holder stopped refreshing it
  const info = readLockFile(lockPath);
  if (info && info.host === os.hostname()) {
    // Same machine: process ids are trustworthy. A lock naming our own pid that this module does not
    // hold is the leftover of a previous incarnation (a restarted container is pid 1 again).
    if (info.pid === process.pid) return "stale";
    if (!pidAlive(info.pid)) return age > 2 * LOCK_HEARTBEAT_MS ? "stale" : "unknown";
    return "held";
  }
  return "unknown"; // another machine or unreadable: only the heartbeat can tell if it is alive
}

function describeHolder(lockPath: string): string {
  const info = readLockFile(lockPath);
  return info ? `pid ${info.pid} on ${info.host}${info.started ? ` (started ${info.started})` : ""}` : "an unknown process";
}

function acquireLock(lockPath: string, waitMs: number): HeldLock {
  if (heldLocks.has(lockPath)) {
    throw new Error("it is already open in this process (close the other instance first)");
  }
  const token = crypto.randomBytes(12).toString("hex");
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString(), token });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
    const verdict = judgeLock(lockPath);
    if (verdict === "stale") {
      // Move it aside atomically so that of several starters only one removes it.
      const aside = `${lockPath}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(lockPath, aside);
        fs.rmSync(aside, { force: true });
      } catch {
        /* someone else took it over first; try again */
      }
      continue;
    }
    if (verdict === "held") {
      throw new Error(
        `it is in use by ${describeHolder(lockPath)}. Only one server process may write it: ` +
          "stop the other one or point AB_DATA_FILE at a different path"
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `its lock (${lockPath}) is held by ${describeHolder(lockPath)} and was refreshed in the last ` +
          `${LOCK_STALE_MS / 1000}s, but that process could not be checked from here. If it is really gone, delete the lock file`
      );
    }
    sleepSync(500); // a crashed holder's lock ages out; wait for it rather than fail a restart
  }
  const timer = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {
      /* lost; the next write notices and fails closed */
    }
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  const lock: HeldLock = { path: lockPath, token, timer };
  heldLocks.set(lockPath, lock);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", releaseAllLocks);
  }
  return lock;
}

/** Flush a file's data to disk; with `dir`, flush the directory entry instead (best effort, not on every OS). */
function fsyncPath(target: string, dir = false): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, dir ? "r" : "a");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!dir) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface ABDataOptions {
  /** Flush every append to disk before reporting success. Slower; a crash or power loss cannot then drop an acknowledged write. */
  fsync?: boolean;
  /** Log a warning once the data file passes this many bytes (it is never compacted). Default 100 MiB. */
  warnBytes?: number;
  /** How long startup waits for a lock that might belong to a crashed holder on another machine. */
  lockWaitMs?: number;
}

class ABTestingFramework {
  private experiments: Map<string, Experiment> = new Map();
  private measurements: Measurement[] = [];
  private experimentsFile: string;
  private dataFile?: string;
  private lock?: HeldLock;
  private closed = false;
  private fsync: boolean;
  private warnBytes: number;
  private lockWaitMs: number;
  private size = 0;
  private warned = false;

  /**
   * @param experimentsFile optional YAML with experiment definitions (read-only config)
   * @param dataFile optional append-only JSONL log. When set, experiments created at runtime and
   *   every measurement are written to it before being applied, and replayed on startup.
   *   Exactly one process may own a data file (enforced with `<dataFile>.lock`); call close() to hand it over.
   */
  constructor(experimentsFile: string = "./experiments.yaml", dataFile?: string, options: ABDataOptions = {}) {
    this.experimentsFile = experimentsFile;
    this.fsync = options.fsync === true;
    this.warnBytes = options.warnBytes && options.warnBytes > 0 ? options.warnBytes : DEFAULT_WARN_BYTES;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_STALE_MS + 2_000;
    this.loadExperiments();
    if (dataFile) {
      this.dataFile = dataFile;
      this.openDataFile();
    }
  }

  /** Release the data file lock so another process (or instance) can open it. Further writes fail. */
  public close(): void {
    this.closed = true;
    if (this.lock) {
      releaseLock(this.lock);
      this.lock = undefined;
    }
  }

  private noteGrowth(addedBytes: number): void {
    this.size += addedBytes;
    if (!this.warned && this.size > this.warnBytes) {
      this.warned = true;
      console.error(
        `A/B data file ${this.dataFile} is ${Math.round(this.size / 1048576)} MB. It is never compacted: ` +
          "plan a rollup or rotation before it grows much further (see DEPLOYMENT.md)"
      );
    }
  }

  private openDataFile(): void {
    const file = this.dataFile!;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.lock = acquireLock(`${file}.lock`, this.lockWaitMs);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "", { mode: 0o600 });
        if (this.fsync) {
          fsyncPath(file);
          fsyncPath(path.dirname(file), true);
        }
        return;
      }
      const content = fs.readFileSync(file, "utf-8");
      this.size = Buffer.byteLength(content);
      this.noteGrowth(0);
      let experiments = 0;
      let measurements = 0;
      let skipped = 0;
      let dropped = 0;

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let entry: LogEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          skipped++; // e.g. a line torn by a crash mid-write
          continue;
        }
        if (entry?.type === "experiment") {
          try {
            this.validateExperiment(entry.experiment);
          } catch {
            skipped++;
            continue;
          }
          // Definitions from the YAML file are authoritative.
          if (!this.experiments.has(entry.experiment.id)) {
            this.experiments.set(entry.experiment.id, entry.experiment);
            experiments++;
          }
        } else if (entry?.type === "measurement") {
          const exp = this.experiments.get(entry.experiment_id);
          const valid =
            exp &&
            exp.variants.some((v) => v.id === entry.variant_id) &&
            Object.values(entry.metrics ?? {}).every((v) => typeof v === "number" && Number.isFinite(v));
          if (!valid) {
            dropped++;
            continue;
          }
          this.measurements.push({
            experiment_id: entry.experiment_id,
            variant_id: entry.variant_id,
            metrics: entry.metrics,
            timestamp: entry.timestamp,
          });
          measurements++;
        } else {
          skipped++;
        }
      }

      // A crash can leave the last line without a newline; terminate it so the next append
      // starts on its own line instead of being glued to the torn one.
      if (content.length > 0 && !content.endsWith("\n")) {
        fs.appendFileSync(file, "\n");
        this.size += 1;
      }
      console.error(
        `Restored ${experiments} experiments and ${measurements} measurements from ${file}` +
          (skipped || dropped ? ` (skipped ${skipped} unreadable lines, dropped ${dropped} orphaned measurements)` : "")
      );
    } catch (error: any) {
      this.close(); // never keep the lock of a data file we could not open
      throw new Error(`Cannot use A/B data file ${file}: ${error.message}`);
    }
  }

  private persist(entry: LogEntry): void {
    if (!this.dataFile) return;
    if (this.closed) throw new Error("A/B data file is closed");
    if (this.lock && !holdsLock(this.lock)) {
      // Another process took the lock over (this one stalled for longer than the stale limit, or the
      // lock file was removed). Writing now could interleave two writers' histories: refuse.
      throw new Error(
        "A/B data file lock was lost to another process: refusing to write. Stop the other process and restart this server"
      );
    }
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.dataFile, line, { mode: 0o600 });
    if (this.fsync) fsyncPath(this.dataFile);
    this.noteGrowth(Buffer.byteLength(line));
  }

  private loadExperiments(): void {
    try {
      if (fs.existsSync(this.experimentsFile)) {
        const content = fs.readFileSync(this.experimentsFile, "utf-8");
        const config = yaml.parse(content);

        for (const exp of config.experiments || []) {
          try {
            this.validateExperiment(exp);
            this.experiments.set(exp.id, exp);
          } catch (error: any) {
            console.error(`Skipping invalid experiment: ${error.message}`);
          }
        }
        console.error(`Loaded ${this.experiments.size} experiments`);
      }
    } catch (error) {
      console.error("Error loading experiments:", error);
    }
  }

  private validateExperiment(experiment: Experiment): void {
    if (!experiment || typeof experiment.id !== "string") {
      throw new Error("Experiment must have a string id");
    }
    if (!experiment.variants || experiment.variants.length !== 2) {
      throw new Error("Experiment must have exactly 2 variants");
    }
    if (
      typeof experiment.traffic_split !== "number" ||
      experiment.traffic_split < 0 ||
      experiment.traffic_split > 1
    ) {
      throw new Error("traffic_split must be a number between 0 and 1");
    }
    if (!Array.isArray(experiment.metrics)) {
      throw new Error("Experiment must define a metrics array");
    }
  }

  public createExperiment(experiment: Experiment): void {
    this.validateExperiment(experiment);
    if (this.experiments.has(experiment.id)) {
      throw new Error(`Experiment already exists: ${experiment.id}`);
    }
    const created: Experiment = { ...experiment, status: "setup" };
    // Write first: if the disk write fails the experiment is not created, so memory never gets ahead of disk.
    this.persist({ type: "experiment", experiment: created });
    this.experiments.set(created.id, created);
  }

  public assignVariant(
    experimentId: string,
    userId?: string
  ): {
    variant_id: string;
    experiment_id: string;
  } {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    // Sticky per user when a user id is given, random otherwise.
    const draw =
      userId !== undefined && userId !== ""
        ? bucket(`${experimentId}:${userId}`)
        : Math.random();
    const variantIndex = draw < experiment.traffic_split ? 0 : 1;
    const selectedVariant = experiment.variants[variantIndex];

    return {
      variant_id: selectedVariant.id,
      experiment_id: experimentId,
    };
  }

  public recordMetric(
    experimentId: string,
    variantId: string,
    metrics: Record<string, number>
  ): void {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }
    if (!experiment.variants.some((v) => v.id === variantId)) {
      throw new Error(`Variant ${variantId} is not part of experiment ${experimentId}`);
    }
    for (const [key, value] of Object.entries(metrics ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Metric ${key} must be a finite number`);
      }
    }
    const measurement: Measurement = {
      experiment_id: experimentId,
      variant_id: variantId,
      metrics,
      timestamp: new Date().toISOString(),
    };
    this.persist({ type: "measurement", ...measurement });
    this.measurements.push(measurement);
  }

  public getExperimentResults(experimentId: string): ExperimentResults | null {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    // Filter measurements for this experiment
    const expMeasurements = this.measurements.filter(
      (m) => m.experiment_id === experimentId
    );

    if (expMeasurements.length < MIN_TOTAL_SAMPLES) {
      return {
        status: "incomplete",
        variant_results: {},
        statistical_analysis: {
          message: `Need ${MIN_TOTAL_SAMPLES - expMeasurements.length} more samples`,
          current_samples: expMeasurements.length,
        },
        confidence: 0,
      };
    }

    const perVariant = experiment.variants.map(
      (v) => expMeasurements.filter((m) => m.variant_id === v.id).length
    );
    if (perVariant.some((n) => n < MIN_SAMPLES_PER_VARIANT)) {
      return {
        status: "incomplete",
        variant_results: {},
        statistical_analysis: {
          message: `Need at least ${MIN_SAMPLES_PER_VARIANT} samples per variant`,
          current_samples: expMeasurements.length,
          samples_per_variant: Object.fromEntries(
            experiment.variants.map((v, i) => [v.id, perVariant[i]])
          ),
        },
        confidence: 0,
      };
    }

    const [vA, vB] = experiment.variants;
    const variantStats: Record<string, any> = {};
    const pValues: Record<string, number> = {};
    const effectSizes: Record<string, number> = {};
    const meansByMetric: Record<string, [number, number]> = {};

    for (const variant of experiment.variants) {
      variantStats[variant.id] = { name: variant.name, metrics: {} };
    }

    for (const metric of experiment.metrics) {
      const groups = [vA, vB].map((v) =>
        sampleStats(
          expMeasurements
            .filter((m) => m.variant_id === v.id)
            .map((m) => m.metrics[metric.id])
            .filter((x) => x !== undefined)
        )
      );

      [vA, vB].forEach((v, i) => {
        const g = groups[i];
        if (g.n === 0) return;
        const half = g.n > 1 ? (tCritical95(g.n - 1) * g.std) / Math.sqrt(g.n) : 0;
        variantStats[v.id].metrics[metric.id] = {
          mean: parseFloat(g.mean.toFixed(4)),
          std_dev: parseFloat(g.std.toFixed(4)),
          ci_95: [
            parseFloat((g.mean - half).toFixed(4)),
            parseFloat((g.mean + half).toFixed(4)),
          ],
          sample_size: g.n,
        };
      });

      const [g1, g2] = groups;
      if (g1.n < 2 || g2.n < 2) continue;

      meansByMetric[metric.id] = [g1.mean, g2.mean];
      const diff = g1.mean - g2.mean;
      const se2 = g1.variance / g1.n + g2.variance / g2.n;

      // Welch's t-test
      if (se2 === 0) {
        pValues[metric.id] = diff === 0 ? 1 : 0;
      } else {
        const df =
          (se2 * se2) /
          ((g1.variance / g1.n) ** 2 / (g1.n - 1) +
            (g2.variance / g2.n) ** 2 / (g2.n - 1));
        pValues[metric.id] = parseFloat(twoSidedPValue(diff / Math.sqrt(se2), df).toPrecision(4));
      }

      // Cohen's d with pooled standard deviation
      const pooled = Math.sqrt(
        ((g1.n - 1) * g1.variance + (g2.n - 1) * g2.variance) / (g1.n + g2.n - 2)
      );
      if (pooled > 0) effectSizes[metric.id] = parseFloat((diff / pooled).toFixed(2));
      else if (diff === 0) effectSizes[metric.id] = 0;
    }

    // Winner: first metric only, higher mean is better, and only if significant.
    let winner: string | undefined;
    let confidence = 0;
    const primary = experiment.metrics[0];
    if (primary && pValues[primary.id] !== undefined) {
      const p = pValues[primary.id];
      confidence = parseFloat((1 - p).toFixed(4));
      const [m1, m2] = meansByMetric[primary.id];
      if (p < SIGNIFICANCE_LEVEL && m1 !== m2) {
        winner = m1 > m2 ? vA.id : vB.id;
      }
    }

    return {
      status: "complete",
      variant_results: variantStats,
      statistical_analysis: {
        test: "Welch t-test (normal approximation of t, two-sided)",
        p_values: pValues,
        effect_sizes: effectSizes,
        significance_level: SIGNIFICANCE_LEVEL,
      },
      winner,
      confidence,
    };
  }

  public recommendWinner(experimentId: string): string {
    const results = this.getExperimentResults(experimentId);
    if (!results || results.status !== "complete") {
      return "Insufficient data for recommendation";
    }

    return results.winner || "No clear winner";
  }

  public listExperiments(): Array<{
    id: string;
    name: string;
    status: string;
    sample_count: number;
  }> {
    return Array.from(this.experiments.values()).map((exp) => ({
      id: exp.id,
      name: exp.name,
      status: exp.status,
      sample_count: this.measurements.filter(
        (m) => m.experiment_id === exp.id
      ).length,
    }));
  }
}

// Initialize framework
const abTesting = new ABTestingFramework(
  process.env.EXPERIMENTS_FILE || "./experiments.yaml",
  process.env.AB_DATA_FILE || undefined,
  {
    fsync: /^(1|true|yes)$/i.test(process.env.AB_FSYNC ?? ""),
    warnBytes: Number.parseInt(process.env.AB_DATA_WARN_BYTES ?? "", 10) || undefined,
  }
);

// Tool: Create experiment
export const createExperimentTool = {
  name: "create_experiment",
  description: "Create a new A/B testing experiment",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      hypothesis: { type: "string" },
      variants: { type: "array" },
      traffic_split: { type: "number" },
      metrics: { type: "array" },
    },
    required: ["id", "name", "hypothesis", "variants", "metrics"],
  },
};

// Tool: Assign variant
export const assignVariantTool = {
  name: "assign_variant",
  description: "Assign a user to a variant in an experiment",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
      user_id: { type: "string" },
    },
    required: ["experiment_id"],
  },
};

// Tool: Record metric
export const recordMetricTool = {
  name: "record_metric",
  description: "Record a metric for an experiment variant",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
      variant_id: { type: "string" },
      metrics: { type: "object" },
    },
    required: ["experiment_id", "variant_id", "metrics"],
  },
};

// Tool: Get results
export const getResultsTool = {
  name: "get_experiment_results",
  description: "Get statistical analysis results for an experiment",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
    },
    required: ["experiment_id"],
  },
};

// Tool: Recommend winner
export const recommendWinnerTool = {
  name: "recommend_winner",
  description: "Get a recommendation for the winning variant",
  inputSchema: {
    type: "object" as const,
    properties: {
      experiment_id: { type: "string" },
    },
    required: ["experiment_id"],
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
    case "create_experiment":
      abTesting.createExperiment({
        traffic_split: 0.5,
        ...toolInput,
      } as Experiment);
      return JSON.stringify({ status: "success", experiment_id: toolInput.id });

    case "assign_variant":
      return JSON.stringify(
        abTesting.assignVariant(
          toolInput.experiment_id,
          toolInput.user_id
        )
      );

    case "record_metric":
      abTesting.recordMetric(
        toolInput.experiment_id,
        toolInput.variant_id,
        toolInput.metrics
      );
      return JSON.stringify({ status: "recorded" });

    case "get_experiment_results":
      return JSON.stringify(
        abTesting.getExperimentResults(toolInput.experiment_id)
      );

    case "recommend_winner":
      return JSON.stringify({
        recommendation: abTesting.recommendWinner(toolInput.experiment_id),
      });

    default:
      return JSON.stringify({ error: "Unknown tool" });
  }
}

export { ABTestingFramework, Experiment };
