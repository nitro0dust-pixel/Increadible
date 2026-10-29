import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Stage 4 of the request drivers: scripts/drive-live.js (docs/DRIVERS.md, section 10).
 * Drives the compiled gateway against a local stub HTTP server over 127.0.0.1, exercising live GET calls, credentials,
 * secret redaction, redirect refusal, bounded retries (503 and 429 + Retry-After), 429 cooldowns, per-API and default
 * rate limits, timeouts, response byte caps, and the Wikimedia User-Agent contact rule.
 */
const liveDriver = require("../scripts/drive-live.js");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "increadible-drivelive-test-"));
const server = path.join(tmp, "server");

beforeAll(() => {
  fs.mkdirSync(server);
  fs.symlinkSync(path.join(root, "node_modules"), path.join(server, "node_modules"), "dir");
  fs.copyFileSync(path.join(root, "package.json"), path.join(server, "package.json"));
  const tsc = cp.spawnSync(
    process.execPath,
    [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(server, "dist")],
    { cwd: root, encoding: "utf8" }
  );
  if (tsc.status !== 0) throw new Error(`build for drive-live.test.ts failed:\n${tsc.stdout}${tsc.stderr}`);
}, 120_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runLive(args: string[], env: Record<string, string> = {}) {
  const r = cp.spawnSync(process.execPath, [path.join(root, "scripts", "drive-live.js"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function broken<T>(file: string, from: string, to: string, fn: () => T): T {
  const target = path.join(server, "dist", ...file.split("/"));
  const original = fs.readFileSync(target, "utf8");
  expect({ file, occurrences: original.split(from).length - 1 }).toEqual({ file, occurrences: 1 });
  fs.writeFileSync(target, original.replace(from, () => to));
  try {
    return fn();
  } finally {
    fs.writeFileSync(target, original);
  }
}

describe("scripts/drive-live.js", () => {
  it("runs all 9 live-gateway checks against the local stub provider and exits 0", () => {
    const ran = runLive(["--root", server, "--json"]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.json.ok).toBe(true);
    expect(ran.json.driver).toBe("live");
    const steps = ran.json.results[0].steps;
    expect(steps).toHaveLength(liveDriver.CHECKS.length);
    expect(steps.every((s: any) => s.ok)).toBe(true);
    expect(steps.map((s: any) => s.name)).toEqual(liveDriver.CHECKS.map((c: any) => c.id));
  });

  it("prints a plain-text report without --json and never leaks the stub credentials", () => {
    const ran = runLive(["--root", server]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("PASS 9/9");
    expect(ran.stdout + ran.stderr).not.toContain("stub-query-secret-9001");
    expect(ran.stdout + ran.stderr).not.toContain("stub-header-secret-9002");
  });

  it("supports --list and --help, and exits 2 on bad options or a missing build", () => {
    const listed = runLive(["--list"]);
    expect(listed.status).toBe(0);
    for (const c of liveDriver.CHECKS) expect(listed.stdout).toContain(c.id);

    const help = runLive(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: drive-live.js");

    for (const bad of [["--nope"], ["extra"], ["--timeout-ms", "0"], ["--timeout-ms", "abc"]]) {
      expect({ bad, status: runLive(bad).status }).toEqual({ bad, status: 2 });
    }

    const empty = fs.mkdtempSync(path.join(tmp, "empty-"));
    fs.writeFileSync(path.join(empty, "package.json"), JSON.stringify({ version: "1.0.5" }));
    const noBuild = runLive(["--root", empty]);
    expect(noBuild.status).toBe(2);
    expect(noBuild.stderr).toContain('run "npm run build"');
  });

  it("refuses --live-probes with exit 2 when GATEWAY_CONTACT is not set", () => {
    const ran = runLive(["--root", server, "--live-probes"]);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("--live-probes requires GATEWAY_CONTACT");
  });

  describe("each live check fails when the gateway behaviour it guards is broken", () => {
    it("notices when redirects are followed instead of refused", () => {
      const ran = broken("features/09-api-gateway/src/live.js", 'redirect: "manual"', 'redirect: "follow"', () =>
        runLive(["--root", server, "--json"])
      );
      expect(ran.status).toBe(1);
      const failing = ran.json.results[0].steps.filter((s: any) => !s.ok).map((s: any) => s.name);
      expect(failing).toContain("live.redirect-refused");
    });

    it("notices when Wikimedia's production contact check is bypassed", () => {
      const ran = broken("features/09-api-gateway/src/mcp-server.js", "if (this.production && !this.contact && isWikimediaUrl(api.endpoint))", "if (false)", () =>
        runLive(["--root", server, "--json"])
      );
      expect(ran.status).toBe(1);
      const failing = ran.json.results[0].steps.filter((s: any) => !s.ok).map((s: any) => s.name);
      expect(failing).toContain("live.wikimedia-contact-rule");
    });

    it("notices when the per-API rate limiter stops refusing calls over the limit", () => {
      const ran = broken("features/09-api-gateway/src/mcp-server.js", "if (times.length >= limit)", "if (false)", () =>
        runLive(["--root", server, "--json"])
      );
      expect(ran.status).toBe(1);
      const failing = ran.json.results[0].steps.filter((s: any) => !s.ok).map((s: any) => s.name);
      expect(failing).toContain("live.rate-limits");
    });
  });
});
