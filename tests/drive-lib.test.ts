import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

/**
 * scripts/drive-lib.js, the shared part of the request drivers (docs/DRIVERS.md): scenario files, the matchers, the runner, the
 * redaction of secrets, the stdio and HTTP clients and the way a server is ended. The clients are tried against small fake servers so
 * that the failure paths (no answer, a crash, stray output, a server that ignores every polite goodbye) can be made to happen. The real
 * server behind the drivers is in tests/drive.test.ts.
 */
const lib = require("../scripts/drive-lib.js");
const root = path.join(__dirname, "..");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("scenario files", () => {
  const minimal = { name: "s", steps: [{ name: "a", method: "ping" }] };

  it("every shipped scenario is valid, and its step names are unique", () => {
    const names = lib.listScenarios();
    expect(names).toContain("basic");
    for (const name of names) expect(lib.loadScenario(name).steps.length).toBeGreaterThan(0);
  });

  it("refuses a scenario that would silently check nothing (each breakage is reported, with the step it is in)", () => {
    const cases: Array<[string, (s: any) => void, RegExp]> = [
      ["no name", (s) => delete s.name, /"name" is required/],
      ["no steps", (s) => (s.steps = []), /non-empty array/],
      ["a step without a name", (s) => delete s.steps[0].name, /step 1: "name" is required/],
      ["a step name used twice", (s) => s.steps.push({ name: "a", method: "ping" }), /used twice/],
      ["neither method nor tool", (s) => delete s.steps[0].method, /exactly one of "method" and "tool"/],
      ["both method and tool", (s) => (s.steps[0].tool = "x"), /exactly one of "method" and "tool"/],
      ["a misspelled step key", (s) => (s.steps[0].argumnets = {}), /unknown key "argumnets"/],
      ["a misspelled expectation", (s) => (s.steps[0].expect = { tool_eror: true }), /unknown expectation "tool_eror"/],
      ["writes that is not a boolean", (s) => (s.steps[0].writes = "yes"), /"writes" must be true or false/],
      ["an unknown matcher", (s) => (s.steps[0].expect = { json: { a: { $gt: 1 } } }), /unknown matcher in json\.a/],
    ];
    for (const [what, mutate, message] of cases) {
      const scenario = clone(minimal);
      mutate(scenario);
      expect({ what, error: (() => { try { lib.validateScenario(scenario, "t.json"); return ""; } catch (e) { return (e as Error).message; } })() }).toEqual({ what, error: expect.stringMatching(message) });
    }
    expect(() => lib.validateScenario(clone(minimal))).not.toThrow();
  });

  it("names the file when it is not found, and lists what exists", () => {
    expect(() => lib.loadScenario("no-such-scenario")).toThrow(/no scenario "no-such-scenario"/);
  });
});

