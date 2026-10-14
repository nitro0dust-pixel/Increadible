/**
 * Per-API rate limit for live calls (GATEWAY_RATE_LIMITS; step 2 of the gated catalog's order of work,
 * `docs/GATEWAY-GATED-CATALOG.md`). Given in code, no API has a limit unless one is set; from the environment every API also gets
 * GATEWAY_DEFAULT_RATE_LIMIT (tests/gateway-resilience.test.ts).
 * The network is a mocked `fetch` and the clock is a fake one, so every boundary is exact.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  UniversalAPIGateway,
  GatewayOptions,
  MAX_RATE_LIMIT,
  RATE_LIMIT_WINDOW_MS,
  gatewayOptionsFromEnv,
  parseRateLimits,
} from "../features/09-api-gateway/src/mcp-server";

let clock = 0;
let sent: string[] = [];
let status = 200;
let errors: ReturnType<typeof jest.spyOn>;

const open = (options: GatewayOptions) => new UniversalAPIGateway({ liveApis: ["coingecko", "wikipedia"], now: () => clock, ...options });
const fail = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e: any) {
    return String(e.message);
  }
  throw new Error("expected the call to fail");
};
/** A distinct call each time, so the result cache never answers it. */
let n = 0;
const call = (gw: UniversalAPIGateway, id = "coingecko") => gw.callAPI(id, "/ping", { n: n++ });

