/**
 * Contract tests (gate 6 of the gated catalog, `docs/GATEWAY-GATED-CATALOG.md`): a real answer of each API's health probe,
 * recorded by `scripts/record-contracts.js` on a machine that can reach the provider, replayed through the gateway's live path.
 * The probes and their checks (gate 4) are in `catalog.ts` and `probes.ts`.
 *
 * Synthetic bodies below exercise the checks and the replay; they are shapes from the providers' documentation, not recordings,
 * and are never evidence for a gate. Only the files in `tests/fixtures/contracts/` are.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { CATALOG } from "../features/09-api-gateway/src/catalog";
import { buildRequestUrl } from "../features/09-api-gateway/src/live";
import { PROBE_CHECKS, probeProblems } from "../features/09-api-gateway/src/probes";
import { UniversalAPIGateway } from "../features/09-api-gateway/src/mcp-server";

interface Fixture {
  api: string;
  recorded_on: string;
  recorded_where: string;
  request: { endpoint: string; params: Record<string, string>; url: string };
  response: { status: number; content_type: string; body: unknown };
}

const contractsDir = path.join(__dirname, "fixtures", "contracts");
const recorded: Fixture[] = fs.existsSync(contractsDir)
  ? fs.readdirSync(contractsDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(contractsDir, f), "utf8")))
  : [];

/** Every reason a recorded answer is not a valid contract for the API's current probe; empty when it is. */
function fixtureProblems(f: Fixture): string[] {
  const entry = CATALOG.find((e) => e.definition.id === f.api);
  if (!entry) return [`${f.api}: not in the catalog`];
  const probe = entry.gate.probe;
  if (!probe) return [`${f.api}: has no probe in the catalog`];
  const found: string[] = [];
  if (entry.definition.auth !== "none") found.push(`${f.api}: only keyless APIs are recorded`);
  if (Number.isNaN(Date.parse(f.recorded_on))) found.push(`${f.api}: recorded_on is not a date`);
  if (f.request.endpoint !== probe.endpoint || JSON.stringify(f.request.params) !== JSON.stringify(probe.params))
    found.push(`${f.api}: recorded for another probe than the catalog's`);
  if (f.request.url !== buildRequestUrl(entry.definition.endpoint, probe.endpoint, probe.params).href)
    found.push(`${f.api}: recorded from another URL than the gateway builds`);
  if (f.response.status !== 200) found.push(`${f.api}: recorded status ${f.response.status}`);
  if (!/json/i.test(f.response.content_type)) found.push(`${f.api}: recorded content type is not JSON`);
  found.push(...probeProblems(f.api, f.response.body));
  return found;
}

/** Send the probe through the gateway's live path with the recorded answer in place of the network. */
async function replay(f: Fixture): Promise<{ url: string; source: string; data: unknown }> {
  const probe = CATALOG.find((e) => e.definition.id === f.api)!.gate.probe!;
  let url = "";
  jest.spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    url = String(input);
    return new Response(JSON.stringify(f.response.body), { status: f.response.status, headers: { "content-type": f.response.content_type } });
  }) as typeof fetch);
  const result = await new UniversalAPIGateway({ liveApis: [f.api] }).callAPI(f.api, probe.endpoint, probe.params);
  return { url, source: result.source, data: result.data };
}

/** A fixture as the recorder would write it, around a synthetic body. */
function synthetic(api: string, body: unknown): Fixture {
  const entry = CATALOG.find((e) => e.definition.id === api)!;
  const probe = entry.gate.probe!;
  return {
    api,
    recorded_on: "2026-10-10T00:00:00.000Z",
    recorded_where: "synthetic",
    request: { endpoint: probe.endpoint, params: probe.params, url: buildRequestUrl(entry.definition.endpoint, probe.endpoint, probe.params).href },
    response: { status: 200, content_type: "application/json; charset=utf-8", body },
  };
}