describe("matchValue, getPath and substitute", () => {
  it("compares a literal by value and applies each matcher", () => {
    const ok = (actual: unknown, wanted: unknown) => lib.matchValue(actual, wanted) === null;
    expect(ok({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(ok({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(ok("x", { $type: "string" })).toBe(true);
    expect(ok([], { $type: "array" })).toBe(true);
    expect(ok(null, { $type: "null" })).toBe(true);
    expect(ok(3, { $type: "string" })).toBe(false);
    expect(ok(5, { $gte: 5 })).toBe(true);
    expect(ok(4, { $gte: 5 })).toBe(false);
    expect(ok("4", { $gte: 3 })).toBe(false); // a string is not a number
    expect(ok(5, { $lte: 5 })).toBe(true);
    expect(ok(["a", "b"], { $includes: "b" })).toBe(true);
    expect(ok("abc", { $includes: "bc" })).toBe(true);
    expect(ok(["a"], { $includes: "z" })).toBe(false);
    expect(ok("B", { $matches: "^(A|B)$" })).toBe(true);
    expect(ok("C", { $matches: "^(A|B)$" })).toBe(false);
    expect(ok(undefined, { $exists: false })).toBe(true);
    expect(ok(0, { $exists: true })).toBe(true);
    expect(ok(undefined, { $exists: true })).toBe(false); // a missing value does not satisfy $exists: true
    expect(ok(0, { $exists: false })).toBe(false); // and a present falsy one does not satisfy $exists: false
    expect(ok(5, { $gte: 1, $lte: 3 })).toBe(false); // every matcher in the object must hold
  });

  it("says what it expected and what it got", () => {
    expect(lib.matchValue(2, 3)).toBe("expected 3, got 2");
    expect(lib.matchValue(2, { $gte: 3 })).toBe("expected $gte 3, got 2");
  });

  it("reads dotted paths through objects and arrays, and returns undefined for a path that is not there", () => {
    const value = { a: { b: [{ c: 7 }] } };
    expect(lib.getPath(value, "a.b.0.c")).toBe(7);
    expect(lib.getPath(value, "a.x.0.c")).toBeUndefined();
    expect(lib.getPath(null, "a")).toBeUndefined();
    expect(lib.getPath([{ id: "h" }], "0.id")).toBe("h");
  });

  it("substitutes ${name} in strings at any depth; a whole-string variable keeps its type; an unknown variable is an error", () => {
    const vars = { run: "r1", n: 5, list: [1] };
    expect(lib.substitute({ id: "drive-${run}", n: "${n}", deep: [{ x: "${list}" }], text: "n=${n}" }, vars)).toEqual({ id: "drive-r1", n: 5, deep: [{ x: [1] }], text: "n=5" });
    expect(() => lib.substitute("${missing}", vars)).toThrow(/unknown variable \$\{missing\}/);
    expect(() => lib.substitute("a ${missing} b", vars)).toThrow(/unknown variable/);
    expect(lib.substitute(7, vars)).toBe(7);
  });
});

describe("runScenario", () => {
  const text = (value: unknown, isError = false) => ({ result: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError } });
  /** A client that answers from a table: "tools/call:NAME" or the method. Records the calls it got. */
  const fake = (answers: Record<string, unknown>) => {
    const calls: Array<{ method: string; params: any }> = [];
    return { calls, rpc: async (method: string, params: any) => { calls.push({ method, params }); const key = method === "tools/call" ? `tools/call:${params.name}` : method; if (!(key in answers)) throw new Error(`no answer scripted for ${key}`); return answers[key]; } };
  };
  const run = (client: any, steps: any[], options: any = {}) => lib.runScenario(client, lib.validateScenario({ name: "t", steps }), options);

  it("passes a tool answer that matches, and reports each mismatch with its path", async () => {
    const client = fake({ "tools/call:t": text({ a: 1, b: "x" }) });
    const good = await run(client, [{ name: "s", tool: "t", expect: { json: { a: 1, b: { $type: "string" } } } }]);
    expect(good.ok).toBe(true);
    const bad = await run(client, [{ name: "s", tool: "t", expect: { json: { a: 2, b: { $type: "number" } } } }]);
    expect(bad.ok).toBe(false);
    expect(bad.steps[0].problems).toEqual(["json.a: expected 2, got 1", 'json.b: expected $type "number", got "x"']);
  });

  it("holds a tool error to the expectation both ways: an unexpected error fails, an expected one that does not come fails", async () => {
    const client = fake({ "tools/call:fails": text({ error: "boom" }, true), "tools/call:works": text({}) });
    expect((await run(client, [{ name: "s", tool: "fails" }])).steps[0].problems[0]).toMatch(/unexpected tool error: .*boom/);
    expect((await run(client, [{ name: "s", tool: "works", expect: { tool_error: true } }])).steps[0].problems[0]).toMatch(/expected a tool error/);
    expect((await run(client, [{ name: "s", tool: "fails", expect: { tool_error: true, contains: "boom" } }])).ok).toBe(true);
    expect((await run(client, [{ name: "s", tool: "fails", expect: { tool_error: true, contains: "other" } }])).steps[0].problems[0]).toMatch(/does not contain "other"/);
  });

  it("holds a JSON-RPC error to its code, and a result where an error was expected fails", async () => {
    const client = fake({ bad: { error: { code: -32601, message: "Method not found: bad" } }, fine: { result: {} } });
    expect((await run(client, [{ name: "s", method: "bad", expect: { rpc_error: -32601, message_contains: "not found" } }])).ok).toBe(true);
    expect((await run(client, [{ name: "s", method: "bad", expect: { rpc_error: -32602 } }])).steps[0].problems[0]).toMatch(/expected JSON-RPC error -32602, got -32601/);
    expect((await run(client, [{ name: "s", method: "bad" }])).steps[0].problems[0]).toMatch(/unexpected JSON-RPC error -32601/);
    expect((await run(client, [{ name: "s", method: "fine", expect: { rpc_error: -32601 } }])).steps[0].problems[0]).toMatch(/got a result/);
  });

  it("holds the raw result of a method step to its result expectations, by path", async () => {
    const client = fake({ ping: { result: { a: { b: 2 } } } });
    expect((await run(client, [{ name: "s", method: "ping", expect: { result: { "a.b": 2, a: { $type: "object" } } } }])).ok).toBe(true);
    expect((await run(client, [{ name: "s", method: "ping", expect: { result: { "a.b": 3 } } }])).steps[0].problems).toEqual(["result.a.b: expected 3, got 2"]);
  });

  it("checks tools_include against tools/list", async () => {
    const client = fake({ "tools/list": { result: { tools: [{ name: "a" }, { name: "b" }] } } });
    expect((await run(client, [{ name: "s", method: "tools/list", expect: { tools_include: ["a", "b"] } }])).ok).toBe(true);
    expect((await run(client, [{ name: "s", method: "tools/list", expect: { tools_include: ["a", "c"] } }])).steps[0].problems).toEqual(["tools/list lacks: c"]);
  });

  it("carries a saved value into later steps, in arguments and in expectations; a step that needs a value nobody saved fails", async () => {
    const client = fake({ "tools/call:first": text({ id: "V" }), "tools/call:second": text({ got: "V" }) });
    const result = await run(client, [
      { name: "one", tool: "first", save: { v: "id" } },
      { name: "two", tool: "second", arguments: { variant: "${v}", run: "${run_id}" }, expect: { json: { got: "${v}" } } },
    ], { vars: { run_id: "R9" } });
    expect(result.ok).toBe(true);
    expect(client.calls[1].params.arguments).toEqual({ variant: "V", run: "R9" });
    const orphan = await run(client, [{ name: "two", tool: "second", arguments: { variant: "${v}" } }]);
    expect(orphan.steps[0].problems[0]).toMatch(/unknown variable \$\{v\}/);
    const nothing = await run(client, [{ name: "one", tool: "first", save: { v: "no.such.path" } }]);
    expect(nothing.steps[0].problems[0]).toMatch(/save v: nothing at no\.such\.path/);
  });

  it("skips the steps that write when asked to, without calling the server for them", async () => {
    const client = fake({ "tools/call:read": text({}), "tools/call:write": text({}) });
    const result = await run(client, [{ name: "r", tool: "read" }, { name: "w", tool: "write", writes: true }], { skipWrites: true });
    expect(result.steps.map((s: any) => [s.name, s.ok, !!s.skipped])).toEqual([["r", true, false], ["w", true, true]]);
    expect(client.calls.map((c) => c.params.name)).toEqual(["read"]);
  });

  it("turns an exception of the client into a failed step instead of stopping the run, and hides secrets in it", async () => {
    const client = fake({ "tools/call:ok": text({}) });
    const result = await run(client, [{ name: "a", tool: "missing" }, { name: "b", tool: "ok" }], { secrets: ["scripted"] });
    expect(result.steps.map((s: any) => s.ok)).toEqual([false, true]);
    expect(result.steps[0].problems[0]).toBe("no answer <hidden> for tools/call:missing");
  });

  it("does not parse a tool answer that is not JSON when only the text is checked, and reports it when JSON is needed", async () => {
    const client = fake({ "tools/call:plain": text("just words") });
    expect((await run(client, [{ name: "s", tool: "plain", expect: { contains: "words" } }])).ok).toBe(true);
    expect((await run(client, [{ name: "s", tool: "plain", expect: { json: { a: 1 } } }])).steps[0].problems[0]).toMatch(/tool text is not JSON: just words/);
  });
});

describe("secrets", () => {
  it("prints the name of a variable and its value only where the value is not sensitive", () => {
    const env = { PORT: "3000", AUTH_TOKEN: "super-secret-token", GATEWAY_KEY_ALPHA: "k-123456", RULES_FILE: "/data/rules.yaml", HOST: "127.0.0.1" };
    const shown = lib.describeEnv(env).join(" | ");
    expect(shown).toContain("PORT=3000");
    expect(shown).toContain("HOST=127.0.0.1");
    expect(shown).toContain("AUTH_TOKEN (set)");
    expect(shown).toContain("GATEWAY_KEY_ALPHA (set)");
    expect(shown).toContain("RULES_FILE (set)");
    expect(shown).not.toContain("super-secret-token");
    expect(shown).not.toContain("k-123456");
  });

  it("collects the values of secret-looking variables (not the short ones) and hides them in any text", () => {
    const secrets = lib.secretValues({ AUTH_TOKEN: "super-secret-token", GATEWAY_KEY_A: "ab", PORT: "3000", API_PASSWORD: "hunter22" }, ["extra-value"]);
    expect(secrets.sort()).toEqual(["extra-value", "hunter22", "super-secret-token"]);
    expect(lib.redact("Bearer super-secret-token and hunter22 twice hunter22", secrets)).toBe("Bearer <hidden> and <hidden> twice <hidden>");
  });

  it("hands a child only the variables it needs (nothing else of the caller's environment)", () => {
    process.env.DRIVE_TEST_LEAK = "leaky-value";
    try {
      const env = lib.baseEnv({ A: "1" });
      expect(env.A).toBe("1");
      expect(env.PATH).toBe(process.env.PATH);
      expect(Object.keys(env)).not.toContain("DRIVE_TEST_LEAK");
      expect(JSON.stringify(env)).not.toContain("leaky-value");
    } finally {
      delete process.env.DRIVE_TEST_LEAK;
    }
  });
});

describe("command line helpers", () => {
  it("parses values, flags and repeated options, and refuses an unknown option or a missing value", () => {
    const spec = { string: ["scenario", "env"], boolean: ["json"], repeat: ["env"] };
    expect(lib.parseArgs(["--scenario", "basic", "--json", "--env", "A=1", "--env", "B=2", "rest"], spec)).toEqual({ _: ["rest"], scenario: "basic", json: true, env: ["A=1", "B=2"] });
    expect(() => lib.parseArgs(["--nope"], spec)).toThrow(/unknown option --nope/);
    expect(() => lib.parseArgs(["--scenario"], spec)).toThrow(/--scenario needs a value/);
    expect(() => lib.parseArgs(["--nope"], spec)).toThrow(lib.UsageError);
  });

  it("splits NAME=VALUE at the first = only, and checks the name without echoing the value", () => {
    expect(lib.parseEnvPairs(["A=1", "B=x=y", "C="])).toEqual({ A: "1", B: "x=y", C: "" });
    let message = "";
    try { lib.parseEnvPairs(["1BAD=secret-value"]); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/expects NAME=VALUE, got "1BAD"/);
    expect(message).not.toContain("secret-value");
  });
});

describe("work directories", () => {
  it("makes a directory with the driver's prefix, and removes only such a directory", () => {
    const dir = lib.makeWorkdir();
    expect(path.basename(dir).startsWith(lib.WORKDIR_PREFIX)).toBe(true);
    fs.writeFileSync(path.join(dir, "f"), "x");
    lib.removeWorkdir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-drive-dir-"));
    try {
      expect(() => lib.removeWorkdir(other)).toThrow(/refusing to remove a directory this driver did not create/);
      expect(() => lib.removeWorkdir(root)).toThrow(/refusing/);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("names the missing build when the server's entry point is not there", () => {
    expect(() => lib.entryPoint(os.tmpdir(), "main.js")).toThrow(/does not exist: run "npm run build"/);
  });
});

describe("formatReport", () => {
  it("prints PASS, FAIL, SKIP and KNOWN with the problems and the verdict, counting what ran", () => {
    const step = (name: string, extra: object) => ({ name, ok: true, ms: 3, summary: "ok", problems: [], ...extra });
    const results = [{ scenario: "s", ok: false, steps: [step("a", {}), step("b", { ok: false, problems: ["it broke"] }), step("c", { skipped: true }), step("d", { status: "KNOWN", notes: ["a note"] })] }];
    const text: string = lib.formatReport({ driver: "x", target: "t", results, notes: ["n1"] });
    expect(text).toMatch(/1\s+a\s+PASS/);
    expect(text).toMatch(/2\s+b\s+FAIL/);
    expect(text).toContain("- it broke");
    expect(text).toMatch(/3\s+c\s+SKIP/);
    expect(text).toMatch(/4\s+d\s+KNOWN/);
    expect(text).toContain(". a note");
    expect(text).toContain("FAIL 1 of 3 steps (1 skipped: they write data) (1 KNOWN");
    const passing = lib.formatReport({ driver: "x", target: "t", results: [{ scenario: "s", ok: true, steps: [step("a", {})] }] });
    expect(passing).toContain("PASS 1/1");
  });
});

describe("the stdio client against fake servers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-fake-"));
  const server = path.join(dir, "fake.js");
  const open: any[] = [];
  beforeAll(() => {
    fs.writeFileSync(server, `
      const mode = process.env.FAKE_MODE || "ok";
      if (mode === "garbage") console.log("hello, this is not json");
      if (mode === "stubborn") { process.on("SIGTERM", () => {}); process.stdin.on("end", () => {}); setInterval(() => {}, 1000); }
      const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => {
        buf += d; let i;
        while ((i = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (mode === "silent") continue;
          if (mode === "crash") process.exit(7);
          if (m.id === undefined) continue;
          if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "x", capabilities: { tools: {} }, serverInfo: { name: "increadible", version: "0.0.0" } } });
          else send({ jsonrpc: "2.0", id: m.id, result: {} });
        }
      });
      if (mode !== "stubborn") process.stdin.on("end", () => process.exit(0));
    `);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) await c.proc.stop({ stdinFirst: false, graceMs: 100 });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = (mode: string, extra: object = {}) => {
    const c = new lib.StdioClient({ args: [server], env: lib.baseEnv({ FAKE_MODE: mode }), requestTimeoutMs: 400, ...extra });
    open.push(c);
    return c;
  };

  it("matches answers to requests by id, performs the handshake and leaves on stdin close with code 0", async () => {
    const c = client("ok");
    expect((await c.initialize()).serverInfo.name).toBe("increadible");
    expect((await c.request("ping")).result).toEqual({});
    expect(await c.stop(1000)).toMatchObject({ how: "stdin closed", code: 0 });
  });

  it("gives up on a request nobody answers, naming the method and the time", async () => {
    const c = client("silent");
    await expect(c.request("ping")).rejects.toThrow("no answer to ping within 400 ms");
  });

  it("fails a request the server dies on, saying how it died", async () => {
    const c = client("crash");
    await expect(c.request("ping")).rejects.toThrow(/exited \(code 7\)/);
    await expect(c.request("ping")).rejects.toThrow(/has exited/); // and a request after that does not hang
  });

  it("keeps a stdout line that is not JSON apart, so the clean-stdout check can fail on it", async () => {
    const c = client("garbage");
    await c.request("ping");
    expect(c.nonJsonLines).toEqual(["hello, this is not json"]);
  });

  it("keeps answers nobody waits for (a string id) and hands them out in order", async () => {
    const c = client("ok");
    c.sendRaw('{"jsonrpc":"2.0","id":"s-1","method":"ping"}');
    expect((await c.takeUnmatched(1, 1000)).map((m: any) => m.id)).toEqual(["s-1"]);
    expect(await c.takeUnmatched(1, 100)).toEqual([]);
  });

  it("goes down the ladder when a server ignores a polite goodbye: stdin close, SIGTERM, then SIGKILL", async () => {
    const c = client("stubborn");
    await c.request("ping");
    const ended = await c.stop(150);
    expect(ended.how).toBe("SIGKILL");
    expect(ended.signal).toBe("SIGKILL");
  });

  it("stops a server that is already gone without error", async () => {
    const c = client("crash");
    await c.request("ping").catch(() => undefined);
    await c.proc.exited;
    expect(await c.stop(100)).toMatchObject({ how: "already exited", code: 7 });
  });

  it("writes nothing to a dead server without throwing (a late write is answered by the exit, not by an exception)", async () => {
    const c = client("crash");
    await c.request("ping").catch(() => undefined);
    await c.proc.exited;
    expect(() => c.notify("notifications/initialized")).not.toThrow();
  });

  it("hides a secret in the server's stderr tail", async () => {
    const script = path.join(dir, "noisy.js");
    fs.writeFileSync(script, 'console.error("token is the-secret-value ok"); process.stdin.on("end", () => process.exit(0)); process.stdin.resume();');
    const proc = new lib.ManagedProcess({ args: [script], env: lib.baseEnv({}), secrets: ["the-secret-value"] });
    await new Promise((r) => setTimeout(r, 300));
    await proc.stop({ stdinFirst: true, graceMs: 1000 });
    expect(proc.stderrText()).toBe("token is <hidden> ok\n");
  });
});

describe("driveStdio against fake servers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-fake2-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scenario = { name: "one", steps: [{ name: "ping", method: "ping" }] };
  const write = (name: string, code: string) => { const f = path.join(dir, name); fs.writeFileSync(f, code); return f; };
  const answerer = `
    process.stdin.setEncoding("utf8"); let buf = "";
    process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) continue;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "x", capabilities: { tools: {} }, serverInfo: { name: "increadible", version: "VERSION" } } : {} }) + "\\n"); } });`;
  const drive = (file: string, extra: object = {}) => lib.driveStdio({ args: [file], env: lib.baseEnv({}), scenario, expectVersion: "1.2.3", requestTimeoutMs: 400, ...extra });
  const verdicts = (run: any) => Object.fromEntries(run.results[0].steps.map((s: any) => [s.name, s.ok]));

  it("passes a server that answers, has the right version and leaves cleanly", async () => {
    const run = await drive(write("good.js", answerer.replace("VERSION", "1.2.3") + 'process.stdin.on("end", () => process.exit(0));'));
    expect(verdicts(run)).toEqual({ handshake: true, ping: true, shutdown: true, "stdout is protocol only": true });
  });

  it("fails the handshake for the wrong version and for a server that does not answer, and does not run the scenario", async () => {
    const wrong = await drive(write("wrong.js", answerer.replace("VERSION", "9.9.9") + 'process.stdin.on("end", () => process.exit(0));'));
    expect(verdicts(wrong).handshake).toBe(false);
    expect(wrong.results[0].steps[0].problems[0]).toMatch(/serverInfo\.version should be 1\.2\.3, got "9\.9\.9"/);
    const silent = await drive(write("silent.js", 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'));
    expect(verdicts(silent)).toEqual({ handshake: false, shutdown: true, "stdout is protocol only": true });
    expect(silent.results[0].steps[0].problems[0]).toBe("no answer to initialize within 400 ms");
  });

  it("fails the handshake for a server that does not call itself increadible", async () => {
    const run = await drive(write("other.js", answerer.replace("VERSION", "1.2.3").replace('name: "increadible"', 'name: "other-server"') + 'process.stdin.on("end", () => process.exit(0));'));
    expect(verdicts(run).handshake).toBe(false);
    expect(run.results[0].steps[0].problems[0]).toBe('serverInfo.name should be "increadible", got "other-server"');
  });

  it("fails the shutdown check for a server that leaves only when it is sent SIGTERM, even with exit code 0", async () => {
    const run = await drive(write("sigterm-only.js", answerer.replace("VERSION", "1.2.3") + 'setInterval(() => {}, 1000); process.stdin.on("end", () => {}); process.on("SIGTERM", () => process.exit(0));'), { graceMs: 150 });
    expect(verdicts(run).shutdown).toBe(false);
    expect(run.results[0].steps.find((s: any) => s.name === "shutdown").problems[0]).toBe("the server did not leave when stdin closed (it needed SIGTERM)");
  });

  it("fails the stdout check for an answer nobody asked for (a well-formed message with an id no request used)", async () => {
    const run = await drive(write("unsolicited.js", answerer.replace("VERSION", "1.2.3") + 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }) + "\\n"); process.stdin.on("end", () => process.exit(0));'));
    expect(verdicts(run)).toEqual({ handshake: true, ping: true, shutdown: true, "stdout is protocol only": false });
    expect(run.results[0].steps.find((s: any) => s.name === "stdout is protocol only").problems[0]).toMatch(/^an answer nobody asked for: .*"id":999/);
  });

  it("fails the shutdown check for a nonzero exit, and the stdout check for a stray line", async () => {
    const run = await drive(write("bad.js", answerer.replace("VERSION", "1.2.3") + 'console.log("stray words"); process.stdin.on("end", () => process.exit(3));'));
    expect(verdicts(run)).toEqual({ handshake: true, ping: true, shutdown: false, "stdout is protocol only": false });
    expect(run.results[0].steps.find((s: any) => s.name === "shutdown").problems[0]).toBe("the server left with code 3, expected 0");
    expect(run.results[0].steps.find((s: any) => s.name === "stdout is protocol only").problems[0]).toBe("stdout line that is not JSON: stray words");
  });
});

describe("the HTTP client", () => {
  let server: http.Server;
  let base = "";
  const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
  let ready = 200;
  let unauthorized = false;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ method: req.method as string, url: req.url as string, auth: req.headers.authorization, body });
        if (req.url === "/ready") { res.statusCode = ready; res.end("{}"); return; }
        if (req.url === "/echo-secret") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ leaked: "the-token-value" })); return; }
        if (req.url === "/html") { res.end("<html>nope</html>"); return; }
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/mcp") { res.end("{}"); return; }
        if (unauthorized) { res.statusCode = 401; res.end(JSON.stringify({ error: "Unauthorized" })); return; }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { echoed: JSON.parse(body).method } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));

  it("sends the bearer token unless told not to, and increments the request id", async () => {
    const c = new lib.HttpClient({ baseUrl: base, token: "the-token-value", secrets: ["the-token-value"] });
    seen.length = 0;
    expect((await c.rpc("ping")).result).toEqual({ echoed: "ping" });
    await c.request("GET", "/health", { auth: false });
    expect(seen.map((s) => [s.url, s.auth])).toEqual([["/mcp", "Bearer the-token-value"], ["/health", undefined]]);
    expect(JSON.parse(seen[0].body)).toMatchObject({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  it("hides the token in what it returns, and refuses an answer that is not JSON-RPC (a 401 page, HTML)", async () => {
    const c = new lib.HttpClient({ baseUrl: base, token: "the-token-value", secrets: ["the-token-value"] });
    expect((await c.request("GET", "/echo-secret")).text).toBe('{"leaked":"<hidden>"}');
    const original = c.request.bind(c);
    c.request = (method: string, p: string, o: any) => original(method, p === "/mcp" ? "/html" : p, o);
    await expect(c.rpc("ping")).rejects.toThrow(/HTTP 200 without a JSON-RPC body/);
  });

  it("refuses a JSON answer that is not JSON-RPC either (the 401 body of the real server), naming the status", async () => {
    const c = new lib.HttpClient({ baseUrl: base, token: "t" });
    unauthorized = true;
    try {
      await expect(c.rpc("ping")).rejects.toThrow('HTTP 401 without a JSON-RPC body: {"error":"Unauthorized"}');
    } finally {
      unauthorized = false;
    }
  });

  it("waits for /ready, and gives up with the last answer it saw", async () => {
    const c = new lib.HttpClient({ baseUrl: base });
    ready = 503;
    await expect(c.waitReady(300)).rejects.toThrow(/did not answer 200 within 300 ms \(last: HTTP 503\)/);
    ready = 200;
    await expect(c.waitReady(300)).resolves.toBeUndefined();
    await expect(c.waitReady(300, () => false)).rejects.toThrow(/exited before it was ready/);
  });

  it("times out on a server that never answers", async () => {
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    try {
      const c = new lib.HttpClient({ baseUrl: `http://127.0.0.1:${(silent.address() as any).port}`, timeoutMs: 200 });
      await expect(c.request("GET", "/x")).rejects.toThrow(/no answer to GET \/x within 200 ms/);
    } finally {
      silent.closeAllConnections?.();
      silent.close();
    }
  });
});

describe("the review's findings, at the library level", () => {
  it("compares literal objects without regard to the order of their keys, at any depth, but not arrays (T-15)", () => {
    expect(lib.matchValue({ b: 1, a: { y: 2, x: 1 } }, { a: { x: 1, y: 2 }, b: 1 })).toBeNull();
    expect(lib.matchValue({ a: 1 }, { a: 1, b: 2 })).not.toBeNull();
    expect(lib.matchValue({ a: 1, b: 2 }, { a: 1 })).not.toBeNull();
    expect(lib.matchValue([1, 2], [2, 1])).not.toBeNull();
    expect(lib.matchValue({ a: [{ k: 1, j: 2 }] }, { a: [{ j: 2, k: 1 }] })).toBeNull();
    expect(lib.matchValue(null, {})).not.toBeNull();
    expect(lib.sameJson(["a", { b: [1] }], ["a", { b: [1] }])).toBe(true);
  });

  it("redacts a value by walking it, so a secret that needs escaping in JSON cannot corrupt the answer (T-09)", () => {
    const secret = 'quo"te\\back-5150';
    const answer = { result: { content: [{ type: "text", text: `echoed ${secret} twice ${secret}` }] }, [`key-${secret}`]: 1, n: 7, ok: true, nothing: null };
    const clean = lib.redactDeep(answer, [secret]);
    expect(clean.result.content[0].text).toBe("echoed <hidden> twice <hidden>");
    expect(Object.keys(clean)).toContain("key-<hidden>");
    expect([clean.n, clean.ok, clean.nothing]).toEqual([7, true, null]);
    expect(JSON.stringify(clean)).not.toContain("5150");
  });

  it("replaces control characters other than tab, line feed and carriage return, so a server cannot steer the terminal (SEC-07)", () => {
    expect(lib.redact("a\u001b[31mred\u001b[0m\tb\r\nc\u0007\u0000d\u007f", [])).toBe("a?[31mred?[0m\tb\r\nc??d?");
    expect(lib.redact("x", [])).toBe("x");
  });

  it("takes only whole numbers a timer can use, and says which option was wrong (T-03)", () => {
    for (const bad of ["abc", "NaN", "-5", "0", "1.5", "99999999999999", "", " 5", "5 ", "1e3", "0x10"]) expect(() => lib.parseInteger("timeout-ms", bad)).toThrow(lib.UsageError);
    expect(() => lib.parseInteger("timeout-ms", "x")).toThrow("--timeout-ms must be a whole number from 1 to 2147483647");
    expect(lib.parseInteger("n", "250")).toBe(250);
    expect(lib.parseInteger("n", "2147483647")).toBe(2147483647);
    expect(() => lib.parseInteger("n", "2147483648")).toThrow(/whole number/);
    expect(lib.parseInteger("n", "0", { min: 0 })).toBe(0);
  });

  it("refuses to switch live calls on, however the value is spelled, and lets everything else through (T-01)", () => {
    expect(() => lib.assertNoLive({ GATEWAY_LIVE_APIS: "hackernews" }, "--env")).toThrow(/--env: GATEWAY_LIVE_APIS switches on calls to real providers/);
    expect(() => lib.assertNoLive({ GATEWAY_LIVE_APIS: " all " }, "--env")).toThrow(lib.UsageError);
    for (const fine of [{}, { GATEWAY_LIVE_APIS: "" }, { GATEWAY_LIVE_APIS: "  " }, { GATEWAY_CONTACT: "a@b.test" }]) expect(() => lib.assertNoLive(fine, "--env")).not.toThrow();
  });

  describe("the registry of what a run has open (T-02)", () => {
    it("removes work directories and ends servers when told to, and not a directory that was kept", async () => {
      const gone = lib.makeWorkdir();
      const kept = lib.makeWorkdir();
      lib.keepWorkdir(kept);
      const sleeper = new lib.ManagedProcess({ args: ["-e", "setInterval(() => {}, 1000)"], env: lib.baseEnv({}) });
      await new Promise((r) => setTimeout(r, 100));
      lib.cleanupNow();
      await Promise.race([sleeper.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("the process was not ended")), 3000))]);
      expect(sleeper.exit).toMatchObject({ signal: "SIGTERM" });
      expect(fs.existsSync(gone)).toBe(false);
      expect(fs.existsSync(kept)).toBe(true);
      lib.removeWorkdir(kept);
    });
  });
});

