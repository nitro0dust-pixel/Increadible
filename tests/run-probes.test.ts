/**
 * `scripts/run-probes.js`: the probe runner and its history (gated catalog, gate 4 and the evidence record). The runner is fed the
 * gateway's sources here and the recorded contract answers in place of the network, so CI never reaches a provider; on a real
 * machine it loads the same code from `dist/`. The recorded answers are evidence of one day; these tests prove only the runner.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { CATALOG } from "../features/09-api-gateway/src/catalog";
import { probeProblems } from "../features/09-api-gateway/src/probes";
import { UniversalAPIGateway, userAgentFromEnv, hasContact } from "../features/09-api-gateway/src/mcp-server";

const runner = require("../scripts/run-probes.js");

const contractsDir = path.join(__dirname, "fixtures", "contracts");
const recorded: Record<string, { response: { status: number; content_type: string; body: unknown } }> = Object.fromEntries(
  fs.readdirSync(contractsDir).filter((f) => f.endsWith(".json")).map((f) => {
    const fx = JSON.parse(fs.readFileSync(path.join(contractsDir, f), "utf8"));
    return [fx.api, fx];
  }),
);
const modules = { UniversalAPIGateway, probeProblems };
const keyless = CATALOG.filter((e) => e.gate.probe && e.definition.auth === "none");
const UA = "increadible-gateway/test (probe@example.org)";

/** A fetch that answers each provider's host with its recorded answer, or with `override` for the APIs named in it. */
function replayFetch(override: Record<string, () => Response> = {}, seen: string[] = []): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    seen.push(`${url} ${init?.headers?.["User-Agent"] ?? ""}`);
    const entry = CATALOG.find((e) => url.startsWith(new URL(e.definition.endpoint).origin));
    if (!entry) throw new Error(`unexpected host: ${url}`);
    const id = entry.definition.id;
    if (override[id]) return override[id]();
    const r = recorded[id].response;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": r.content_type } });
  }) as typeof fetch;
}

let tick = 0;
const clock = () => (tick += 40);
const now = () => new Date("2026-10-14T05:00:00.000Z");
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile(name = "history.jsonl"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "probes-"));
  tmp.push(d);
  return path.join(d, name);
}

