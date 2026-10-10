/**
 * The gated catalog's candidate store (step 4, `docs/GATEWAY-GATED-CATALOG.md`): a snapshot of the public-apis list turned into
 * candidate records by `scripts/seed-candidates.js`. Candidates are seed material only: never trusted, never callable. These tests
 * hold the importer to its rules, the committed store to its own counts and licence, and the server to never reading it.
 */
import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { CATALOG } from "../features/09-api-gateway/src/catalog";
import { UniversalAPIGateway } from "../features/09-api-gateway/src/mcp-server";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parsePublicApis, counts } = require("../scripts/seed-candidates.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { report, matchCatalog, DOC } = require("../scripts/candidate-report.js");

const root = path.join(__dirname, "..");
const STORE = "features/09-api-gateway/data/candidates-public-apis.json";
const store = JSON.parse(fs.readFileSync(path.join(root, STORE), "utf8"));

const SAMPLE = [
  "# Sponsor",
  "### APIs Covered Under Some Suite!",
  "| API | Description | Auth | HTTPS | CORS |",
  "|:---|:---|:---|:---|:---|",
  "| [Sponsored](https://sponsor.example/) | Not part of the list | No | Yes | Yes |",
  "## Index",
  "### Animals",
  "API | Description | Auth | HTTPS | CORS |",
  "|:---|:---|:---|:---|:---|",
  "| [Cat Facts](https://a.example/) | Daily cat facts | No | Yes | No |",
  "| [Cat Facts](https://b.example/) | Random cat facts | `apiKey` | Yes | Yes |",
  "| [Trailing](https://c.example/) | An empty extra cell | `OAuth` | No | Unknown | |",
  "| [Spaced](https://d.example/ ) | A space inside the link | No | Yes | No |",
  "| [Extra](https://e.example/) | Too many cells | No | Yes | No | Yes",
  "| Plain | No link | No | Yes | No |",
  "| [Script](javascript:alert(1)) | Not an http link | No | Yes | No |",
  "**[⬆ Back to Index](#index)**",
  "| [After](https://f.example/) | After the table ended | No | Yes | No |",
  "### Weather",
  "| API | Description | Auth | HTTPS | CORS |",
  "|:---|:---|:---|:---|:---|",
  `| [${"N".repeat(150)}](https://g.example/) | ${"d".repeat(400)} | No | Yes | Yes |`,
  "## License",
  "### Not a category",
  "| API | Description | Auth | HTTPS | CORS |",
  "| [Late](https://h.example/) | After the licence heading | No | Yes | No |",
].join("\n");

describe("the seed importer (scripts/seed-candidates.js)", () => {
  const { candidates, skipped } = parsePublicApis(SAMPLE);

  it("reads only the list's tables, between '## Index' and '## License', with or without outer pipes", () => {
    expect(candidates.map((c: any) => c.docs_url)).toEqual(["https://a.example/", "https://b.example/", "https://c.example/", "https://g.example/"]);
  });

  it("keeps the listed auth as listed (classifying it is gate 2, a person's job), and marks every record a candidate", () => {
    expect(candidates.map((c: any) => c.listed_auth)).toEqual(["No", "apiKey", "OAuth", "No"]);
    expect(new Set(candidates.map((c: any) => c.status))).toEqual(new Set(["candidate"]));
    expect(candidates[2]).toEqual({
      source_id: "animals/trailing",
      name: "Trailing",
      category: "Animals",
      description: "An empty extra cell",
      listed_auth: "OAuth",
      https: false,
      cors: "unknown",
      docs_url: "https://c.example/",
      status: "candidate",
    });
  });

  it("gives duplicate names distinct ids and caps every field it copies", () => {
    expect(candidates.map((c: any) => c.source_id).slice(0, 2)).toEqual(["animals/cat-facts", "animals/cat-facts-2"]);
    expect(candidates[3].name.length).toBe(100);
    expect(candidates[3].description.length).toBe(300);
  });

  it("reports the rows it cannot read, with their line, instead of guessing", () => {
    expect(skipped).toEqual([
      { line: 13, reason: "the first cell is not a [name](http(s) link)" },
      { line: 14, reason: "6 cells, not 5" },
      { line: 15, reason: "the first cell is not a [name](http(s) link)" },
      { line: 16, reason: "the first cell is not a [name](http(s) link)" },
    ]);
  });
});

describe(`the committed candidate store (${STORE})`, () => {
  const ids: string[] = store.candidates.map((c: any) => c.source_id);

  it("says where it came from: the source URL, the date fetched, the SHA-256 of the text, and the MIT licence it is copied under", () => {
    expect(store.source).toBe("public-apis");
    expect(store.source_url).toBe("https://raw.githubusercontent.com/public-apis/public-apis/master/README.md");
    expect(store.fetched_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(store.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.licence).toMatch(/^MIT License\s+Copyright \(c\) 2022 public-apis/);
    expect(store.licence).toContain("The above copyright notice and this permission notice shall be included");
  });

  it("holds candidates only, with unique ids, and counts that match its own records", () => {
    expect(new Set(store.candidates.map((c: any) => c.status))).toEqual(new Set(["candidate"]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(store.counts).toEqual({ ...counts(store.candidates), skipped_rows: store.skipped.length });
    for (const c of store.candidates) expect(c.docs_url).toMatch(/^https?:\/\//);
  });

  it("is read by no server code, compiled into nothing, and shipped in neither the image nor the Claude Desktop package", () => {
    const serverSources = ["src", "features/07-routing-plugins/src", "features/08-ab-testing/src", "features/09-api-gateway/src"]
      .flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => fs.readFileSync(path.join(root, d, f), "utf8")));
    for (const text of serverSources) expect(text).not.toMatch(/candidates-public-apis|09-api-gateway\/data|\.\.\/data/);
    const build = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.build.json"), "utf8"));
    expect(JSON.stringify(build.include ?? [])).not.toMatch(/data/);
    expect(fs.readFileSync(path.join(root, "Dockerfile"), "utf8")).not.toMatch(/09-api-gateway\/data|COPY features\/09-api-gateway\s/);
  });

  it("changes nothing the gateway answers: discover_apis lists the catalog's APIs, never the candidates", () => {
    expect(store.candidates.length).toBeGreaterThan(1000);
    const listed = new UniversalAPIGateway({}).discoverAPIs();
    expect(listed.map((a) => a.id)).toEqual(CATALOG.map((e) => e.definition.id));
  });
});

describe("the candidate report (docs/GATEWAY-CANDIDATES.md, scripts/candidate-report.js)", () => {
  it("is exactly what the generator writes from the committed store and catalog (regenerate it after either changes)", () => {
    expect(fs.readFileSync(path.join(root, DOC), "utf8")).toBe(report(store, CATALOG));
  });

  it("finds each catalog API once in the list, by host before name (by name alone 'WeatherAPI' matches an unrelated project)", () => {
    const found = CATALOG.map((e) => [e.definition.id, matchCatalog(e.definition, store.candidates).map((c: any) => c.source_id)]);
    expect(Object.fromEntries(found)).toEqual({
      openweathermap: ["weather/openweathermap"],
      weatherapi: ["weather/weatherapi"],
      coingecko: ["cryptocurrency/coingecko"],
      finnhub: ["finance/finnhub"],
      newsapi: ["news/news"],
      hackernews: ["social/hackernews"],
      wikipedia: ["open-data/wikipedia"],
      wikidata: ["open-data/wikidata"],
      thesportsdb: ["sports-fitness/thesportsdb"],
    });
    const byName = store.candidates.filter((c: any) => c.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "weatherapi").map((c: any) => c.source_id);
    expect(byName).toEqual(["weather/weather-api", "weather/weatherapi"]);
  });

  it("shows where the list disagrees with the catalog: wikidata is listed as OAuth, but its read API answered keyless on 2026-10-10", () => {
    expect(fs.readFileSync(path.join(root, DOC), "utf8")).toContain("| wikidata | none | `open-data/wikidata` | `OAuth` | **no** |");
  });
});

describe("gate proposals for the first batch (features/09-api-gateway/data/gate-proposals.json)", () => {
  const P = "features/09-api-gateway/data/gate-proposals.json";
  const file = JSON.parse(fs.readFileSync(path.join(root, P), "utf8"));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildRequestUrl } = require("../features/09-api-gateway/src/live");

  it("proposes the five the owner chose, each from a keyless HTTPS Cryptocurrency candidate, none already in the catalog", () => {
    expect(file.proposals.map((p: any) => p.id)).toEqual(["coincap", "coinpaprika", "coinlore", "defillama", "mempool"]);
    const byId = new Map(store.candidates.map((c: any) => [c.source_id, c]));
    const catalogIds = new Set(CATALOG.map((e) => e.definition.id));
    for (const p of file.proposals) {
      const c: any = byId.get(p.candidate);
      expect({ id: p.id, category: c?.category, auth: c?.listed_auth, https: c?.https }).toEqual({ id: p.id, category: "Cryptocurrency", auth: "No", https: true });
      expect(catalogIds.has(p.id)).toBe(false);
    }
  });

  it("holds only proposals: plain https endpoints, a probe the gateway would accept, a thing to check first, status proposed", () => {
    for (const p of file.proposals) {
      const u = new URL(p.endpoint);
      expect({ id: p.id, ok: u.protocol === "https:" && !u.search && !u.hash && !u.username }).toEqual({ id: p.id, ok: true });
      expect(() => buildRequestUrl(p.endpoint, p.probe.endpoint, p.probe.params)).not.toThrow();
      expect(p.probe.success.trim()).not.toBe("");
      expect(p.check_first.trim()).not.toBe("");
      expect(p.status).toBe("proposed");
    }
    expect(file.note).toMatch(/UNVERIFIED/);
  });

  it("says where each finding came from and how far to trust it (search summaries, 2026-10-10: not verification)", () => {
    for (const p of file.proposals) {
      const f = p.found_2026_10_10;
      expect({ id: p.id, summary: f?.summary?.trim().length > 0, reliability: f?.reliability?.trim().length > 0 }).toEqual({ id: p.id, summary: true, reliability: true });
      expect(f.sources.length).toBeGreaterThan(0);
      for (const u of f.sources) expect(new URL(u).protocol).toBe("https:");
    }
    expect(file.note).toMatch(/not verification/);
  });

  it("is read by no server code (proposals are never callable)", () => {
    const sources = ["src", "features/09-api-gateway/src"].flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => fs.readFileSync(path.join(root, d, f), "utf8")));
    for (const text of sources) expect(text).not.toMatch(/gate-proposals/);
  });
});
