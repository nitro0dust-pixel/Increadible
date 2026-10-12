/**
 * The gated catalog, step 1a (`docs/GATEWAY-GATED-CATALOG.md`): the built-in registry moved into data (`catalog.ts`), each API with
 * a gate record. What the gateway answers must not change; no API may claim `gated` without evidence for every gate.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { CATALOG, CatalogEntry, catalogCredentials, catalogDefinitions, gateSummaries } from "../features/09-api-gateway/src/catalog";
import { UniversalAPIGateway } from "../features/09-api-gateway/src/mcp-server";

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "gateway-registry-golden.json"), "utf8"));
const root = path.join(__dirname, "..");

/** Every reason a catalog breaks its rules; empty when it holds. Exported shape kept local: the tests below break it on purpose. */
function catalogProblems(catalog: CatalogEntry[]): string[] {
  const found: string[] = [];
  const ids = new Set<string>();
  const dated = (s: { by: string; on: string } | null) => s !== null && s.by.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(s.on);
  for (const { definition: d, credential, gate } of catalog) {
    if (ids.has(d.id)) found.push(`${d.id}: duplicate id`);
    ids.add(d.id);
    if (!/^[a-z0-9]+$/.test(d.id)) found.push(`${d.id}: an id is lower-case letters and digits`);
    let url: URL | undefined;
    try {
      url = new URL(d.endpoint);
    } catch {
      found.push(`${d.id}: endpoint is not a URL`);
    }
    if (url && (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)) found.push(`${d.id}: endpoint must be plain https`);
    if (!["none", "api_key", "oauth", "basic"].includes(d.auth)) found.push(`${d.id}: unknown auth ${d.auth}`);
    if (credential && d.auth !== "api_key") found.push(`${d.id}: a credential on an API whose auth is ${d.auth}`);
    if (credential && !/^GATEWAY_KEY_[A-Z0-9]+$/.test(credential.env)) found.push(`${d.id}: credential variable ${credential.env} is not GATEWAY_KEY_<API>`);
    if (!["candidate", "gated", "degraded"].includes(gate.status)) found.push(`${d.id}: unknown status ${gate.status}`);
    if (gate.status !== "candidate") {
      // gated and degraded both mean "passed every gate once": each gate needs its evidence
      if (!dated(gate.base_url_pinned)) found.push(`${d.id}: ${gate.status} without a dated sign-off on the pinned base URL`);
      if (!dated(gate.auth_confirmed)) found.push(`${d.id}: ${gate.status} without a dated sign-off on the auth class`);
      if (!gate.terms || !dated({ by: gate.terms.by, on: gate.terms.on }) || !/^https:\/\//.test(gate.terms.url) || gate.terms.summary.trim() === "")
        found.push(`${d.id}: ${gate.status} without recorded terms (url, summary, dated sign-off)`);
      if (!gate.probe || gate.probe.success.trim() === "") found.push(`${d.id}: ${gate.status} without a health probe and its success criteria`);
      if (!gate.contract_test || !fs.existsSync(path.join(root, gate.contract_test))) found.push(`${d.id}: ${gate.status} without an existing contract test file`);
      if (!fs.existsSync(path.join(root, "tests", "fixtures", "contracts", `${d.id}.json`))) found.push(`${d.id}: ${gate.status} without a recorded contract (tests/fixtures/contracts/${d.id}.json)`);
    }
    for (const e of gate.live_evidence) if (!/^\d{4}-\d{2}-\d{2}$/.test(e.on) || !e.where || !e.result) found.push(`${d.id}: live evidence without date, place or result`);
  }
  return found;
}

describe("the gated catalog, step 1a: the registry as data", () => {
  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  it("answers discover_apis exactly as the hard-coded registry did: the same nine APIs, fields and order", () => {
    expect(new UniversalAPIGateway({}).discoverAPIs()).toEqual(golden.discover_all);
    expect(catalogDefinitions()).toEqual(golden.discover_all);
  });

  it("finds the same APIs for the same searches", () => {
    const gw = new UniversalAPIGateway({});
    for (const [query, ids] of Object.entries(golden.queries as Record<string, string[]>)) {
      expect({ query, ids: gw.discoverAPIs(query).map((a) => a.id) }).toEqual({ query, ids });
    }
  });

  it("answers sample data of the same shape for every API, and takes credentials from the same variables", async () => {
    const gw = new UniversalAPIGateway({});
    for (const [id, shape] of Object.entries(golden.mock as Record<string, { source: string; dataKeys: string[] }>)) {
      const r = await gw.callAPI(id, "/x", { q: "t" });
      expect({ id, source: r.source, dataKeys: Object.keys(r.data ?? {}).sort() }).toEqual({ id, ...shape });
    }
    expect(catalogCredentials()).toEqual(golden.credentials);
    expect(Object.fromEntries((gw as any).credentials)).toEqual(golden.credentials);
  });

  it("keeps its rules: unique plain-https APIs, known auth and status, and no gated API without evidence for every gate", () => {
    expect(catalogProblems(CATALOG)).toEqual([]);
  });

  it("says honestly where step 1a stands: every API is still a candidate, and only the four keyless APIs have live evidence", () => {
    expect(CATALOG.map((e) => e.gate.status)).toEqual(Array(CATALOG.length).fill("candidate"));
    const withEvidence = CATALOG.filter((e) => e.gate.live_evidence.length > 0).map((e) => e.definition.id);
    expect(withEvidence).toEqual(["coingecko", "hackernews", "wikipedia", "wikidata"]);
    for (const e of CATALOG.filter((x) => x.gate.live_evidence.length > 0)) expect(e.definition.auth).toBe("none");
  });

  describe("its rules really check (each breakage is reported)", () => {
    const clone = (): CatalogEntry[] => JSON.parse(JSON.stringify(CATALOG));
    const cases: Array<[string, (c: CatalogEntry[]) => void, RegExp]> = [
      ["an API marked gated with no evidence", (c) => (c[2].gate.status = "gated"), /coingecko: gated without a dated sign-off on the pinned base URL/],
      ["an API marked gated whose contract test file does not exist", (c) => {
        Object.assign(c[2].gate, {
          status: "gated",
          base_url_pinned: { by: "owner", on: "2026-10-10" },
          auth_confirmed: { by: "owner", on: "2026-10-10" },
          terms: { by: "owner", on: "2026-10-10", url: "https://example.org/terms", summary: "s" },
          probe: { endpoint: "/ping", params: {}, success: "200 with gecko_says" },
          contract_test: "tests/no-such-file.test.ts",
        });
      }, /coingecko: gated without an existing contract test file/],
      // thesportsdb, not coingecko: coingecko has had a recording since 2026-10-10, so it can no longer stand for "no recording"
      ["an API marked gated with every gate filled but no recorded answer", (c) => {
        Object.assign(c[8].gate, {
          status: "gated",
          base_url_pinned: { by: "owner", on: "2026-10-10" },
          auth_confirmed: { by: "owner", on: "2026-10-10" },
          terms: { by: "owner", on: "2026-10-10", url: "https://example.org/terms", summary: "s" },
          probe: { endpoint: "/all_leagues.php", params: {}, success: "200 with leagues" },
          contract_test: "tests/gateway-contracts.test.ts",
        });
      }, /^thesportsdb: gated without a recorded contract \(tests\/fixtures\/contracts\/thesportsdb\.json\)$/],
      ["a degraded API with its terms removed", (c) => (c[2].gate.status = "degraded"), /coingecko: degraded without recorded terms/],
      ["a duplicate id", (c) => (c[1].definition.id = c[0].definition.id), /openweathermap: duplicate id/],
      ["an http endpoint", (c) => (c[0].definition.endpoint = "http://api.openweathermap.org/data/2.5"), /openweathermap: endpoint must be plain https/],
      ["an endpoint with a query", (c) => (c[0].definition.endpoint += "?appid=x"), /openweathermap: endpoint must be plain https/],
      ["an unknown auth", (c) => ((c[0].definition as any).auth = "token"), /openweathermap: unknown auth token/],
      ["a credential on a keyless API", (c) => (c[2].credential = { env: "GATEWAY_KEY_COINGECKO", in: "query", name: "k" }), /coingecko: a credential on an API whose auth is none/],
      ["a credential read from another variable", (c) => (c[0].credential!.env = "AUTH_TOKEN"), /credential variable AUTH_TOKEN is not GATEWAY_KEY_<API>/],
      ["live evidence without a date", (c) => (c[2].gate.live_evidence[0].on = "today"), /coingecko: live evidence without date/],
    ];
    it.each(cases)("%s", (_name, change, expected) => {
      const broken = clone();
      change(broken);
      expect(catalogProblems(broken).join("\n")).toMatch(expected);
    });
  });
});

describe("the gate records in get_api_stats (owner decision, 2026-10-10: read-only, through get_api_stats)", () => {
  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  it("shows every registered API's gate record, all candidate today, with nothing signed off yet (the keyless four name their contract test)", () => {
    const gates = new UniversalAPIGateway({}).getStats().gates;
    expect(Object.keys(gates)).toEqual(CATALOG.map((e) => e.definition.id));
    expect(gates.coingecko).toEqual({
      status: "candidate",
      auth: "none",
      base_url_pinned_on: null,
      auth_confirmed_on: null,
      terms: null,
      probe: "/ping",
      contract_test: "tests/gateway-contracts.test.ts",
      live_evidence: { calls: 2, last_on: "2026-10-10" },
    });
    expect(gates.finnhub).toMatchObject({ status: "candidate", auth: "api_key", probe: null, live_evidence: { calls: 0, last_on: null } });
  });

  it("shows sign-off dates and the terms' address once recorded, and never the terms' text", () => {
    const signed: CatalogEntry[] = JSON.parse(JSON.stringify(CATALOG));
    Object.assign(signed[2].gate, {
      status: "gated",
      base_url_pinned: { by: "owner", on: "2026-10-11" },
      auth_confirmed: { by: "owner", on: "2026-10-12" },
      terms: { by: "owner", on: "2026-10-13", url: "https://example.org/terms", summary: "SECRET-LOOKING TEXT" },
      contract_test: "tests/gateway-contracts.test.ts",
    });
    const g = gateSummaries(["coingecko"], signed).coingecko;
    expect(g).toMatchObject({ status: "gated", base_url_pinned_on: "2026-10-11", auth_confirmed_on: "2026-10-12", terms: { url: "https://example.org/terms", on: "2026-10-13" } });
    expect(JSON.stringify(g)).not.toMatch(/SECRET-LOOKING|owner/);
  });

  it("lists only the APIs the gateway serves: a registry replaced in code has no gate records", () => {
    const custom = new UniversalAPIGateway({ apis: [{ id: "local", name: "Local", category: "test", endpoint: "https://127.0.0.1/x", methods: ["GET"], auth: "none", free: true, description: "t" }] });
    expect(custom.getStats().gates).toEqual({});
  });
});

