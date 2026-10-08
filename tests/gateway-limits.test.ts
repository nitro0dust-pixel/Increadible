import {
  MAX_AGGREGATE_CALLS,
  MAX_CACHE_BYTES,
  MAX_CACHE_ENTRIES,
  MAX_LIVE_IN_FLIGHT,
  MAX_LIVE_WAITING,
  UniversalAPIGateway,
} from "../features/09-api-gateway/src/mcp-server";

/**
 * Bounds on what one caller can make the gateway hold or start (audit findings GW-1, GW-3, GW-4).
 * Before: the result cache grew with every distinct call (2 000 calls with 200 KB of params held 385 MB of heap, against a pod
 * limit of 256 MiB), and one aggregate_apis request started every call it was given at once (5 000 requested, 5 000 started
 * together). A model chooses these arguments, so the gateway must not trust their size or number.
 */

let errors: jest.SpyInstance;
beforeAll(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => errors.mockRestore());

const mock = () => new UniversalAPIGateway({ liveApis: [] });
const pad = (chars: number) => "x".repeat(chars);

describe("the result cache is bounded", () => {
  it("holds at most MAX_CACHE_ENTRIES entries and drops the oldest first", async () => {
    const gw = mock();
    for (let i = 0; i < MAX_CACHE_ENTRIES + 100; i++) await gw.callAPI("hackernews", "/x", { i });
    const stats = gw.getStats();
    expect(stats.cached_items).toBe(MAX_CACHE_ENTRIES);
    expect(stats.cache_evictions).toBe(100);
    expect((await gw.callAPI("hackernews", "/x", { i: 0 })).cached).toBe(false); // the oldest is gone
    expect((await gw.callAPI("hackernews", "/x", { i: MAX_CACHE_ENTRIES + 99 })).cached).toBe(true); // the newest is kept
  });

  it("holds at most about MAX_CACHE_BYTES of data", async () => {
    const gw = mock();
    const each = 1_000_000;
    const calls = Math.ceil((MAX_CACHE_BYTES * 2) / each); // twice what fits
    for (let i = 0; i < calls; i++) await gw.callAPI("hackernews", "/x", { i, pad: pad(each) });
    const kept = gw.getStats().cached_items;
    expect(kept).toBeGreaterThan(0);
    expect(kept * each).toBeLessThanOrEqual(MAX_CACHE_BYTES);
    expect(gw.getStats().cache_evictions).toBeGreaterThan(0);
  });

  it("returns a result larger than a quarter of the cache but does not keep it", async () => {
    const gw = mock();
    const big = { pad: pad(MAX_CACHE_BYTES / 4 + 1000) };
    const first = await gw.callAPI("hackernews", "/x", big);
    expect(first.data.data.pad).toHaveLength(big.pad.length); // the caller still gets the whole answer
    expect(gw.getStats().cached_items).toBe(0);
    expect((await gw.callAPI("hackernews", "/x", big)).cached).toBe(false);
  });

  it("keys long params by a hash, so a key never holds the params and equal params still hit", async () => {
    const gw = mock();
    const params = { pad: pad(100_000) };
    await gw.callAPI("hackernews", "/x", params);
    expect((await gw.callAPI("hackernews", "/x", { pad: pad(100_000) })).cached).toBe(true);
    expect((await gw.callAPI("hackernews", "/x", { pad: pad(99_999) })).cached).toBe(false);
    const keys = [...(gw as any).cache.keys()] as string[];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(256);
  });

  it("drops expired entries when it writes, not only when they are read again", async () => {
    let now = 1_000_000;
    const spy = jest.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const gw = mock();
      for (let i = 0; i < 10; i++) await gw.callAPI("hackernews", "/x", { i });
      expect(gw.getStats().cached_items).toBe(10);
      now += 301_000; // past the 5 minute TTL
      await gw.callAPI("hackernews", "/x", { fresh: true });
      expect(gw.getStats().cached_items).toBe(1);
      expect(gw.getStats().cache_evictions).toBe(0); // expiry is not an eviction
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the byte count honest through expiry, clearCache and re-insertion", async () => {
    let now = 1_000_000;
    const spy = jest.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const gw = mock();
      await gw.callAPI("hackernews", "/x", { a: 1 });
      expect((gw as any).cacheBytes).toBeGreaterThan(0);
      now += 301_000;
      await gw.callAPI("hackernews", "/x", { a: 1 }); // expired on read, then written again
      const afterRewrite = (gw as any).cacheBytes;
      gw.clearCache();
      expect((gw as any).cacheBytes).toBe(0);
      await gw.callAPI("hackernews", "/x", { a: 1 });
      expect((gw as any).cacheBytes).toBe(afterRewrite);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("aggregate_apis does not let one request start an unbounded number of calls", () => {
  const tool = async (input: unknown) => {
    const m = await import("../features/09-api-gateway/src/mcp-server");
    return JSON.parse(await m.processToolCall("aggregate_apis", input as any));
  };

  it("refuses more than MAX_AGGREGATE_CALLS calls, and non-array or malformed input, with plain messages", async () => {
    const tooMany = Array.from({ length: MAX_AGGREGATE_CALLS + 1 }, (_, i) => ({ id: "hackernews", endpoint: "/x", params: { i } }));
    expect((await tool({ apis: tooMany })).error).toBe(`apis may hold at most ${MAX_AGGREGATE_CALLS} calls (got ${MAX_AGGREGATE_CALLS + 1})`);
    expect((await tool({ apis: "x" })).error).toBe("apis must be an array");
    expect((await tool({ apis: null })).error).toBe("apis must be an array");
    expect((await tool({})).error).toBe("apis must be an array");
    expect((await tool({ apis: [null] })).error).toBe("apis[0] must be an object");
    expect((await tool({ apis: [{ id: "hackernews", endpoint: "/x" }, { id: 7, endpoint: "/x" }] })).error).toBe("apis[1].id must be a string");
    expect((await tool({ apis: [{ id: "hackernews" }] })).error).toBe("apis[0].endpoint must be a string");
    expect((await tool({ apis: [{ id: "hackernews", endpoint: "/x", params: [1] }] })).error).toBe("apis[0].params must be an object");
  });

  it("accepts exactly MAX_AGGREGATE_CALLS calls, and an empty list as before", async () => {
    const exact = Array.from({ length: MAX_AGGREGATE_CALLS }, (_, i) => ({ id: "hackernews", endpoint: "/x", params: { n: i } }));
    const out = await tool({ apis: exact });
    expect(out.count).toBe(MAX_AGGREGATE_CALLS);
    expect(out.error).toBeUndefined();
    expect(await tool({ apis: [] })).toEqual({ data: [], count: 0 });
  });

  it("returns what worked and says what did not, in order, instead of failing the whole request", async () => {
    const out = await tool({
      apis: [
        { id: "hackernews", endpoint: "/a" },
        { id: "no-such-api", endpoint: "/x" },
        { id: "hackernews", endpoint: "/b" },
      ],
    });
    expect(out.count).toBe(3);
    expect(out.failed).toBe(1);
    expect(out.error).toBeUndefined(); // part of it worked, so this is not an error result
    expect(out.data[0].source).toBe("mock");
    expect(out.data[1]).toEqual({ error: "API not found: no-such-api" });
    expect(out.data[2].source).toBe("mock");
  });

  it("is an error result only when every call failed, and still carries the data", async () => {
    const out = await tool({ apis: [{ id: "no-such-api", endpoint: "/x" }, { id: "also-missing", endpoint: "/y" }] });
    expect(out.error).toBe("all 2 calls failed");
    expect(out.failed).toBe(2);
    expect(out.data).toHaveLength(2);
  });
});

describe("live calls are bounded across the whole gateway", () => {
  let fetchSpy: jest.SpyInstance;
  let inFlight: number;
  let peak: number;
  let started: number;
  let release: Array<() => void>;

  beforeEach(() => {
    inFlight = 0;
    peak = 0;
    started = 0;
    release = [];
    // fetch is replaced: no network is touched. Each call stays "in flight" until the test lets it finish.
    fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async () => {
      started++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as any);
  });
  afterEach(() => fetchSpy.mockRestore());

  const live = () => new UniversalAPIGateway({ liveApis: "*", env: {} });
  const settle = async () => {
    // let queued calls start, finish them in waves until none is left
    for (let guard = 0; guard < 500; guard++) {
      await new Promise((r) => setImmediate(r));
      if (release.length === 0 && inFlight === 0) return;
      release.splice(0).forEach((fn) => fn());
    }
  };

  it("never has more than MAX_LIVE_IN_FLIGHT outbound calls at once, however many callers ask", async () => {
    const gw = live();
    const calls = Array.from({ length: 60 }, (_, i) => gw.callAPI("hackernews", "/item", { i }));
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(MAX_LIVE_IN_FLIGHT); // the rest wait for a slot
    await settle();
    const results = await Promise.all(calls);
    expect(results).toHaveLength(60);
    expect(peak).toBeLessThanOrEqual(MAX_LIVE_IN_FLIGHT);
    expect(started).toBe(60); // all of them were served in the end
  });

  it("does not free a slot twice when it is handed to a waiting call (new callers must still queue)", async () => {
    const gw = live();
    const flush = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };
    const first = Array.from({ length: 25 }, (_, i) => gw.callAPI("hackernews", "/item", { i }));
    await flush();
    expect(started).toBe(MAX_LIVE_IN_FLIGHT);
    // Finish five of the ten running calls one at a time: each one hands its slot to a waiting call.
    for (let i = 0; i < 5; i++) {
      release.shift()!();
      await flush();
    }
    expect(inFlight).toBe(MAX_LIVE_IN_FLIGHT);
    // Calls that arrive now find every slot taken and must wait; a miscount would let them straight through.
    const late = Array.from({ length: 10 }, (_, i) => gw.callAPI("hackernews", "/item", { late: i }));
    await flush();
    expect(inFlight).toBe(MAX_LIVE_IN_FLIGHT);
    expect(peak).toBe(MAX_LIVE_IN_FLIGHT);
    await settle();
    expect(await Promise.all([...first, ...late])).toHaveLength(35);
    expect(peak).toBe(MAX_LIVE_IN_FLIGHT);
  });

  it("refuses a new live call at once when MAX_LIVE_WAITING are already waiting, and recovers afterwards", async () => {
    const gw = live();
    const total = MAX_LIVE_IN_FLIGHT + MAX_LIVE_WAITING + 1;
    const calls = Array.from({ length: total }, (_, i) => gw.callAPI("hackernews", "/item", { i }).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, message: String(e.message) })
    ));
    await new Promise((r) => setImmediate(r));
    await settle();
    const outcomes = await Promise.all(calls);
    const refused = outcomes.filter((o) => !o.ok) as Array<{ ok: false; message: string }>;
    expect(refused).toHaveLength(1);
    expect(refused[0].message).toBe("hackernews: the gateway is busy: too many live calls are waiting");
    expect(peak).toBeLessThanOrEqual(MAX_LIVE_IN_FLIGHT);
    // The slots are all free again: a new call is served.
    const again = gw.callAPI("hackernews", "/item", { i: "after" });
    await new Promise((r) => setImmediate(r));
    await settle();
    expect((await again).source).toBe("live");
  });

  it("frees the slot when a live call fails, so failures cannot use up the limit", async () => {
    fetchSpy.mockImplementation((async () => {
      started++;
      throw new Error("boom");
    }) as any);
    const gw = live();
    for (let i = 0; i < MAX_LIVE_IN_FLIGHT * 3; i++) {
      await expect(gw.callAPI("hackernews", "/item", { i })).rejects.toThrow("hackernews:");
    }
    expect(started).toBe(MAX_LIVE_IN_FLIGHT * 3); // the 30th call still went out: no slot leaked
  });

  it("starts at most 5 calls of one aggregate at a time", async () => {
    const gw = live();
    const pending = gw.aggregateAPIs(Array.from({ length: 40 }, (_, i) => ({ id: "hackernews", endpoint: "/item", params: { i } })));
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(5);
    await settle();
    const out = await pending;
    expect(out).toHaveLength(40);
    expect(out.every((r) => r.source === "live")).toBe(true);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

describe("call_api checks the type of its arguments", () => {
  const tool = async (input: unknown) => {
    const m = await import("../features/09-api-gateway/src/mcp-server");
    return JSON.parse(await m.processToolCall("call_api", input as any));
  };

  it("answers a wrong type with a plain message", async () => {
    expect((await tool({})).error).toBe("api_id must be a string");
    expect((await tool({ api_id: 5, endpoint: "/x" })).error).toBe("api_id must be a string");
    expect((await tool({ api_id: "hackernews" })).error).toBe("endpoint must be a string");
    expect((await tool({ api_id: "hackernews", endpoint: "/x", params: "q=1" })).error).toBe("params must be an object");
    expect((await tool({ api_id: "hackernews", endpoint: "/x", params: [1] })).error).toBe("params must be an object");
  });

  it("still serves a correct call, with or without params", async () => {
    expect((await tool({ api_id: "hackernews", endpoint: "/x" })).source).toBe("mock");
    expect((await tool({ api_id: "hackernews", endpoint: "/x", params: null })).source).toBe("mock");
    expect((await tool({ api_id: "hackernews", endpoint: "/x", params: { q: 1 } })).source).toBe("mock");
  });
});