describe("the HTTP client's limits (T-11, T-12, SEC-05)", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      if (req.url === "/big") { res.write("x".repeat(3000)); res.end("y".repeat(3000)); return; }
      if (req.url === "/drip") { res.write("{"); const t = setInterval(() => res.write(" "), 40); res.on("close", () => clearInterval(t)); return; }
      if (req.url === "/cut") { res.setHeader("Content-Length", "100"); res.write("short"); setTimeout(() => res.destroy(), 30); return; }
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));

  it("refuses an answer larger than the limit instead of holding all of it", async () => {
    const c = new lib.HttpClient({ baseUrl: base, maxBytes: 4096 });
    await expect(c.request("GET", "/big")).rejects.toThrow("is larger than 4096 bytes");
    expect((await c.request("GET", "/ok")).status).toBe(200);
  });

  it("holds the whole exchange to its deadline, also when the server keeps sending (not only when it falls silent)", async () => {
    const c = new lib.HttpClient({ baseUrl: base, timeoutMs: 250 });
    const started = Date.now();
    await expect(c.request("GET", "/drip")).rejects.toThrow("no answer to GET /drip within 250 ms");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports an answer that was cut off, naming the request", async () => {
    const c = new lib.HttpClient({ baseUrl: base });
    await expect(c.request("GET", "/cut")).rejects.toThrow(/before the answer to GET \/cut was complete|socket hang up|aborted/);
  });

  it("keeps each readiness attempt within the time that is left, so a small ready timeout is honoured", async () => {
    const hanging = http.createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", () => resolve()));
    try {
      const c = new lib.HttpClient({ baseUrl: `http://127.0.0.1:${(hanging.address() as any).port}`, timeoutMs: 20000 });
      const started = Date.now();
      await expect(c.waitReady(400)).rejects.toThrow(/did not answer 200 within 400 ms/);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      hanging.closeAllConnections?.();
      hanging.close();
    }
  });
});