const GOOD: Record<string, unknown> = {
  coingecko: { gecko_says: "(V3) To the Moon!" },
  hackernews: 50028141,
  wikipedia: { batchcomplete: "", query: { general: { sitename: "Wikipedia", base: "https://en.wikipedia.org/wiki/Main_Page" } } },
  wikidata: { entities: { Q2: { type: "item", id: "Q2", labels: { en: { language: "en", value: "Earth" } } } }, success: 1 },
};

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => undefined); // "Live API calls enabled for ..."
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("health probes and contract tests (gated catalog, step 1b)", () => {
  it("gives exactly the keyless APIs a probe, each with a check in probes.ts and a path the gateway accepts", () => {
    const withProbe = CATALOG.filter((e) => e.gate.probe).map((e) => e.definition.id);
    expect(withProbe).toEqual(["coingecko", "hackernews", "wikipedia", "wikidata"]);
    expect(Object.keys(PROBE_CHECKS).sort()).toEqual([...withProbe].sort());
    for (const e of CATALOG.filter((x) => x.gate.probe)) {
      expect(e.definition.auth).toBe("none");
      expect(e.gate.probe!.success.trim()).not.toBe("");
      expect(() => buildRequestUrl(e.definition.endpoint, e.gate.probe!.endpoint, e.gate.probe!.params)).not.toThrow();
    }
  });

  it("says honestly which APIs have a recorded contract (the keyless four, recorded on the owner's Windows PC on 2026-10-10)", () => {
    expect(recorded.map((f) => f.api)).toEqual(["coingecko", "hackernews", "wikidata", "wikipedia"]);
    for (const f of recorded) expect({ api: f.api, on: f.recorded_on.slice(0, 10), where: f.recorded_where }).toEqual({ api: f.api, on: "2026-10-10", where: "owner's Windows PC" });
  });

  for (const f of recorded) {
    it(`${f.api}: the recorded answer is a valid contract and replays through the gateway unchanged`, async () => {
      expect(fixtureProblems(f)).toEqual([]);
      const r = await replay(f);
      expect(r).toEqual({ url: f.request.url, source: "live", data: f.response.body });
    });
  }

  describe("the checks accept a healthy answer and refuse a broken one (synthetic bodies)", () => {
    it.each(Object.keys(GOOD))("%s: a healthy answer passes and replays", async (api) => {
      const f = synthetic(api, GOOD[api]);
      expect(fixtureProblems(f)).toEqual([]);
      expect(await replay(f)).toEqual({ url: f.request.url, source: "live", data: GOOD[api] });
    });

    const broken: Array<[string, (f: Fixture) => void, RegExp]> = [
      ["coingecko without gecko_says", (f) => (f.response.body = {}), /coingecko: no non-empty string gecko_says/],
      ["hackernews answering null", (f) => (f.response.body = null), /hackernews: not a positive integer/],
      ["wikipedia answering an API error with HTTP 200", (f) => (f.response.body = { error: { code: "badvalue" } }), /wikipedia: the API answered an error: badvalue/],
      ["wikipedia from another wiki", (f) => ((f.response.body as any).query.general.base = "https://de.wikipedia.org/wiki/X"), /not on https:\/\/en\.wikipedia\.org/],
      ["wikidata with another label", (f) => ((f.response.body as any).entities.Q2.labels.en.value = "Moon"), /wikidata: .*"Moon", not "Earth"/],
      ["a recording for another probe", (f) => (f.request.params = { action: "query" }), /recorded for another probe/],
      ["a recording from another URL", (f) => (f.request.url = "https://example.org/w/api.php"), /recorded from another URL/],
      ["a recorded error status", (f) => (f.response.status = 503), /recorded status 503/],
      ["a recorded HTML answer", (f) => (f.response.content_type = "text/html"), /content type is not JSON/],
      ["a recording of a key-based API", (f) => (f.api = "finnhub"), /finnhub: has no probe/],
    ];
    it.each(broken)("%s is reported", (_name, change, expected) => {
      const api = /^(coingecko|hackernews|wikipedia|wikidata)/.exec(_name)?.[1] ?? "wikipedia";
      const f = synthetic(api, JSON.parse(JSON.stringify(GOOD[api])));
      change(f);
      expect(fixtureProblems(f).join("\n")).toMatch(expected);
    });

    it("an API without a check is a problem, not a pass", () => {
      expect(probeProblems("thesportsdb", {})).toEqual(["thesportsdb: no probe check is defined"]);
    });
  });
});