beforeEach(() => {
  clock = 1_000_000;
  sent = [];
  status = 200;
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    sent.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("per-API rate limit of live calls (GATEWAY_RATE_LIMITS)", () => {
  it("limits nothing when the options set no limit", async () => {
    const gw = open({});
    for (let i = 0; i < 20; i++) await call(gw);
    expect(sent).toHaveLength(20);
    expect(gw.getStats()).toMatchObject({ rate_limits: {}, rate_limited: 0 });
  });

  it("refuses the call over the limit before it reaches the provider, and says when to try again", async () => {
    const gw = open({ rateLimits: { coingecko: 2 } });
    await call(gw);
    await call(gw);
    expect(await fail(call(gw))).toBe("coingecko: rate limit reached: at most 2 live calls per minute to this API (GATEWAY_RATE_LIMITS); try again in 60 s");
    expect(sent).toHaveLength(2);
    expect(gw.getStats()).toMatchObject({ rate_limits: { coingecko: 2 }, rate_limited: 1, failed: 1, live_calls: 2 });
  });

  it("is a rolling minute: a call frees its place exactly one window after it was sent", async () => {
    const gw = open({ rateLimits: { coingecko: 2 } });
    await call(gw); // t0
    clock += 30_000;
    await call(gw); // t0 + 30 s
    clock += RATE_LIMIT_WINDOW_MS - 30_000 - 1; // 1 ms before the first call leaves the window
    expect(await fail(call(gw))).toMatch(/try again in 1 s$/);
    clock += 1; // the first call is now a full window old
    await call(gw);
    expect(await fail(call(gw))).toMatch(/try again in 30 s$/); // the second call (t0 + 30 s) is the oldest now
    clock += 30_000;
    await call(gw);
    expect(sent).toHaveLength(4);
    expect(gw.getStats().rate_limited).toBe(2);
  });

  it("limits each API on its own; an API without an entry is not limited", async () => {
    const gw = open({ rateLimits: { coingecko: 1 } });
    await call(gw, "coingecko");
    expect(await fail(call(gw, "coingecko"))).toMatch(/rate limit reached/);
    for (let i = 0; i < 5; i++) await call(gw, "wikipedia");
    expect(sent.filter((u) => u.includes("wikipedia"))).toHaveLength(5);
  });

  it("does not count cache hits or sample (mock) answers: only calls that reach a provider", async () => {
    const gw = open({ rateLimits: { coingecko: 1, hackernews: 1 } });
    await gw.callAPI("coingecko", "/ping", { same: 1 });
    expect((await gw.callAPI("coingecko", "/ping", { same: 1 })).cached).toBe(true);
    for (let i = 0; i < 3; i++) expect((await call(gw, "hackernews")).source).toBe("mock"); // not live: nothing is sent
    expect(sent).toHaveLength(1);
    expect(gw.getStats().rate_limited).toBe(0);
  });

  it("counts a call the provider answered with an error: it reached the provider", async () => {
    const gw = open({ rateLimits: { coingecko: 1 } });
    status = 500;
    expect(await fail(call(gw))).toMatch(/^coingecko: HTTP 500/);
    status = 200;
    expect(await fail(call(gw))).toMatch(/rate limit reached/);
    expect(sent).toHaveLength(1);
  });

  it("applies to each item of aggregate_apis; a refused item holds its error and the others keep their data", async () => {
    const gw = open({ rateLimits: { coingecko: 2 } });
    const results = await gw.aggregateAPIs([0, 1, 2].map((i) => ({ id: "coingecko", endpoint: "/ping", params: { agg: i } })));
    expect(results.filter((r) => r.source === "live")).toHaveLength(2);
    expect(results.filter((r) => /rate limit reached/.test(r.error ?? ""))).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("reads GATEWAY_RATE_LIMITS: <api>=<calls per minute>, comma-separated, spaces allowed", () => {
    const before = process.env.GATEWAY_RATE_LIMITS;
    try {
      process.env.GATEWAY_RATE_LIMITS = " coingecko = 30 , wikipedia=60 ,";
      expect(gatewayOptionsFromEnv().rateLimits).toEqual({ coingecko: 30, wikipedia: 60 });
      delete process.env.GATEWAY_RATE_LIMITS;
      expect(gatewayOptionsFromEnv().rateLimits).toEqual({});
    } finally {
      if (before === undefined) delete process.env.GATEWAY_RATE_LIMITS;
      else process.env.GATEWAY_RATE_LIMITS = before;
    }
  });

  it("reports and ignores an entry it cannot read, saying that API has no limit", () => {
    const bad = ["coingecko", "coingecko=0", "coingecko=-1", "coingecko=1.5", "coingecko=abc", `coingecko=${MAX_RATE_LIMIT + 1}`, "CoinGecko=5", "=5"];
    expect(parseRateLimits([...bad, `wikipedia=${MAX_RATE_LIMIT}`].join(","))).toEqual({ wikipedia: MAX_RATE_LIMIT });
    const messages = errors.mock.calls.map((c: unknown[]) => String(c[0]));
    for (const entry of bad) {
      expect(messages).toContain(`GATEWAY_RATE_LIMITS: ignored "${entry}" (expected <api>=<calls per minute>, 1 to ${MAX_RATE_LIMIT}); that API has no limit`);
    }
  });

  it("notes an unknown API or an out-of-range limit given in code, applies the rest, and names the limits it applies", async () => {
    const gw = open({ rateLimits: { nope: 3, wikipedia: 0, coingecko: 1 } });
    const messages = errors.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(messages).toContain("GATEWAY_RATE_LIMITS names an unknown API: nope");
    expect(messages).toContain("GATEWAY_RATE_LIMITS: ignored wikipedia=0; that API has no limit");
    expect(messages).toContain("Rate limits (live calls per minute): coingecko=1; retries after a transient failure: 0");
    expect(gw.getStats().rate_limits).toEqual({ coingecko: 1 });
    await call(gw);
    expect(await fail(call(gw))).toMatch(/rate limit reached/);
  });

  it("uses a monotonic clock by default: a wall-clock jump does not free a place", async () => {
    const gw = new UniversalAPIGateway({ liveApis: ["coingecko"], rateLimits: { coingecko: 1 } });
    await call(gw);
    const realNow = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(realNow + 3_600_000); // the system clock steps an hour ahead
    expect(await fail(call(gw))).toMatch(/rate limit reached/);
  });
});