describe("the stdio client and its stdout (T-10, SEC-08)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-fake3-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, code: string) => { const f = path.join(dir, name); fs.writeFileSync(f, code); return f; };

  it("keeps a multi-byte character whole when the pipe delivers it in pieces", async () => {
    // the server writes the answer one byte at a time, so every multi-byte character is split across reads
    const file = write("split.js", `
      process.stdin.setEncoding("utf8"); let buf = "";
      process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { text: "é€😀 ünï" } }) + "\\n");
        let k = 0; const t = setInterval(() => { process.stdout.write(bytes.subarray(k, k + 1)); k += 1; if (k >= bytes.length) clearInterval(t); }, 1); } });
      process.stdin.on("end", () => process.exit(0));`);
    const c = new lib.StdioClient({ args: [file], env: lib.baseEnv({}), requestTimeoutMs: 5000 });
    try {
      expect((await c.request("ping")).result.text).toBe("é€😀 ünï");
      expect(c.nonJsonLines).toEqual([]);
    } finally {
      await c.stop(500);
    }
  });

  it("fails the stdout check for text without a final line break (it was never a line, so it was never looked at)", async () => {
    const file = write("tail.js", `
      process.stdin.setEncoding("utf8"); let buf = "";
      process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) continue;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "x", capabilities: { tools: {} }, serverInfo: { name: "increadible", version: "1.2.3" } } : {} }) + "\\n"); } });
      process.stdin.on("end", () => { process.stdout.write("goodbye without a newline"); process.exit(0); });`);
    const run = await lib.driveStdio({ args: [file], env: lib.baseEnv({}), scenario: { name: "s", steps: [{ name: "ping", method: "ping" }] }, expectVersion: "1.2.3", requestTimeoutMs: 1000 });
    const stray = run.results[0].steps.find((s: any) => s.name === "stdout is protocol only");
    expect(stray.ok).toBe(false);
    expect(stray.problems[0]).toBe("stdout text without a line break at the end: goodbye without a newline");
  });
});

