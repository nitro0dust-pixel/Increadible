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

const DIRECTIONS = ["higher_is_better", "lower_is_better"] as const;
type Direction = (typeof DIRECTIONS)[number];

interface Metric {
  id: string;
  name: string;
  type: string;
  aggregation: string;
  /** Which way is better. Default `higher_is_better`; use `lower_is_better` for cost, latency, error rate. */
  direction?: Direction;
  /** A guardrail never decides the winner; it can only withhold one (see `getExperimentResults`). */
  guardrail?: boolean;
}

interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  status: "setup" | "running" | "complete";
  variants: Variant[];
  traffic_split: number;
  metrics: Metric[];
  /** The id of the metric that decides the winner. Default: the first metric. */
  primary_metric?: string;
  /**
   * Relative traffic per variant, in the order of `variants` (any scale: [1, 2, 1] is 25%, 50%, 25%). Overrides `traffic_split`.
   * Without it, two variants use `traffic_split` and more than two share traffic equally.
   */
  weights?: number[];
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
const MAX_VARIANTS = 10;
const MIN_SAMPLES_PER_VARIANT = 30;
const SIGNIFICANCE_LEVEL = 0.05;

/**
 * Holm's step-down adjustment of a family of p-values: controls the chance of any false positive across all of them. With one
 * p-value it returns that p-value unchanged. Adjusted values are never smaller than the raw ones and never above 1.
 */
export function holmAdjust(p: number[]): number[] {
  const order = p.map((_, i) => i).sort((a, b) => p[a] - p[b] || a - b);
  const adjusted = new Array<number>(p.length);
  let running = 0;
  order.forEach((index, rank) => {
    running = Math.max(running, Math.min(1, (p.length - rank) * p[index]));
    adjusted[index] = running;
  });
  return adjusted;
}

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

/**
 * Running aggregates that give the sample statistics of a series without keeping it, so memory does not grow with the
 * number of measurements. `sum` is added up in arrival order, so `sum / n` is the same number a left-to-right sum of
 * the stored values would give (it matters: results are rounded, and a mean can sit exactly on a rounding boundary).
 * `m2` is Welford's running sum of squared deviations, which is steadier than summing squares afterwards.
 */
interface Running {
  n: number;
  sum: number;
  welfordMean: number;
  m2: number;
}

function addValue(r: Running, x: number): void {
  r.n += 1;
  r.sum += x;
  const delta = x - r.welfordMean;
  r.welfordMean += delta / r.n;
  r.m2 += delta * (x - r.welfordMean);
}

function sampleStats(r: Running | undefined) {
  if (!r || r.n === 0) return { n: 0, mean: NaN, variance: 0, std: 0 };
  const variance = r.n > 1 ? Math.max(0, r.m2) / (r.n - 1) : 0;
  // m2 is exactly 0 only when every value is identical, and then the running mean is that value exactly. `sum / n` can be
  // off by a rounding error (59 times 0.1 is not 5.9), which would make two identical constant series look different:
  // zero variance and a difference of 1e-17 is a certain win for one of them.
  const mean = r.m2 === 0 ? r.welfordMean : r.sum / r.n;
  return { n: r.n, mean, variance, std: Math.sqrt(variance) };
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

/**
 * What the module keeps in memory about an experiment's measurements: counts, and a running mean and variance per
 * variant and metric. The raw values stay in the data file only, so memory and the cost of a results call no longer
 * grow with the number of measurements.
 */
interface VariantTally {
  count: number;
  metrics: Map<string, Running>;
}

interface ExperimentTally {
  total: number;
  /** The metric ids the experiment defines (values for other keys are not used by any statistic). */
  metricIds: string[];
  variants: Map<string, VariantTally>;
}

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
  /** Size of the reads used to replay the data file at startup (default 1 MiB). Only tests change it. */
  replayChunkBytes?: number;
}

const DEFAULT_REPLAY_CHUNK_BYTES = 1024 * 1024;

/**
 * Calls `onLine` for every line of the file (split on "\n") reading `chunkBytes` at a time, so replaying a large data
 * file does not need the file in memory. Lines are decoded one by one: a newline byte never occurs inside a multi-byte
 * UTF-8 sequence, so a character split across two reads is joined before it is decoded. A last line without a
 * newline (a torn write) is passed on like any other.
 */
