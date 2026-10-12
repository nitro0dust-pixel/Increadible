/**
 * The terms review of the gateway's APIs (features/09-api-gateway/data/terms-review.json; owner's request of 2026-10-12). It records
 * what was found and how, and approves nothing: these tests hold it to the catalog, to its own honesty rules, and to the rule that
 * no sign-off is written without the owner.
 */
import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { CATALOG } from "../features/09-api-gateway/src/catalog";

const root = path.join(__dirname, "..");
const FILE = "features/09-api-gateway/data/terms-review.json";
const review = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
const METHODS = ["read on the page", "search summary of the official page", "third party"];

describe(`the terms review (${FILE})`, () => {
  it("covers every catalog API once, with the catalog's own base URL and auth class", () => {
    const ids: string[] = review.apis.map((a: any) => a.id);
    expect([...ids].sort()).toEqual(CATALOG.map((e) => e.definition.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of review.apis) {
      const entry = CATALOG.find((e) => e.definition.id === a.id)!;
      expect({ id: a.id, base_url: a.base_url, auth: a.auth }).toEqual({ id: a.id, base_url: entry.definition.endpoint, auth: entry.definition.auth });
    }
  });

  it("dates the review, and says for every finding where it came from and how it was read", () => {
    expect(review.reviewed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const a of review.apis) {
      expect(a.official_pages.length).toBeGreaterThan(0);
      for (const u of a.official_pages) expect(new URL(u).protocol).toBe("https:");
      expect(a.findings.length).toBeGreaterThan(0);
      for (const f of a.findings) {
        expect({ id: a.id, method: METHODS.includes(f.method), source: new URL(f.source).protocol }).toEqual({ id: a.id, method: true, source: "https:" });
        expect(f.claim.trim()).not.toBe("");
      }
      expect(a.account_tier_configured.trim()).not.toBe("");
    }
  });

  it("calls a rate limit verified only when it was read on the provider's own page", () => {
    for (const a of review.apis) {
      const readOnPage = a.findings.some((f: any) => f.method === "read on the page");
      if (a.rate_limit.verified) expect({ id: a.id, readOnPage }).toEqual({ id: a.id, readOnPage: true });
    }
    expect(review.apis.filter((a: any) => a.rate_limit.verified).map((a: any) => a.id)).toEqual(["hackernews"]);
  });

  it("approves nothing: no entry carries a sign-off, and no catalog API has recorded terms", () => {
    for (const a of review.apis) expect({ id: a.id, owner_signoff: a.owner_signoff }).toEqual({ id: a.id, owner_signoff: null });
    expect(review.note).toMatch(/Not an approval/);
    for (const e of CATALOG) expect({ id: e.definition.id, terms: e.gate.terms }).toEqual({ id: e.definition.id, terms: null });
  });

  it("is read by no server code", () => {
    const sources = ["src", "features/09-api-gateway/src"].flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => fs.readFileSync(path.join(root, d, f), "utf8")));
    for (const text of sources) expect(text).not.toMatch(/terms-review/);
  });
});
