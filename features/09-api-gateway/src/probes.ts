/**
 * What counts as a healthy answer to an API's health probe (gate 4 of the gated catalog, `docs/GATEWAY-GATED-CATALOG.md`).
 *
 * The probe itself (endpoint, params, the success criteria in words) is in the API's gate record in `catalog.ts`; this file holds
 * the same criteria as code, so that a recorded answer (`scripts/record-contracts.js`) and the contract test that replays it
 * (`tests/gateway-contracts.test.ts`) judge it the same way. The criteria are design choices, not measured values.
 */

type Check = (data: any) => string[];

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** MediaWiki answers HTTP 200 with `{ error: {...} }` for a bad request, so a 200 alone proves nothing there. */
const mediaWikiError = (data: any): string[] =>
  isObject(data) && "error" in data ? [`the API answered an error: ${String(data.error?.code ?? "unknown")}`] : [];

export const PROBE_CHECKS: Record<string, Check> = {
  coingecko: (data) =>
    isObject(data) && typeof data.gecko_says === "string" && data.gecko_says.trim() !== "" ? [] : ["no non-empty string gecko_says"],
  hackernews: (data) => (Number.isInteger(data) && data > 0 ? [] : ["not a positive integer item id"]),
  wikipedia: (data) => {
    const err = mediaWikiError(data);
    if (err.length > 0) return err;
    const general = data?.query?.general;
    if (!isObject(general)) return ["no query.general"];
    const found: string[] = [];
    if (general.sitename !== "Wikipedia") found.push(`query.general.sitename is ${JSON.stringify(general.sitename)}, not "Wikipedia"`);
    if (typeof general.base !== "string" || !general.base.startsWith("https://en.wikipedia.org/")) found.push("query.general.base is not on https://en.wikipedia.org/");
    return found;
  },
  wikidata: (data) => {
    const err = mediaWikiError(data);
    if (err.length > 0) return err;
    const label = data?.entities?.Q2?.labels?.en?.value;
    return label === "Earth" ? [] : [`entities.Q2.labels.en.value is ${JSON.stringify(label)}, not "Earth"`];
  },
};

/** Every reason `data` is not a healthy probe answer for `apiId`; empty when it is. An API without a check is a problem itself. */
export function probeProblems(apiId: string, data: unknown): string[] {
  const check = PROBE_CHECKS[apiId];
  if (!check) return [`${apiId}: no probe check is defined`];
  return check(data).map((p) => `${apiId}: ${p}`);
}