function forEachLine(
  file: string,
  chunkBytes: number,
  onLine: (line: string) => void
): { bytes: number; endsWithNewline: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, chunkBytes));
    let carry: Buffer[] = []; // the start of a line that continues in the next read
    let carried = 0;
    let bytes = 0;
    let lastByte = -1;
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, null);
      if (got === 0) break;
      bytes += got;
      lastByte = buf[got - 1];
      const view = buf.subarray(0, got); // indexOf must not look at stale bytes after `got`
      let start = 0;
      while (start < got) {
        const nl = view.indexOf(0x0a, start);
        if (nl === -1) {
          carry.push(Buffer.from(view.subarray(start))); // copy: `buf` is reused by the next read
          carried += got - start;
          break;
        }
        const piece = view.subarray(start, nl);
        onLine((carried > 0 ? Buffer.concat([...carry, piece]) : piece).toString("utf8"));
        carry = [];
        carried = 0;
        start = nl + 1;
      }
    }
    if (carried > 0) onLine(Buffer.concat(carry).toString("utf8"));
    return { bytes, endsWithNewline: lastByte === 0x0a };
  } finally {
    fs.closeSync(fd);
  }
}

class ABTestingFramework {
  private experiments: Map<string, Experiment> = new Map();
  private tallies: Map<string, ExperimentTally> = new Map();
  private replayChunkBytes: number;
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
    this.replayChunkBytes = options.replayChunkBytes && options.replayChunkBytes > 0 ? options.replayChunkBytes : DEFAULT_REPLAY_CHUNK_BYTES;
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
      let experiments = 0;
      let measurements = 0;
      let skipped = 0;
      let dropped = 0;