describe("run-probes: sending the probes", () => {
  it("probes exactly the keyless APIs with a probe, through the live path, with the given User-Agent", async () => {
    expect(keyless.map((e) => e.definition.id).sort()).toEqual(["coingecko", "hackernews", "wikidata", "wikipedia"]);
    const seen: string[] = [];
    const lines = await runner.runProbes({ modules, entries: runner.chooseEntries(CATALOG, []), userAgent: UA, where: "test", fetchImpl: replayFetch({}, seen), now, clock });
    expect(lines.map((l: any) => l.api).sort()).toEqual(["coingecko", "hackernews", "wikidata", "wikipedia"]);
    for (const l of lines) {
      expect(l).toEqual({ api: l.api, at: "2026-10-14T05:00:00.000Z", where: "test", ok: true, latency_ms: 40, http_status: 200, problems: [] });
    }
    expect(seen).toHaveLength(4);
    for (const s of seen) expect(s.endsWith(UA)).toBe(true);
  });

  it("records a failed check, an HTTP error and a network error as failures, with the reason, and does not retry", async () => {
    let hnCalls = 0;
    const lines = await runner.runProbes({
      modules,
      entries: runner.chooseEntries(CATALOG, []),
      userAgent: UA,
      where: "test",
      now,
      clock,
      fetchImpl: replayFetch({
        coingecko: () => new Response(JSON.stringify({ gecko_says: "" }), { status: 200, headers: { "content-type": "application/json" } }),
        hackernews: () => {
          hnCalls++;
          return new Response("busy", { status: 503, headers: { "content-type": "text/plain" } });
        },
        wikidata: () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        },
      }),
    });
    const by = Object.fromEntries(lines.map((l: any) => [l.api, l]));
    expect(by.coingecko).toMatchObject({ ok: false, http_status: 200 });
    expect(by.coingecko.problems.join()).toContain("gecko_says");
    expect(by.hackernews).toMatchObject({ ok: false, http_status: 503 });
    expect(hnCalls).toBe(1);
    expect(by.wikidata).toMatchObject({ ok: false, http_status: null });
    expect(by.wikidata.problems).toHaveLength(1);
    expect(by.wikidata.problems[0]).toMatch(/^wikidata: (?!wikidata:)/);
    expect(by.wikipedia).toMatchObject({ ok: true });
  });

  it("restores the global fetch, also after a failure", async () => {
    const before = globalThis.fetch;
    await runner.runProbes({ modules, entries: runner.chooseEntries(CATALOG, ["hackernews"]), userAgent: UA, where: "t", now, clock, fetchImpl: replayFetch({ hackernews: () => { throw new Error("down"); } }) });
    expect(globalThis.fetch).toBe(before);
  });

  it("refuses an unknown API, a key-based API and an API without a probe", () => {
    expect(() => runner.chooseEntries(CATALOG, ["nope"])).toThrow("unknown API nope");
    expect(() => runner.chooseEntries(CATALOG, ["newsapi"])).toThrow("needs a credential");
    const noProbe = [{ definition: { id: "x", auth: "none" }, gate: { probe: null } }];
    expect(() => runner.chooseEntries(noProbe, ["x"])).toThrow("has no probe");
    expect(runner.chooseEntries(CATALOG, ["wikidata"]).map((e: any) => e.definition.id)).toEqual(["wikidata"]);
    // A key-based API with a probe (none has one today) is still never probed, so no credential can be sent or recorded.
    const keyed = [{ definition: { id: "k", auth: "api_key" }, gate: { probe: { endpoint: "/", params: {} } } }, { definition: { id: "f", auth: "none" }, gate: { probe: { endpoint: "/", params: {} } } }];
    expect(runner.chooseEntries(keyed, []).map((e: any) => e.definition.id)).toEqual(["f"]);
    expect(() => runner.chooseEntries(keyed, ["k"])).toThrow("needs a credential");
  });
});

