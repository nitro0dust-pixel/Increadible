/**
 * How live calls behave when a provider pushes back (owner's instruction of 2026-10-12): bounded retries after a transient failure,
 * HTTP 429 and Retry-After honoured with a cooldown, a conservative default rate limit, and Wikimedia's User-Agent rule (a contact
 * is required: a warning in development, a refusal in production). The network is a mocked `fetch`; the clock and the waits are
 * fake, so every boundary is exact and no test sleeps.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  UniversalAPIGateway,
  GatewayOptions,
  COOLDOWN_AFTER_429_MS,
  RETRY_BASE_MS,
  USER_AGENT_PRODUCT,
  hasContact,
  isValidContact,
  isWikimediaUrl,
} from "../features/09-api-gateway/src/mcp-server";
import { MAX_RETRY_AFTER_MS, liveGet, parseRetryAfter } from "../features/09-api-gateway/src/live";

/** What the mocked provider answers next: a status with headers, or a thrown network error. Past the end, 200. */
type Answer = { status: number; headers?: Record<string, string> } | { networkError: string } | { timeout: true };
let script: Answer[] = [];
let sent: Array<{ url: string; userAgent: string }> = [];
let clock = 0;
let slept: number[] = [];
let errors: ReturnType<typeof jest.spyOn>;

const open = (options: GatewayOptions = {}) =>
  new UniversalAPIGateway({
    liveApis: ["coingecko", "wikipedia", "wikidata", "hackernews"],
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    ...options,
  });
let n = 0;
/** A distinct call each time, so the result cache never answers it. */
const call = (gw: UniversalAPIGateway, id = "coingecko") => gw.callAPI(id, "/", { n: n++ });
const fail = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e: any) {
    return String(e.message);
  }
  throw new Error("expected the call to fail");
};
const messages = (): string[] => errors.mock.calls.map((c: unknown[]) => String(c[0]));