      const { bytes, endsWithNewline } = forEachLine(file, this.replayChunkBytes, (line) => {
        if (!line.trim()) return;
        let entry: LogEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          skipped++; // e.g. a line torn by a crash mid-write
          return;
        }
        if (entry?.type === "experiment") {
          try {
            this.validateExperiment(entry.experiment);
          } catch {
            skipped++;
            return;
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
            return;
          }
          this.tally(exp, entry.variant_id, entry.metrics);
          measurements++;
        } else {
          skipped++;
        }
      });
      this.size = bytes;
      this.noteGrowth(0);

      // A crash can leave the last line without a newline; terminate it so the next append
      // starts on its own line instead of being glued to the torn one.
      if (bytes > 0 && !endsWithNewline) {
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
    if (!Array.isArray(experiment.variants) || experiment.variants.length < 2 || experiment.variants.length > MAX_VARIANTS) {
      throw new Error(`Experiment must have between 2 and ${MAX_VARIANTS} variants`);
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
    // More than two variants is new, so ids are checked there (a two-variant experiment written before is never rejected for them).
    if (experiment.variants.length > 2) {
      const seen = new Set<string>();
      for (const v of experiment.variants) {
        if (!v || typeof v.id !== "string" || v.id === "") throw new Error("Every variant must have a non-empty string id");
        if (seen.has(v.id)) throw new Error(`Duplicate variant id: ${v.id}`);
        seen.add(v.id);
      }
    }
    if (experiment.weights !== undefined) {
      const w = experiment.weights;
      if (!Array.isArray(w) || w.length !== experiment.variants.length || !w.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) {
        throw new Error(`weights must be ${experiment.variants.length} positive numbers, one per variant`);
      }
    }
    // The fields below are new: they are checked only when present, so every experiment written before them stays valid
    // (a stricter check on existing fields would silently drop experiments from an existing data file at replay).
    for (const m of experiment.metrics) {
      if (m?.direction !== undefined && !DIRECTIONS.includes(m.direction)) {
        throw new Error(`Metric ${m.id}: direction must be one of ${DIRECTIONS.join(", ")}`);
      }
      if (m?.guardrail !== undefined && typeof m.guardrail !== "boolean") {
        throw new Error(`Metric ${m.id}: guardrail must be true or false`);
      }
    }
    if (experiment.primary_metric !== undefined) {
      const primary = experiment.metrics.find((m) => m?.id === experiment.primary_metric);
      if (!primary) throw new Error(`primary_metric ${String(experiment.primary_metric)} is not one of the experiment's metrics`);
      if (primary.guardrail === true) throw new Error(`primary_metric ${primary.id} cannot also be a guardrail`);
    } else if (experiment.metrics[0]?.guardrail === true) {
      throw new Error(`The first metric ${experiment.metrics[0].id} decides the winner by default, so it cannot be a guardrail; set primary_metric`);
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

  /** Which variant a draw in [0, 1) falls on. Two variants without weights use traffic_split exactly as before. */
  private variantIndex(experiment: Experiment, draw: number): number {
    const n = experiment.variants.length;
    if (experiment.weights !== undefined) {
      const total = experiment.weights.reduce((a, b) => a + b, 0);
      let cumulative = 0;
      for (let i = 0; i < n - 1; i++) {
        cumulative += experiment.weights[i];
        if (draw < cumulative / total) return i;
      }
      return n - 1;
    }
    if (n === 2) return draw < experiment.traffic_split ? 0 : 1;
    return Math.min(n - 1, Math.floor(draw * n));
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
    const variantIndex = this.variantIndex(experiment, draw);
    const selectedVariant = experiment.variants[variantIndex];

    return {
      variant_id: selectedVariant.id,
      experiment_id: experimentId,
    };
  }

  /** Fold one measurement into the running aggregates of its experiment (the raw values live in the data file). */
  private tally(experiment: Experiment, variantId: string, metrics: Record<string, number> | undefined): void {
    let t = this.tallies.get(experiment.id);
    if (!t) {
      const ids = new Set<string>();
      for (const m of experiment.metrics) if (m?.id !== undefined) ids.add(m.id);
      t = { total: 0, metricIds: [...ids], variants: new Map() };
      this.tallies.set(experiment.id, t);
    }
    let v = t.variants.get(variantId);
    if (!v) {
      v = { count: 0, metrics: new Map() };
      t.variants.set(variantId, v);
    }
    t.total += 1;
    v.count += 1;
    if (!metrics || typeof metrics !== "object") return; // counts as a sample, carries no values
    for (const id of t.metricIds) {
      const x = Object.prototype.hasOwnProperty.call(metrics, id) ? metrics[id] : undefined;
      if (typeof x !== "number") continue;
      let r = v.metrics.get(id);
      if (!r) {
        r = { n: 0, sum: 0, welfordMean: 0, m2: 0 };
        v.metrics.set(id, r);
      }
      addValue(r, x);
    }
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
    this.tally(experiment, variantId, metrics);
  }

  public getExperimentResults(experimentId: string): ExperimentResults | null {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    const tally = this.tallies.get(experimentId);
    const total = tally?.total ?? 0;

    if (total < MIN_TOTAL_SAMPLES) {
      return {
        status: "incomplete",
        variant_results: {},
        statistical_analysis: {
          message: `Need ${MIN_TOTAL_SAMPLES - total} more samples`,
          current_samples: total,
        },
        confidence: 0,
      };
    }

    const perVariant = experiment.variants.map((v) => tally?.variants.get(v.id)?.count ?? 0);
    if (perVariant.some((n) => n < MIN_SAMPLES_PER_VARIANT)) {
      return {
        status: "incomplete",
        variant_results: {},
        statistical_analysis: {
          message: `Need at least ${MIN_SAMPLES_PER_VARIANT} samples per variant`,
          current_samples: total,
          samples_per_variant: Object.fromEntries(
            experiment.variants.map((v, i) => [v.id, perVariant[i]])
          ),
        },
        confidence: 0,
      };
    }

    const vs = experiment.variants;
    const variantStats: Record<string, any> = {};
    for (const variant of vs) variantStats[variant.id] = { name: variant.name, metrics: {} };

    // Every pair of variants (i < j) is compared on every metric with Welch's t-test, and Cohen's d is reported. With two
    // variants there is one pair, and the numbers are exactly those this code produced before more variants were allowed.
    interface PairResult {
      p: number;
      effect?: number;
      meanA: number;
      meanB: number;
    }
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) pairs.push([i, j]);
    const pairResults = new Map<string, Array<PairResult | undefined>>();

    for (const metric of experiment.metrics) {
      const groups = vs.map((v) => sampleStats(tally?.variants.get(v.id)?.metrics.get(metric.id)));

      vs.forEach((v, i) => {
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

      pairResults.set(
        metric.id,
        pairs.map(([i, j]) => {
          const [g1, g2] = [groups[i], groups[j]];
          if (g1.n < 2 || g2.n < 2) return undefined;
          const diff = g1.mean - g2.mean;
          const se2 = g1.variance / g1.n + g2.variance / g2.n;

          // Welch's t-test
          let p: number;
          if (se2 === 0) {
            p = diff === 0 ? 1 : 0;
          } else {
            const df =
              (se2 * se2) /
              ((g1.variance / g1.n) ** 2 / (g1.n - 1) +
                (g2.variance / g2.n) ** 2 / (g2.n - 1));
            p = parseFloat(twoSidedPValue(diff / Math.sqrt(se2), df).toPrecision(4));
          }

          // Cohen's d with pooled standard deviation
          const pooled = Math.sqrt(
            ((g1.n - 1) * g1.variance + (g2.n - 1) * g2.variance) / (g1.n + g2.n - 2)
          );
          let effect: number | undefined;
          if (pooled > 0) effect = parseFloat((diff / pooled).toFixed(2));
          else if (diff === 0) effect = 0;
          return { p, effect, meanA: g1.mean, meanB: g2.mean };
        })
      );
    }
    const pairOf = (metricId: string, k: number) => pairResults.get(metricId)?.[k];

    // `isBetter` is true when x beats y on `metric`: the higher value unless the metric says `lower_is_better`.
    const isBetter = (metric: Metric, x: number, y: number) => (metric.direction === "lower_is_better" ? x < y : x > y);

    // Winner: the primary metric alone decides (the first metric unless the experiment names one). The leader is the variant with
    // the best mean. It wins only if it beats EVERY other variant significantly, after Holm's correction over all pairs, so that
    // comparing many variants does not make a lucky difference look significant. With two variants this is the single comparison
    // this code always made (Holm over one comparison changes nothing).
    let winner: string | undefined;
    let confidence = 0;
    let leader: number | undefined;
    const adjusted = new Map<number, number>(); // pair index -> Holm-adjusted p on the primary metric
    const primary =
      experiment.primary_metric === undefined
        ? experiment.metrics[0]
        : experiment.metrics.find((m) => m.id === experiment.primary_metric);
    if (primary && pairs.every((_, k) => pairOf(primary.id, k) !== undefined)) {
      const means = vs.map((v) => sampleStats(tally?.variants.get(v.id)?.metrics.get(primary.id)).mean);
      leader = 0;
      for (let i = 1; i < vs.length; i++) if (isBetter(primary, means[i], means[leader])) leader = i;
      holmAdjust(pairs.map((_, k) => pairOf(primary.id, k)!.p)).forEach((a, k) => adjusted.set(k, a));
      const mine = pairs.map((pr, k) => ({ other: pr[0] === leader ? pr[1] : pr[1] === leader ? pr[0] : -1, k })).filter((x) => x.other >= 0);
      confidence = parseFloat((1 - Math.max(...mine.map((x) => adjusted.get(x.k)!))).toFixed(4));
      if (mine.every((x) => adjusted.get(x.k)! < SIGNIFICANCE_LEVEL && means[leader!] !== means[x.other])) winner = vs[leader].id;
    }

    // Guardrails: metrics that must not get worse. They never pick a winner; they can only withhold one. A winner is
    // withheld when a guardrail is significantly worse for it against any other variant, and also when a guardrail has too
    // little data to judge (a missing check is not a pass). "Not significantly worse" is not proof of "not worse": the same
    // two-sided test at the same level on the same samples is weak when the sample is small, so read the p-value, not only
    // the verdict. Guardrail p-values are NOT corrected for the number of comparisons, which errs towards withholding.
    // The keys below exist only for experiments that declare a guardrail, so every other experiment's output is unchanged.
    const guardrails: Record<string, any> = {};
    const withheldBy: string[] = [];
    const two = vs.length === 2;
    for (const g of experiment.metrics.filter((m) => m.guardrail === true)) {
      if (two) {
        const pr = pairOf(g.id, 0);
        if (pr === undefined) {
          guardrails[g.id] = { p_value: null, significantly_worse_variant: null };
          if (winner !== undefined) withheldBy.push(g.id);
          continue;
        }
        const worse = pr.p < SIGNIFICANCE_LEVEL && pr.meanA !== pr.meanB ? (isBetter(g, pr.meanA, pr.meanB) ? vs[1].id : vs[0].id) : null;
        guardrails[g.id] = { p_value: pr.p, significantly_worse_variant: worse };
        if (winner !== undefined && worse === winner) withheldBy.push(g.id);
        continue;
      }
      // More than two variants: the leader on the primary metric is compared with every other variant.
      const comparisons: Array<{ against: string; p_value: number | null; leader_significantly_worse: boolean }> = [];
      if (leader !== undefined) {
        pairs.forEach(([i, j], k) => {
          if (i !== leader && j !== leader) return;
          const other = i === leader ? j : i;
          const pr = pairOf(g.id, k);
          if (pr === undefined) {
            comparisons.push({ against: vs[other].id, p_value: null, leader_significantly_worse: false });
            return;
          }
          const [mLeader, mOther] = i === leader ? [pr.meanA, pr.meanB] : [pr.meanB, pr.meanA];
          comparisons.push({
            against: vs[other].id,
            p_value: pr.p,
            leader_significantly_worse: pr.p < SIGNIFICANCE_LEVEL && mLeader !== mOther && isBetter(g, mOther, mLeader),
          });
        });
      }
      guardrails[g.id] = { leader: leader === undefined ? null : vs[leader].id, comparisons };
      if (winner !== undefined && comparisons.some((c) => c.p_value === null || c.leader_significantly_worse)) withheldBy.push(g.id);
    }
    const hasGuardrails = Object.keys(guardrails).length > 0;
    if (withheldBy.length > 0) winner = undefined;

    const analysis: Record<string, any> = { test: "Welch t-test (normal approximation of t, two-sided)" };
    if (two) {
      // Unchanged shape for two variants: one p-value and one effect size per metric.
      const pValues: Record<string, number> = {};
      const effectSizes: Record<string, number> = {};
      for (const metric of experiment.metrics) {
        const pr = pairOf(metric.id, 0);
        if (!pr) continue;
        pValues[metric.id] = pr.p;
        if (pr.effect !== undefined) effectSizes[metric.id] = pr.effect;
      }
      analysis.p_values = pValues;
      analysis.effect_sizes = effectSizes;
    } else {
      // More than two variants: every pair on every metric. The primary metric's p-values are also given adjusted (Holm).
      analysis.correction = "Holm-Bonferroni over all pairs of variants, on the primary metric";
      analysis.primary_metric = primary?.id;
      analysis.comparisons = experiment.metrics.flatMap((metric) =>
        pairs.flatMap(([i, j], k) => {
          const pr = pairOf(metric.id, k);
          if (!pr) return [];
          return [
            {
              metric: metric.id,
              a: vs[i].id,
              b: vs[j].id,
              p_value: pr.p,
              ...(metric === primary && adjusted.has(k) ? { adjusted_p_value: parseFloat(adjusted.get(k)!.toPrecision(4)) } : {}),
              ...(pr.effect !== undefined ? { effect_size: pr.effect } : {}),
              better: pr.meanA === pr.meanB ? null : isBetter(metric, pr.meanA, pr.meanB) ? vs[i].id : vs[j].id,
            },
          ];
        })
      );
    }
    analysis.significance_level = SIGNIFICANCE_LEVEL;
    if (hasGuardrails) analysis.guardrails = guardrails;
    if (withheldBy.length > 0) analysis.winner_withheld_by = withheldBy;

    return {
      status: "complete",
      variant_results: variantStats,
      statistical_analysis: analysis,
      winner,
      confidence,
    };
  }

  public recommendWinner(experimentId: string): string {
    const results = this.getExperimentResults(experimentId);
    if (!results || results.status !== "complete") {
      return "Insufficient data for recommendation";
    }
    if (results.winner) return results.winner;
    const withheld: string[] | undefined = results.statistical_analysis.winner_withheld_by;
    return withheld ? `No clear winner (withheld by guardrail: ${withheld.join(", ")})` : "No clear winner";
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
      sample_count: this.tallies.get(exp.id)?.total ?? 0,
    }));
  }
}

/** AB_FSYNC accepts 1, true or yes (any case). Anything else, "on" included, leaves flushing off. */
export function fsyncFromEnv(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value ?? "");
}

// Initialize framework
const abTesting = new ABTestingFramework(
  process.env.EXPERIMENTS_FILE || "./experiments.yaml",
  process.env.AB_DATA_FILE || undefined,
  {
    fsync: fsyncFromEnv(process.env.AB_FSYNC),
    warnBytes: Number.parseInt(process.env.AB_DATA_WARN_BYTES ?? "", 10) || undefined,
  }
);

// Tool: Create experiment
export const createExperimentTool = {
  name: "create_experiment",
  description:
    "Create a new A/B testing experiment with two to ten variants (traffic is split by traffic_split for two, equally for " +
    "more, or by weights). A variant wins only if it is significantly better than every other one. The first metric decides " +
    "the winner unless primary_metric names another; a metric may set direction (higher_is_better, the default, or lower_is_better) " +
    "and guardrail: true (it can withhold a winner but never pick one).",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      hypothesis: { type: "string" },
      variants: { type: "array" },
      traffic_split: { type: "number" },
      metrics: { type: "array" },
      primary_metric: { type: "string" },
      weights: { type: "array" },
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