describe("scenario validation, the rules about what a step can evaluate (T-04, D-03, T-13, T-16)", () => {
  const step = (extra: object) => ({ name: "s", steps: [{ name: "x", method: "ping", ...extra }] });
  const refused = (scenario: object) => { try { lib.validateScenario(scenario, "t.json"); return ""; } catch (e) { return (e as Error).message; } };

  it("refuses an expectation that this kind of step can never evaluate, naming file and step", () => {
    const cases: Array<[string, object, RegExp]> = [
      ["json on a method step", step({ expect: { json: { a: 1 } } }), /"json" applies to a tool step/],
      ["contains on a method step", step({ expect: { contains: "x" } }), /"contains" applies to a tool step/],
      ["tool_error on a method step", step({ expect: { tool_error: true } }), /"tool_error" applies to a tool step/],
      ["message_contains without rpc_error", step({ expect: { message_contains: "x" } }), /"message_contains" needs "rpc_error"/],
      ["json next to rpc_error (on a tool step)", step({ method: undefined, tool: "t", expect: { rpc_error: -32602, json: { a: 1 } } }), /"json" cannot go with "rpc_error"/],
      ["result next to rpc_error", step({ expect: { rpc_error: -32601, result: { a: 1 } } }), /"result" cannot go with "rpc_error"/],
      ["tools_include next to rpc_error", step({ method: "tools/list", expect: { rpc_error: -32601, tools_include: ["a"] } }), /"tools_include" cannot go with "rpc_error"/],
      ["save next to rpc_error", step({ save: { a: "b" }, expect: { rpc_error: -32601 } }), /"save" cannot go with "rpc_error"/],
      ["tools_include on another method", step({ expect: { tools_include: ["a"] } }), /"tools_include" applies to the method "tools\/list"/],
      ["params on a tool step", step({ method: undefined, tool: "t", params: {} }), /"params" belongs to a method step/],
      ["arguments on a method step", step({ arguments: {} }), /"arguments" belongs to a tool step/],
      ["a regular expression that does not compile", step({ method: undefined, tool: "t", expect: { json: { a: { $matches: "(" } } } }), /json\.a: \$matches is not a regular expression/],
      ["rpc_error that is not an integer", step({ expect: { rpc_error: "-32601" } }), /"rpc_error" must be an integer code/],
      ["message_contains that is not a string", step({ expect: { rpc_error: -1, message_contains: 5 } }), /"message_contains" must be a string/],
      ["tool_error that is not a boolean", step({ method: undefined, tool: "t", expect: { tool_error: "yes" } }), /"tool_error" must be true or false/],
      ["contains that is not a string", step({ method: undefined, tool: "t", expect: { contains: 5 } }), /"contains" must be a string/],
      ["tools_include that is not a list of names", step({ method: "tools/list", expect: { tools_include: "a" } }), /"tools_include" must be a list of tool names/],
      ["json as a list", step({ method: undefined, tool: "t", expect: { json: [] } }), /"json" must map dotted paths to values/],
      ["expect that is not an object", step({ expect: [] }), /"expect" must be an object/],
      ["save that is not a map of paths", step({ save: { a: 1 } }), /"save" must map names to dotted paths/],
      ["method that is not a string", step({ method: 5 }), /"method" must be a string/],
    ];
    for (const [what, scenario, message] of cases) expect({ what, error: refused(scenario) }).toEqual({ what, error: expect.stringMatching(message) });
    for (const [what, scenario] of cases) expect({ what, names: refused(scenario) }).toEqual({ what, names: expect.stringContaining("t.json: step 1 (x)") });
  });

  it("accepts what each kind of step can evaluate", () => {
    const fine: object[] = [
      step({ expect: { result: { a: 1 } } }),
      step({ expect: { rpc_error: -32601, message_contains: "not found" } }),
      step({ method: "tools/list", expect: { tools_include: ["a"], result: { "tools.0.name": "a" } } }),
      step({ method: "tools/call", params: { name: "t" }, expect: { json: { a: 1 }, contains: "x", tool_error: false } }),
      step({ method: undefined, tool: "t", save: { v: "a" }, expect: { json: { a: { $matches: "^x$" } } } }),
    ];
    for (const scenario of fine) expect(refused(scenario)).toBe("");
  });

  describe("loadScenario", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-scn-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("treats a value with a separator or ending in .json as a file, and anything else as a shipped name, whatever is in the current directory", () => {
      const own = path.join(dir, "own.json");
      fs.writeFileSync(own, JSON.stringify({ name: "own", steps: [{ name: "p", method: "ping" }] }));
      expect(lib.loadScenario(own).name).toBe("own");
      const cwd = process.cwd();
      fs.writeFileSync(path.join(dir, "basic"), "not a scenario");
      process.chdir(dir);
      try {
        expect(lib.loadScenario("basic").name).toBe("basic"); // the shipped one, not the file called "basic" here
        expect(lib.loadScenario("./own.json").name).toBe("own");
      } finally {
        process.chdir(cwd);
      }
    });

    it("names the file in the error for invalid JSON, a directory and a missing file", () => {
      const broken = path.join(dir, "broken.json");
      fs.writeFileSync(broken, "{ not json");
      expect(() => lib.loadScenario(broken)).toThrow(new RegExp(`${broken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: not valid JSON`));
      expect(() => lib.loadScenario(dir + path.sep)).toThrow(dir);
      expect(() => lib.loadScenario(path.join(dir, "missing.json"))).toThrow(/no scenario .*missing\.json/);
      expect(() => lib.loadScenario("no-such-name")).toThrow(/no scenario "no-such-name" \(looked for .*drive-scenarios\/no-such-name\.json\)/);
    });
  });
});