beforeEach(() => {
  script = [];
  sent = [];
  slept = [];
  clock = 5_000_000;
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: any) => {
    sent.push({ url: String(input), userAgent: init.headers["User-Agent"] });
    const next = script.shift() ?? { status: 200 };
    if ("networkError" in next) throw Object.assign(new TypeError("fetch failed"), { cause: { code: next.networkError } });
    if ("timeout" in next) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const ok = next.status < 400;
    return new Response(JSON.stringify(ok ? { ok: true } : { error: "x" }), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("Retry-After (parseRetryAfter)", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  it("reads delay-seconds and HTTP dates, gives 0 for a past date, caps at a day, and ignores anything else", () => {
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 120 ", now)).toBe(120_000);
    expect(parseRetryAfter("Mon, 12 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Mon, 12 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("9999999999", now)).toBe(MAX_RETRY_AFTER_MS);
    for (const bad of [null, undefined, "", "soon", "-5", "1.5", "12 Oct 2026", "Mon, 12 Oct 2026 12:00:30 UTC"]) expect(parseRetryAfter(bad, now)).toBeUndefined();
  });

  it("is reported by liveGet with the status and whether the failure is transient", async () => {
    const options = { timeoutMs: 1000, maxResponseBytes: 10_000, userAgent: "t" };
    const hint = async () => {
      try {
        await liveGet(new URL("https://example.org/x"), {}, options, []);
      } catch (e: any) {
        return e.hint;
      }
      return undefined;
    };
    script = [{ status: 429, headers: { "retry-after": "7" } }, { status: 404 }, { status: 503 }, { networkError: "ECONNRESET" }, { networkError: "ECONNREFUSED" }, { timeout: true }];
    expect(await hint()).toEqual({ status: 429, retryAfterMs: 7000, retryable: true });
    expect(await hint()).toEqual({ status: 404, retryAfterMs: undefined, retryable: false });
    expect(await hint()).toEqual({ status: 503, retryAfterMs: undefined, retryable: true });
    expect(await hint()).toEqual({ retryable: true });
    expect(await hint()).toEqual({ retryable: false });
    expect(await hint()).toEqual({}); // a timeout is never retried: it would double the worst case
  });
});

describe("bounded retries after a transient failure", () => {
  it("retries a 503 once (the default from the environment is 1) and returns the success, counting both sends", async () => {
    const gw = open({ retries: 1 });
    script = [{ status: 503 }];
    expect(await call(gw)).toMatchObject({ source: "live", data: { ok: true } });
    expect(sent).toHaveLength(2);
    expect(slept).toEqual([RETRY_BASE_MS]);
    expect(gw.getStats()).toMatchObject({ retries: 1, live_calls: 2, successful: 1, failed: 0, max_retries: 1 });
  });

  it("stops after the last retry and returns the provider's error", async () => {
    const gw = open({ retries: 2 });
    script = [{ status: 502 }, { status: 504 }, { status: 503 }];
    expect(await fail(call(gw))).toMatch(/^coingecko: HTTP 503/);
    expect(sent).toHaveLength(3);
    expect(slept).toEqual([RETRY_BASE_MS, 2 * RETRY_BASE_MS]);
  });

  it("does not retry a client error, a refused connection, a timeout, or anything when retries is 0", async () => {
    const gw = open({ retries: 3 });
    for (const answer of [{ status: 404 }, { status: 400 }, { networkError: "ECONNREFUSED" }, { timeout: true }] as Answer[]) {
      script = [answer];
      await fail(call(gw));
    }
    expect(sent).toHaveLength(4);
    const none = open({ retries: 0 });
    script = [{ status: 503 }];
    await fail(call(none));
    expect(sent).toHaveLength(5);
    expect(slept).toEqual([]);
  });

  it("retries a dropped connection", async () => {
    const gw = open({ retries: 1 });
    script = [{ networkError: "ECONNRESET" }];
    expect(await call(gw)).toMatchObject({ source: "live" });
    expect(sent).toHaveLength(2);
  });

  it("counts a retry against the rate limit like any call, so a used-up limit stops it", async () => {
    const gw = open({ retries: 1, rateLimits: { coingecko: 1 } });
    script = [{ status: 503 }];
    expect(await fail(call(gw))).toMatch(/rate limit reached/);
    expect(sent).toHaveLength(1);
  });
});

describe("HTTP 429 and Retry-After", () => {
  it("waits the Retry-After when it is within the longest wait, then retries once the cooldown is over", async () => {
    const gw = open({ retries: 1, retryMaxWaitMs: 5000 });
    script = [{ status: 429, headers: { "retry-after": "2" } }];
    expect(await call(gw)).toMatchObject({ source: "live" });
    expect(slept).toEqual([2000]);
    expect(gw.getStats()).toMatchObject({ throttled: 1, retries: 1, cooldowns: {} });
  });

  it("waits out what is left of the cooldown when the timer fires early, instead of refusing its own retry", async () => {
    const gw = open({
      retries: 1,
      sleep: async (ms) => {
        slept.push(ms);
        clock += slept.length === 1 ? ms - 1 : ms; // the first timer fires a millisecond early
      },
    });
    script = [{ status: 429, headers: { "retry-after": "2" } }];
    expect(await call(gw)).toMatchObject({ source: "live" });
    expect(slept).toEqual([2000, 1]);
    expect(sent).toHaveLength(2);
  });

  it("does not wait a Retry-After longer than allowed: returns the error, and refuses calls to that API until it has passed", async () => {
    const gw = open({ retries: 1, retryMaxWaitMs: 5000 });
    script = [{ status: 429, headers: { "retry-after": "30" } }];
    expect(await fail(call(gw))).toMatch(/^coingecko: HTTP 429 \(retry after 30\)/);
    expect(sent).toHaveLength(1);
    expect(gw.getStats().cooldowns).toEqual({ coingecko: 30 });
    clock += 10_000;
    expect(await fail(call(gw))).toBe("coingecko: the provider asked the gateway to slow down (HTTP 429 or 503); no live calls to this API for another 20 s");
    expect(sent).toHaveLength(1); // refused before any request left
    expect(await call(gw, "hackernews")).toMatchObject({ source: "live" }); // other APIs are not held
    clock += 20_000;
    expect(await call(gw)).toMatchObject({ source: "live" });
    expect(gw.getStats()).toMatchObject({ cooldown_refused: 1, throttled: 1, cooldowns: {} });
  });

  it("after a 429 without Retry-After, backs off for a whole window and does not retry", async () => {
    const gw = open({ retries: 3 });
    script = [{ status: 429 }];
    expect(await fail(call(gw))).toMatch(/^coingecko: HTTP 429/);
    expect(sent).toHaveLength(1);
    expect(gw.getStats().cooldowns).toEqual({ coingecko: COOLDOWN_AFTER_429_MS / 1000 });
    clock += COOLDOWN_AFTER_429_MS - 1;
    await fail(call(gw));
    clock += 1;
    expect(await call(gw)).toMatchObject({ source: "live" });
  });

  it("treats a 503 with a Retry-After as a request to wait, too", async () => {
    const gw = open({ retries: 0 });
    script = [{ status: 503, headers: { "retry-after": "Mon, 12 Oct 2099 12:00:00 GMT" } }];
    await fail(call(gw));
    expect(gw.getStats()).toMatchObject({ throttled: 1, cooldowns: { coingecko: MAX_RETRY_AFTER_MS / 1000 } });
  });
});

describe("the default rate limit (GATEWAY_DEFAULT_RATE_LIMIT)", () => {
  it("limits every API without its own entry, says which setting refused, and lets an API's own entry win", async () => {
    const gw = open({ defaultRateLimit: 2, rateLimits: { hackernews: 3 } });
    await call(gw);
    await call(gw);
    expect(await fail(call(gw))).toBe("coingecko: rate limit reached: at most 2 live calls per minute to this API (GATEWAY_DEFAULT_RATE_LIMIT); try again in 60 s");
    for (let i = 0; i < 3; i++) await call(gw, "hackernews");
    expect(await fail(call(gw, "hackernews"))).toMatch(/at most 3 .*\(GATEWAY_RATE_LIMITS\)/);
    expect(gw.getStats()).toMatchObject({ default_rate_limit: 2, rate_limits: { hackernews: 3 } });
    expect(messages()).toContain("Rate limits (live calls per minute): 2 per API unless named, hackernews=3; retries after a transient failure: 0");
  });

  it("is off when not given (or 0), so an options object gets exactly what it says", async () => {
    for (const gw of [open(), open({ defaultRateLimit: 0 })]) {
      for (let i = 0; i < 10; i++) await call(gw);
      expect(gw.getStats().default_rate_limit).toBeNull();
    }
  });
});

describe("Wikimedia's User-Agent rule", () => {
  const withContact = `${USER_AGENT_PRODUCT} (ops@example.org)`;

  it("knows Wikimedia's hosts and nothing else", () => {
    for (const u of ["https://en.wikipedia.org/w/api.php", "https://www.wikidata.org/w/api.php", "https://commons.wikimedia.org/x", "https://www.mediawiki.org/"]) expect(isWikimediaUrl(u)).toBe(true);
    for (const u of ["https://api.coingecko.com/api/v3", "https://wikipedia.org.example.com/", "https://notwikipedia.org/", "not a url"]) expect(isWikimediaUrl(u)).toBe(false);
  });

  it("finds a contact (an email address or an http(s) URL) and nothing that only looks like one", () => {
    for (const ua of [withContact, "x/1 (https://example.org/about)", "x/1 (+https://example.org)", "bot/2 (mailto ops@example.org; x)"]) expect(hasContact(ua)).toBe(true);
    for (const ua of [USER_AGENT_PRODUCT, "increadible-gateway", "x/1 (me)", "x/1 (ops@localhost)", "x/1 (ftp://example.org)"]) expect(hasContact(ua)).toBe(false);
    expect(isValidContact("https://user:pw@example.org/")).toBe(false);
  });

  it("in production, refuses a Wikimedia call without a contact before anything is sent, and says how to fix it", async () => {
    const gw = open({ production: true, userAgent: USER_AGENT_PRODUCT });
    expect(await fail(call(gw, "wikipedia"))).toBe("wikipedia: not sent: Wikimedia requires a User-Agent with contact information; set GATEWAY_CONTACT to an email address or URL");
    expect(await fail(call(gw, "wikidata"))).toMatch(/not sent: Wikimedia requires/);
    expect(sent).toHaveLength(0);
    expect(await call(gw, "hackernews")).toMatchObject({ source: "live" }); // the rule is Wikimedia's, not everyone's
    expect(gw.getStats()).toMatchObject({ contact_refused: 2, user_agent_has_contact: false });
    expect(messages()).toContain("wikipedia: live calls are refused until the User-Agent carries contact information (set GATEWAY_CONTACT to an email address or URL): Wikimedia requires it");
  });

  it("in development, sends it with a start-up warning; with a contact, sends it in production without a word", async () => {
    const dev = open({ production: false, userAgent: USER_AGENT_PRODUCT });
    expect(await call(dev, "wikipedia")).toMatchObject({ source: "live" });
    expect(messages()).toContain(
      "warning: wikipedia: live calls are sent without contact information in the User-Agent, which Wikimedia's policy requires; set GATEWAY_CONTACT to an email address or URL (in production these calls are refused)"
    );
    errors.mockClear();
    const prod = open({ production: true, userAgent: withContact });
    expect(await call(prod, "wikipedia")).toMatchObject({ source: "live" });
    expect(sent.map((s) => s.userAgent)).toEqual([USER_AGENT_PRODUCT, withContact]);
    expect(messages().filter((m) => /Wikimedia/.test(m))).toEqual([]);
  });

  it("says nothing about Wikimedia when no Wikimedia API is live", () => {
    open({ liveApis: ["coingecko"], production: true, userAgent: USER_AGENT_PRODUCT });
    expect(messages().filter((m) => /Wikimedia/.test(m))).toEqual([]);
  });
});