describe("run-probes: the history", () => {
  it("appends one line per probe, never rewrites, and reads back what it wrote", async () => {
    const file = tmpFile();
    const first = await runner.runProbes({ modules, entries: runner.chooseEntries(CATALOG, []), userAgent: UA, where: "a", fetchImpl: replayFetch(), now, clock });
    runner.appendHistory(file, first);
    const second = await runner.runProbes({ modules, entries: runner.chooseEntries(CATALOG, ["hackernews"]), userAgent: UA, where: "b", now, clock, fetchImpl: replayFetch({ hackernews: () => new Response("x", { status: 500 }) }) });
    runner.appendHistory(file, second);
    const text = fs.readFileSync(file, "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(5);
    expect(runner.readHistory(file)).toEqual([...first, ...second]);
    expect(text).not.toContain("probe@example.org");
    expect(text).not.toContain("gecko_says");
  });

  it("refuses a history line that is not JSON or not a probe record, naming the line", () => {
    const file = tmpFile();
    fs.writeFileSync(file, `${JSON.stringify({ api: "a", at: "t", ok: true })}\nnot json\n`);
    expect(() => runner.readHistory(file)).toThrow("line 2: not JSON");
    fs.writeFileSync(file, `${JSON.stringify({ api: "a", at: "t", ok: true })}\n\n${JSON.stringify({ api: "a", ok: "yes", at: "t" })}\n`);
    expect(() => runner.readHistory(file)).toThrow("line 3: not a probe record");
  });

  it("summarizes per API: runs, failures, failures in a row at the end, last run, median latency of the passed probes", () => {
    const r = (api: string, ok: boolean, at: string, latency_ms: number) => ({ api, ok, at, latency_ms });
    const summary = runner.summarize([
      r("hackernews", true, "1", 100),
      r("wikipedia", false, "1", 900),
      r("hackernews", false, "2", 5000),
      r("hackernews", true, "3", 300),
      r("wikipedia", false, "2", 900),
      r("hackernews", true, "4", 200),
      r("hackernews", true, "5", 400),
    ]);
    expect(summary).toEqual([
      { api: "hackernews", runs: 5, failed: 1, failing_in_a_row: 0, last: "5", median_latency_ms: 250 },
      { api: "wikipedia", runs: 2, failed: 2, failing_in_a_row: 2, last: "2", median_latency_ms: null },
    ]);
    expect(runner.summarize([r("a", true, "1", 10), r("a", true, "2", 30), r("a", true, "3", 20)])[0].median_latency_ms).toBe(20);
    expect(runner.formatReport(summary)).toContain("wikipedia: 2 runs, 2 failed, 2 failing in a row, last 2, median latency n/a");
    expect(runner.formatReport([])).toBe("run-probes: the history holds no probes");
  });
});

describe("run-probes: the command line", () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync("node", ["scripts/run-probes.js", ...args], { encoding: "utf8", timeout: 30000, env: { ...process.env, GATEWAY_USER_AGENT: "", GATEWAY_CONTACT: "", ...env } });

  it("parses its arguments and refuses bad ones before any request", () => {
    expect(runner.parseArgs([])).toEqual({ command: "run", history: "probe-history.jsonl", where: "not stated", ids: [] });
    expect(runner.parseArgs(["--history", "h.jsonl", "--where", "pc", "hackernews"])).toEqual({ command: "run", history: "h.jsonl", where: "pc", ids: ["hackernews"] });
    expect(runner.parseArgs(["report", "--history", "h.jsonl"])).toMatchObject({ command: "report", history: "h.jsonl" });
    expect(() => runner.parseArgs(["--force"])).toThrow("unknown option --force");
    expect(() => runner.parseArgs(["--history"])).toThrow("--history needs a value");
    expect(() => runner.parseArgs(["report", "hackernews"])).toThrow("report takes no API ids");
    const r = run(["--where"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--where needs a value");
  });

  it("report: prints the summary of a history, and refuses a missing file", () => {
    const file = tmpFile();
    fs.writeFileSync(file, [{ api: "hackernews", at: "2026-10-14T05:00:00.000Z", ok: true, latency_ms: 120 }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ok = run(["report", "--history", file]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("run-probes: hackernews: 1 runs, 0 failed, 0 failing in a row, last 2026-10-14T05:00:00.000Z, median latency 120 ms");
    const missing = run(["report", "--history", `${file}.none`]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("no history at");
  });

  it("refuses to probe without a contact in the User-Agent, before any request, and writes nothing", async () => {
    const file = tmpFile();
    const load = () => ({ CATALOG, UniversalAPIGateway, userAgentFromEnv, hasContact, probeProblems });
    const saved = { contact: process.env.GATEWAY_CONTACT, ua: process.env.GATEWAY_USER_AGENT };
    const seen: string[] = [];
    try {
      delete process.env.GATEWAY_USER_AGENT;
      process.env.GATEWAY_CONTACT = "Nitro";
      await expect(runner.main(["--history", file], load, replayFetch({}, seen))).rejects.toThrow("set GATEWAY_CONTACT");
      expect(seen).toHaveLength(0);
      expect(fs.existsSync(file)).toBe(false);
      process.env.GATEWAY_CONTACT = "probe@example.org";
      expect(await runner.main(["--history", file, "--where", "test", "hackernews"], load, replayFetch({}, seen))).toBe(0);
    } finally {
      for (const [k, v] of [["GATEWAY_CONTACT", saved.contact], ["GATEWAY_USER_AGENT", saved.ua]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("(probe@example.org)");
    expect(runner.readHistory(file).map((l: any) => [l.api, l.ok, l.where])).toEqual([["hackernews", true, "test"]]);
  });
});
