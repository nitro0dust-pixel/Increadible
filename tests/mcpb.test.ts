/**
 * The Claude Desktop package: mcpb/manifest.json and scripts/mcpb.js.
 *
 * The first block holds the manifest to package.json and to the server (the tools it really lists, the settings the code really
 * reads). The second block builds the bundle from the committed sources, reads it with an independent zip reader, and then does what
 * Claude Desktop does with an installed extension, minus the app: unpack it into a folder, substitute the manifest's variables, and
 * start the server from the unpacked files with that environment. It proves the bundle is complete (production dependencies
 * present, no source or dev tool needed) and that the data lands in the folder the user chose. It does NOT prove that Claude
 * Desktop accepts the file: that needs the app (docs/INSTALL-CLAUDE-DESKTOP.md).
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as cp from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { fsyncFromEnv } from "../features/08-ab-testing/src/mcp-server";
import { bitwiseCrc32, readZip } from "./helpers/zip";

const mcpb = require("../scripts/mcpb.js");
const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf-8");
const manifest = JSON.parse(read("mcpb/manifest.json"));
const pkg = JSON.parse(read("package.json"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-test-"));

describe("mcpb/manifest.json", () => {
  let tools: Array<{ name: string; description: string }>;
  beforeAll(async () => {
    process.env.RULES_FILE = "/nonexistent/increadible-rules.yaml";
    process.env.EXPERIMENTS_FILE = "/nonexistent/increadible-experiments.yaml";
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let server: any;
    jest.isolateModules(() => {
      server = require("../src/server");
    });
    const reply: any = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    tools = reply.result.tools;
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  it("is consistent with package.json and lists exactly the tools the server lists, in order", () => {
    expect(tools).toHaveLength(13);
    expect(mcpb.problems(manifest, pkg, tools.map((t) => t.name))).toEqual([]);
    for (const [i, listed] of manifest.tools.entries()) expect(tools[i].description.startsWith(listed.description)).toBe(true); // a shortened description, never a different one
  });

  it("sets only settings the code reads, and each declared setting is used", () => {
    const sources = ["src/index.ts", "src/server.ts", "features/07-routing-plugins/src/mcp-server.ts", "features/08-ab-testing/src/mcp-server.ts", "features/09-api-gateway/src/mcp-server.ts"].map(read).join("\n");
    const env = manifest.server.mcp_config.env as Record<string, string>;
    for (const name of Object.keys(env)) expect({ name, readByCode: sources.includes(`process.env.${name}`) }).toEqual({ name, readByCode: true });
    const used = JSON.stringify(manifest.server.mcp_config);
    for (const key of Object.keys(manifest.user_config)) expect({ key, used: used.includes(`\${user_config.${key}}`) }).toEqual({ key, used: true });
  });

  it("turns the boolean setting into a value AB_FSYNC understands (the runtime writes booleans as \"true\" and \"false\")", () => {
    expect(manifest.server.mcp_config.env.AB_FSYNC).toBe("${user_config.durable_writes}");
    expect(manifest.user_config.durable_writes).toMatchObject({ type: "boolean", default: true });
    expect(fsyncFromEnv("true")).toBe(true);
    expect(fsyncFromEnv("false")).toBe(false);
  });

  it("asks where the data lives instead of guessing: a required folder with no default, so data is never silently written (or lost) somewhere unplanned", () => {
    expect(manifest.user_config.data_directory).toMatchObject({ type: "directory", required: true });
    expect(manifest.user_config.data_directory.default).toBeUndefined();
    for (const name of ["RULES_FILE", "AB_DATA_FILE", "EXPERIMENTS_FILE"]) expect(manifest.server.mcp_config.env[name]).toMatch(/^\$\{user_config\.data_directory\}\$\{\/\}[a-z0-9.-]+$/);
  });

  it("holds no secret, no key setting and no claim that was not run", () => {
    const text = read("mcpb/manifest.json");
    expect(text).not.toMatch(/GATEWAY_KEY_|AUTH_TOKEN|sk-[A-Za-z0-9]{10}|ghp_|AKIA|BEGIN [A-Z ]*PRIVATE KEY/);
    expect(manifest.description + manifest.long_description).toMatch(/mock/);
    expect(manifest.long_description).toMatch(/never been run against a real provider/);
    expect(JSON.stringify(manifest)).not.toMatch(/production-ready|verified savings|certified|SOC ?2|GDPR/i);
  });

  describe("problems() really checks (each breakage must be reported)", () => {
    const names = () => tools.map((t) => t.name);
    const cases: Array<[string, (m: any) => void, RegExp]> = [
      ["a wrong manifest_version", (m) => (m.manifest_version = "0.9"), /manifest_version/],
      ["a different name", (m) => (m.name = "other"), /name "other"/],
      ["a different version", (m) => (m.version = "9.9.9"), /version "9.9.9"/],
      ["a different license", (m) => (m.license = "GPL-3.0"), /license/],
      ["a different author", (m) => (m.author = { name: "Someone" }), /author/],
      ["a server that is not node", (m) => (m.server.type = "python"), /server\.type/],
      ["an entry point other than main.js", (m) => (m.server.entry_point = "dist/other.js"), /entry_point/],
      ["index.js as the entry (it starts itself only when it is the program, not when a launcher loads it)", (m) => (m.server.entry_point = "dist/src/index.js"), /must be "dist\/src\/main\.js"/],
      ["lazy opening of the A/B data switched off", (m) => (m.server.mcp_config.env.AB_LAZY_OPEN = "false"), /AB_LAZY_OPEN/],
      ["lazy opening of the A/B data missing", (m) => delete m.server.mcp_config.env.AB_LAZY_OPEN, /AB_LAZY_OPEN/],
      ["a command that is not node", (m) => (m.server.mcp_config.command = "/usr/bin/node"), /command/],
      ["arguments that do not start the entry point", (m) => (m.server.mcp_config.args = ["${__dirname}/dist/src/server.js"]), /args/],
      ["a variable that does not exist", (m) => (m.server.mcp_config.env.RULES_FILE = "${HOME}${/}rules.yaml"), /\$\{HOME\}/],
      ["a setting that is not declared", (m) => (m.server.mcp_config.env.RULES_FILE = "${user_config.nope}"), /user_config\.nope/],
      ["a setting of an unknown type", (m) => (m.user_config.data_directory.type = "folder"), /known type/],
      ["a required setting that also has a default", (m) => (m.user_config.data_directory.default = "/tmp"), /required and has a default/],
      ["a setting without a description", (m) => delete m.user_config.durable_writes.description, /title and a description/],
      ["a non-string environment value", (m) => (m.server.mcp_config.env.AB_FSYNC = true), /must be a string/],
      ["a runtime that is not the package's", (m) => (m.compatibility.runtimes.node = ">=18.0.0"), /engines/],
      ["no runtime at all", (m) => delete m.compatibility.runtimes, /engines/],
      ["a tool without a description", (m) => delete m.tools[0].description, /name and a description/],
      ["a missing tool", (m) => m.tools.pop(), /differ from what the server lists/],
      ["tools in another order", (m) => m.tools.reverse(), /differ from what the server lists/],
    ];
    it.each(cases)("%s", (_name, change, expected) => {
      const broken = clone(manifest);
      change(broken);
      expect(mcpb.problems(broken, pkg, names()).join("\n")).toMatch(expected);
    });
  });
});

describe("scripts/mcpb.js, the parts that a normal build never exercises", () => {
  it("files() leaves out secrets and noise, keeps everything else, and sorts by path", () => {
    const dir = tmp();
    const put = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), rel);
    };
    const keep = ["z.js", "a.js", "a-b.js", "a/x.js", "node_modules/pkg/index.js", "node_modules/pkg/.envelope.txt", "dist/b.d.ts", "dist/envfile.js"]; // "a-b.js" sorts before "a/x.js" by path, after it in a walk that goes folder by folder
    const drop = [".env", ".env.local", ".env.production", "sub/.env", ".DS_Store", "sub/.DS_Store", "a.js.map", "node_modules/.bin/tool", "node_modules/.cache/x", "node_modules/.package-lock.json", ".git/config"];
    for (const rel of [...keep, ...drop]) put(rel);
    expect(mcpb.files(dir).map(([name]: [string]) => name)).toEqual([...keep].sort());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("installs the production dependencies from the lockfile without running any package script, and compiles from the committed config", () => {
    const source = read("scripts/mcpb.js");
    expect(source).toContain('"ci", "--omit=dev", "--ignore-scripts"');
    expect(source).toContain('"tsconfig.build.json"');
    expect(source).toContain('fs.rmSync(path.join(stage, "package-lock.json"))');
  });

  it("inspect() reports a pure checksum mismatch (a stored entry, so no decompression error can hide it) and a duplicated name", () => {
    const { zip } = require("../scripts/zip.js");
    const dir = tmp();
    const random = crypto.randomBytes(64);
    const good = zip([["manifest.json", Buffer.from('{"server":{"entry_point":"x.bin"}}')], ["x.bin", random]]);
    const bad = Buffer.from(good);
    const at = bad.indexOf(random);
    expect(at).toBeGreaterThan(0);
    bad[at + 10] ^= 0x01;
    const write = (name: string, buf: Buffer) => {
      fs.writeFileSync(path.join(dir, name), buf);
      return mcpb.inspect(path.join(dir, name)).problems.join("\n");
    };
    expect(write("bad.mcpb", bad)).toMatch(/x\.bin: checksum mismatch/);
    expect(write("dup.mcpb", zip([["manifest.json", Buffer.from("{}")], ["manifest.json", Buffer.from("{}")]]))).toMatch(/manifest\.json: appears twice/);
    expect(write("notzip.mcpb", Buffer.from("not a zip"))).toMatch(/not a zip file/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("CI keeps the bundle", () => {
  const yaml = require("yaml");
  const steps: any[] = yaml.parse(read(".github/workflows/ci-cd.yml")).jobs.quality.steps;

  it("builds it after the smoke test, inspects it, and uploads it as an artifact that must exist", () => {
    const at = (re: RegExp, key: "run" | "uses") => steps.findIndex((st) => re.test(st[key] ?? ""));
    const smoke = at(/^npm run smoke$/, "run");
    const build = at(/^npm run mcpb$/, "run");
    const inspect = at(/^node scripts\/mcpb\.js inspect dist\/mcpb\/increadible-\*\.mcpb$/, "run");
    const upload = at(/^actions\/upload-artifact@/, "uses");
    expect([smoke, build, inspect, upload].every((i) => i >= 0)).toBe(true);
    expect(smoke).toBeLessThan(build);
    expect(build).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(upload);
    expect(steps[upload].with).toEqual({ name: "increadible-mcpb", path: "dist/mcpb/*.mcpb", "if-no-files-found": "error" });
    expect(steps[upload].if).toBeUndefined(); // only a bundle that was built and inspected is kept
  });

  it("is named, in the install guide, by the artifact name and the job that makes it", () => {
    const guide = read("docs/INSTALL-CLAUDE-DESKTOP.md");
    expect(guide).toContain("`increadible-mcpb`");
    expect(guide).toContain("*Type-check, lint, build, smoke*");
  });
});

describe("the bundle (node scripts/mcpb.js build)", () => {
  jest.setTimeout(240000);
  const work = tmp();
  const file = path.join(work, "increadible-test.mcpb");
  let built: { target: string; files: number; bytes: number; sha256: string };
  let entries: ReturnType<typeof readZip>;

  beforeAll(() => {
    built = mcpb.build(file);
    entries = readZip(fs.readFileSync(file));
  });
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  it("is a zip an independent reader accepts: matching checksums, UTF-8 names, no duplicate or unsafe names", () => {
    expect(entries).toHaveLength(built.files);
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of entries) {
      expect(bitwiseCrc32(e.data)).toBe(e.crc);
      expect(e.data.length).toBe(e.usize);
      expect(e.flags & 0x0800).toBe(0x0800);
      expect(e.name).not.toMatch(/^\/|\.\.|\\|^[A-Za-z]:/);
    }
    expect(built.sha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    expect(mcpb.inspect(file).problems).toEqual([]);
  });

  it("holds the manifest at its root, byte for byte, and what the server needs: compiled code, the production dependencies, the license", () => {
    const by = new Map(entries.map((e) => [e.name, e.data]));
    expect(by.get("manifest.json")!.equals(fs.readFileSync(path.join(root, "mcpb/manifest.json")))).toBe(true);
    expect(by.get("LICENSE")!.equals(fs.readFileSync(path.join(root, "LICENSE")))).toBe(true);
    for (const needed of ["package.json", "dist/src/main.js", "dist/src/index.js", "dist/src/server.js", "dist/features/08-ab-testing/src/mcp-server.js", "node_modules/yaml/package.json"]) expect({ needed, present: by.has(needed) }).toEqual({ needed, present: true });
    expect(Object.keys(pkg.dependencies)).toEqual(["yaml"]); // the check above covers every production dependency
  });

  it("holds nothing else: no sources, tests, development tools, secrets, source maps or the lockfile", () => {
    const names = entries.map((e) => e.name);
    const top = new Set(names.map((n) => n.split("/")[0]));
    expect([...top].sort()).toEqual(["LICENSE", "dist", "manifest.json", "node_modules", "package.json"]);
    for (const dev of Object.keys(pkg.devDependencies)) expect({ dev, packed: names.some((n) => n.startsWith(`node_modules/${dev}/`)) }).toEqual({ dev, packed: false });
    expect(names.filter((n) => /(^|\/)\.env|\.map$|package-lock\.json$|node_modules\/\.bin\/|\.ts$/.test(n) && !/\.d\.ts$/.test(n))).toEqual([]);
  });

  it("is the same bytes when built again from the same commit", () => {
    const again = mcpb.build(path.join(work, "again.mcpb"));
    expect(again.sha256).toBe(built.sha256);
  });

  it("is refused by inspect() when damaged: a flipped byte, a missing manifest, an entry point that is not there", () => {
    const bytes = fs.readFileSync(file);
    const flipped = Buffer.from(bytes);
    // flip a byte inside the stored or deflated body of dist/src/main.js: its local header comes first, the body follows the name
    const nameAt = flipped.indexOf(Buffer.from("dist/src/main.js"));
    const bodyAt = nameAt + "dist/src/main.js".length + 4;
    flipped[bodyAt] ^= 0xff;
    const damaged = path.join(work, "flipped.mcpb");
    fs.writeFileSync(damaged, flipped);
    expect(mcpb.inspect(damaged).problems.length).toBeGreaterThan(0);

    const { zip } = require("../scripts/zip.js");
    const without = (name: string) => zip(entries.filter((e) => e.name !== name).map((e) => [e.name, e.data]));
    const write = (name: string, buf: Buffer) => {
      const f = path.join(work, name);
      fs.writeFileSync(f, buf);
      return mcpb.inspect(f).problems.join("\n");
    };
    expect(write("no-manifest.mcpb", without("manifest.json"))).toMatch(/manifest\.json is missing/);
    expect(write("no-entry.mcpb", without("dist/src/main.js"))).toMatch(/entry point dist\/src\/main\.js is not in the bundle/);
    expect(write("no-yaml.mcpb", without("node_modules/yaml/package.json"))).toMatch(/node_modules\/yaml is not in the bundle/);
    for (const name of ["../escape.txt", "dir/../../escape.txt", "/etc/passwd", "dir\\file.txt", "C:/Windows/x.txt"]) {
      expect({ name, reported: /unsafe name/.test(write("unsafe.mcpb", zip([["manifest.json", Buffer.from("{}")], [name, Buffer.from("x")]]))) }).toEqual({ name, reported: true });
    }
    expect(write("fine.mcpb", zip([["manifest.json", Buffer.from("{}")], ["dist/a..b.js", Buffer.from("x")], ["node_modules/@scope/pkg/index.js", Buffer.from("x")]]))).not.toMatch(/unsafe name/);
    expect(mcpb.inspect(file).problems).toEqual([]);
  });

  describe("installed the way Claude Desktop installs an extension (unpacked, variables substituted, started with the manifest's own command)", () => {
    const install = tmp(); // contains a space, like "Application Support" on macOS
    const home = path.join(install, "Application Support", "Claude Extensions", "increadible");
    const data = path.join(install, "My Data", "Increadible");
    afterAll(() => fs.rmSync(install, { recursive: true, force: true }));

    /** The manifest's substitution, written here from the vendor's rules (${__dirname}, ${/}, ${user_config.KEY}; booleans as "true"/"false"). */
    const substitute = (value: string, userConfig: Record<string, string | boolean>) =>
      value.replace(/\$\{([^}]+)\}/g, (_all, name: string) => {
        if (name === "__dirname") return home;
        if (name === "/") return path.sep;
        const key = name.replace(/^user_config\./, "");
        expect({ name, known: key in userConfig }).toEqual({ name, known: true });
        return String(userConfig[key]);
      });

    beforeAll(() => {
      for (const e of entries) {
        const out = path.join(home, ...e.name.split("/"));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, e.data);
      }
      fs.mkdirSync(data, { recursive: true });
    });

    const session = (calls: Array<[string, Record<string, unknown>]>, userConfig = { data_directory: data, durable_writes: true }) =>
      new Promise<{ code: number | null; replies: any[]; stderr: string }>((resolve, reject) => {
        const unpacked = JSON.parse(fs.readFileSync(path.join(home, "manifest.json"), "utf8"));
        const config = unpacked.server.mcp_config;
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        for (const name of ["NODE_PATH", "RULES_FILE", "EXPERIMENTS_FILE", "AB_DATA_FILE", "AB_FSYNC"]) delete env[name];
        for (const [key, value] of Object.entries(config.env as Record<string, string>)) env[key] = substitute(value, userConfig);
        const args = (config.args as string[]).map((a) => substitute(a, userConfig));
        const child = cp.spawn(process.execPath, args, { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
        const failsafe = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("failsafe: the server did not exit"));
        }, 30000);
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => {
          clearTimeout(failsafe);
          resolve({ code, replies: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)), stderr: err });
        });
        const lines = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" }];
        calls.forEach(([name, args], i) => lines.push({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name, arguments: args } } as any));
        child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        child.stdin.end();
      });
    const body = (reply: any) => JSON.parse(reply.result.content[0].text);

    /** A copy of the installed server that stays up, as Claude Desktop keeps one: send requests, read the replies, end it when done. */
    const open: cp.ChildProcess[] = [];
    afterEach(() => {
      for (const child of open.splice(0)) child.kill("SIGKILL");
    });
    function openSession(userConfig: Record<string, string | boolean>) {
      const unpacked = JSON.parse(fs.readFileSync(path.join(home, "manifest.json"), "utf8"));
      const config = unpacked.server.mcp_config;
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      for (const name of ["NODE_PATH", "RULES_FILE", "EXPERIMENTS_FILE", "AB_DATA_FILE", "AB_FSYNC", "AB_LAZY_OPEN"]) delete env[name];
      for (const name of Object.keys(env)) if (name.startsWith("GATEWAY_")) delete env[name]; // the gateway answers sample data, never a live call, whatever the developer's shell holds
      for (const [key, value] of Object.entries(config.env as Record<string, string>)) env[key] = substitute(value, userConfig);
      const child = cp.spawn(process.execPath, (config.args as string[]).map((a) => substitute(a, userConfig)), { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
      open.push(child);
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const waiting = new Map<number, (reply: any) => void>();
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        const reply = JSON.parse(line);
        waiting.get(reply.id)?.(reply);
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      let next = 1;
      const rpc = (method: string, params?: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = next++;
          const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 20 s (stderr: ${stderr.slice(0, 400)})`)), 20_000);
          waiting.set(id, (reply) => {
            clearTimeout(timer);
            resolve(reply);
          });
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      const call = async (name: string, args: Record<string, unknown>) => body(await rpc("tools/call", { name, arguments: args }));
      return { rpc, call, exited, stderr: () => stderr, end: () => child.stdin.end(), child };
    }
    const experiment = (id: string) => ({
      id, name: "n", hypothesis: "h",
      variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
      metrics: [{ id: "quality", name: "q", type: "continuous", aggregation: "mean" }],
    });
    const folder = (name: string) => {
      const dir = path.join(install, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    it("starts, answers the handshake with the 13 tools of the manifest, and writes its data into the folder the user chose", async () => {
      const experiment = {
        id: "demo", name: "n", hypothesis: "h",
        variants: [{ id: "A", name: "a", config: {} }, { id: "B", name: "b", config: {} }],
        metrics: [{ id: "quality", name: "q", type: "continuous", aggregation: "mean" }],
      };
      const calls: Array<[string, Record<string, unknown>]> = [
        ["create_experiment", experiment],
        ["update_rules", { rules: [{ id: "x", name: "x", enabled: true, priority: 1, match: {}, provider: "p", reason: "r" }] }],
      ];
      for (let i = 0; i < 20; i++) calls.push(["record_metric", { experiment_id: "demo", variant_id: i % 2 ? "A" : "B", metrics: { quality: (i % 2 ? 10 : 20) + (i % 5) } }]);
      const first = await session(calls);
      expect(first.code).toBe(0);
      expect(first.replies[0].result.serverInfo.name).toBe("increadible");
      expect(first.replies[1].result.tools.map((t: any) => t.name)).toEqual(manifest.tools.map((t: any) => t.name));
      expect(body(first.replies[2])).toEqual({ status: "success", experiment_id: "demo" });
      expect(body(first.replies[3]).status).toBe("success");
      expect(first.replies.slice(4).map((r) => body(r).status)).toEqual(Array(20).fill("recorded"));
      expect(fs.readdirSync(data).sort()).toEqual(["ab-data.jsonl", "rules.yaml"]); // the lock file is gone after a clean exit
      expect(fs.readFileSync(path.join(data, "ab-data.jsonl"), "utf8").trim().split("\n")).toHaveLength(21);
      if (process.platform !== "win32") expect(fs.statSync(path.join(data, "ab-data.jsonl")).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(home).sort()).toEqual(["LICENSE", "dist", "manifest.json", "node_modules", "package.json"]); // nothing was written next to the code
    });

    it("keeps its data across a restart: a fresh process counts what the first one recorded and still has the rules", async () => {
      const second = await session([["get_experiment_results", { experiment_id: "demo" }], ["get_rule_stats", {}]]);
      expect(second.code).toBe(0);
      expect(body(second.replies[2]).statistical_analysis.current_samples).toBe(20);
      expect(fs.readFileSync(path.join(data, "rules.yaml"), "utf8")).toMatch(/id: x/);
    });

    it("answers the handshake and every tool but the A/B data ones in a second copy started while the first is running (Claude Desktop starts several), and the second copy takes over when the first ends", async () => {
      const dir = folder("two-copies");
      const first = openSession({ data_directory: dir, durable_writes: true });
      expect(await first.call("create_experiment", experiment("multi"))).toEqual({ status: "success", experiment_id: "multi" }); // the first copy now holds the data file
      const second = openSession({ data_directory: dir, durable_writes: true });
      const hello = await second.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
      expect(hello.result.serverInfo.name).toBe("increadible");
      expect((await second.rpc("tools/list")).result.tools).toHaveLength(13);
      expect((await second.rpc("server/discover")).error.code).toBe(-32601); // the probe's own question: answered, not hung
      expect(await second.call("apply_routing_rules", { task_type: "qa", task_complexity: "low" })).toMatchObject({ provider: "claude-haiku" });
      expect(await second.call("get_api_stats", {})).toMatchObject({ total_calls: 0 });
      expect((await second.call("create_experiment", experiment("other"))).error).toMatch(/Cannot use A\/B data file .*in use by pid \d+/);
      first.end();
      expect(await first.exited).toBe(0); // a clean exit releases the lock
      expect(fs.existsSync(path.join(dir, "ab-data.jsonl.lock"))).toBe(false);
      expect(await second.call("get_experiment_results", { experiment_id: "multi" })).toMatchObject({ status: "incomplete" }); // it now has the first copy's data
      expect(await second.call("create_experiment", experiment("other"))).toEqual({ status: "success", experiment_id: "other" });
      second.end();
      expect(await second.exited).toBe(0);
    });

    it("answers the handshake and the other tools when the data folder cannot be used, and says why on the one tool that needs it", async () => {
      const blocker = path.join(install, "not-a-folder");
      fs.writeFileSync(blocker, "x");
      const copy = openSession({ data_directory: path.join(blocker, "sub"), durable_writes: true });
      expect((await copy.rpc("initialize", {})).result.serverInfo.name).toBe("increadible");
      expect(await copy.call("apply_routing_rules", { task_type: "qa", task_complexity: "low" })).toMatchObject({ provider: "claude-haiku" });
      expect((await copy.call("create_experiment", experiment("x"))).error).toMatch(/Cannot use A\/B data file/);
      copy.end();
      expect(await copy.exited).toBe(0);
    });

    it("writes nothing into the data folder until an A/B tool is called, and holds its lock only from then on", async () => {
      const dir = folder("nothing-at-start");
      const copy = openSession({ data_directory: dir, durable_writes: true });
      await copy.rpc("initialize", {});
      await copy.rpc("tools/list");
      await copy.call("get_api_stats", {});
      await copy.call("apply_routing_rules", { task_type: "qa", task_complexity: "low" });
      expect(fs.readdirSync(dir)).toEqual([]);
      await copy.call("create_experiment", experiment("e"));
      expect(fs.readdirSync(dir).sort()).toEqual(["ab-data.jsonl", "ab-data.jsonl.lock"]);
      copy.end();
      expect(await copy.exited).toBe(0);
      expect(fs.readdirSync(dir)).toEqual(["ab-data.jsonl"]);
    });

    it("does not freeze behind the lock a killed copy left (Claude Desktop kills copies at once): it answers, says to try again, and takes the lock over once it is stale", async () => {
      const dir = folder("killed-copy");
      const lock = path.join(dir, "ab-data.jsonl.lock");
      fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, host: os.hostname(), started: new Date().toISOString(), token: "left-behind" })); // a holder that no longer exists, a moment ago
      const copy = openSession({ data_directory: dir, durable_writes: true });
      const started = Date.now();
      expect((await copy.rpc("initialize", {})).result.serverInfo.name).toBe("increadible");
      expect(Date.now() - started).toBeLessThan(5000); // it used to sleep here for up to 17 s before it could answer
      expect((await copy.call("create_experiment", experiment("e"))).error).toMatch(/try again/);
      const backdated = new Date(Date.now() - 7000);
      fs.utimesSync(lock, backdated, backdated); // 7 s without a refresh: the dead holder's lock is stale
      expect(await copy.call("create_experiment", experiment("e"))).toEqual({ status: "success", experiment_id: "e" });
      copy.end();
      expect(await copy.exited).toBe(0);
    });

    it("ships an example that runs: the aggregate_apis example in the installed server's own tools/list is accepted as a call and answers sample data", async () => {
      const copy = openSession({ data_directory: folder("example-run"), durable_writes: true });
      const listed = (await copy.rpc("tools/list")).result.tools.find((t: any) => t.name === "aggregate_apis");
      const example = listed.inputSchema.properties.apis.examples[0];
      expect(Array.isArray(example) && example.length > 0).toBe(true);
      const reply = await copy.rpc("tools/call", { name: "aggregate_apis", arguments: { apis: example } });
      expect(!!reply.result.isError).toBe(false);
      const answer = body(reply);
      expect(answer.count).toBe(example.length);
      expect(answer).not.toHaveProperty("failed");
      expect(answer.data.map((r: any) => r.source)).toEqual(Array(example.length).fill("mock"));
      copy.end();
      expect(await copy.exited).toBe(0);
    });

    it("a different data folder is a different, empty store (the folder setting really decides where the data lives)", async () => {
      const other = path.join(install, "Other Data");
      fs.mkdirSync(other);
      const third = await session([["get_experiment_results", { experiment_id: "demo" }]], { data_directory: other, durable_writes: false });
      expect(third.code).toBe(0);
      expect(body(third.replies[2]).error).toBeDefined();
      expect(fs.readdirSync(data)).toContain("ab-data.jsonl");
    });
  });
});
