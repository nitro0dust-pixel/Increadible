// Runs scripts/verify.sh and scripts/cleanroom.sh for real, against stub `npm`, `docker` and a throwaway git repository, so the
// logic that decides PASS or FAIL is tested without running the whole project's checks again (and without recursing into jest).
// They need bash (and git for cleanroom.sh); on a machine without them the tests are skipped, not passed: see CLAUDE.md on Windows.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const root = path.resolve(__dirname, "..");
const works = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const bashOk = works("bash", ["-c", "true"]);
const gitOk = works("git", ["--version"]);
const promtoolOnPath = bashOk && works("bash", ["-c", "command -v promtool"]);
const itBash = bashOk ? it : it.skip;
const itGit = bashOk && gitOk ? it : it.skip;
const itNoPromtool = bashOk && !promtoolOnPath ? it : it.skip;

const made: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function script(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/** A directory laid out like the repository, whose `npm` prints jest's summary for `npm test` and fails the one step it is told to. */
function verifyHarness(testFiles: number, suitesReported: number, failStep = "none", docker: "no" | "yes" | "build-fails" = "no"): string {
  const dir = tmp("verify-sh-");
  for (const d of ["scripts", "tests", "bin"]) fs.mkdirSync(path.join(dir, d));
  fs.copyFileSync(path.join(root, "scripts/verify.sh"), path.join(dir, "scripts/verify.sh"));
  for (let i = 0; i < testFiles; i++) fs.writeFileSync(path.join(dir, "tests", `t${i}.test.ts`), "");
  script(dir, "scripts/smoke.sh", "exit 0");
  script(dir, "scripts/check-prometheus.sh", 'echo "$PROMTOOL" > "$TMPDIR/promtool-seen.txt"; exit 0');
  script(
    dir,
    "bin/npm",
    `if [ "$1" = test ]; then ls "$TMPDIR" >> "$TMPDIR/seen-during-test-step.txt"; printf 'Test Suites: ${suitesReported} passed, ${suitesReported} total\\nTests:       7 passed, 7 total\\n'; [ "${failStep}" = test ] && exit 1; exit 0; fi
if [ "$3" = "${failStep}" ]; then echo "stub failure of $3"; exit 1; fi
exit 0`,
  );
  // "no": `docker info` fails, as without a daemon; otherwise it works and `docker build` succeeds or fails
  script(dir, "bin/docker", docker === "no" ? "exit 1" : `[ "$1" = build ] && exit ${docker === "yes" ? 0 : 1}; exit 0`);
  return dir;
}

function runVerify(dir: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bash", ["scripts/verify.sh"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60000,
    env: { PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`, TMPDIR: dir, HOME: dir, ...extraEnv },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("scripts/verify.sh", () => {
  itBash("passes when every suite ran, says which tree it tested and leaves no log behind", () => {
    const dir = verifyHarness(2, 2);
    const { status, out } = runVerify(dir);
    expect(out).toMatch(/^verify: commit unknown, tree: not a git checkout, node v\d+/m);
    expect(out).toMatch(/^PASS +unit\/integration tests \(7 passed, 7 total in 2 suites\)$/m);
    for (const step of ["type-check", "lint", "build", "smoke \\(stdio \\+ HTTP\\)"]) expect(out).toMatch(new RegExp(`^PASS +${step}$`, "m"));
    expect(out).toMatch(/^NOT AVAILABLE +docker image build/m);
    expect(out).toMatch(/^NOT AVAILABLE +k8s apply/m);
    expect(status).toBe(0);
    // the step log is a fresh mktemp file in TMPDIR (not one fixed path two runs would share), and it is removed afterwards
    expect(fs.readFileSync(path.join(dir, "seen-during-test-step.txt"), "utf8")).toMatch(/^verify-step\.\w+$/m);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("verify-step"))).toEqual([]);
  });

  itGit("says whether the tree it tested was clean or had uncommitted changes", () => {
    const dir = verifyHarness(1, 1);
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    fs.writeFileSync(path.join(dir, ".gitignore"), "bin/\nseen-during-test-step.txt\n");
    git("add", ".");
    git("commit", "-q", "-m", "x");
    const sha = git("rev-parse", "HEAD");
    expect(runVerify(dir).out).toContain(`verify: commit ${sha}, tree: clean, node v`);
    fs.writeFileSync(path.join(dir, "tests", "uncommitted.test.ts"), "");
    const dirty = runVerify(dir).out;
    expect(dirty).toContain(`verify: commit ${sha}, tree: DIRTY`);
    // the extra file also makes the suite count (2 files, 1 reported) wrong, which is the point of reporting the tree
    expect(dirty).toMatch(/^FAIL +unit\/integration tests$/m);
  });

  itBash("fails a partial run: fewer suites ran than there are tests/*.test.ts files", () => {
    const { status, out } = runVerify(verifyHarness(3, 2));
    expect(out).toMatch(/^FAIL +unit\/integration tests$/m);
    expect(out).toContain("jest ran 2 suite(s), tests/ holds 3 *.test.ts file(s): a partial run is not a pass");
    expect(status).toBe(1);
  });

  itBash("fails when jest ran no suites at all", () => {
    const { status, out } = runVerify(verifyHarness(2, 0));
    expect(out).toMatch(/^FAIL +unit\/integration tests$/m);
    expect(status).toBe(1);
  });

  itBash("fails when any step fails, and still reports the others", () => {
    const { status, out } = runVerify(verifyHarness(1, 1, "lint"));
    expect(out).toMatch(/^FAIL +lint$/m);
    expect(out).toContain("stub failure of lint");
    expect(out).toMatch(/^PASS +type-check$/m);
    expect(out).toMatch(/^PASS +build$/m);
    expect(status).toBe(1);
  });

  itBash("names the commit when scripts/cleanroom.sh hands it over (a git archive has no .git to ask)", () => {
    const { out } = runVerify(verifyHarness(1, 1), { VERIFY_COMMIT: "abc123def" });
    expect(out).toMatch(/^verify: commit abc123def, tree: exported from that commit by scripts\/cleanroom\.sh/m);
  });

  itBash("runs the alert-rule check with the promtool named by PROMTOOL", () => {
    const dir = verifyHarness(1, 1);
    const { status, out } = runVerify(dir, { PROMTOOL: "/some/promtool" });
    expect(out).toMatch(/^PASS +alert rules \(promtool check and test\)$/m);
    expect(fs.readFileSync(path.join(dir, "promtool-seen.txt"), "utf8").trim()).toBe("/some/promtool");
    expect(status).toBe(0);
  });

  itBash("finds promtool on the PATH when PROMTOOL is not set", () => {
    const dir = verifyHarness(1, 1);
    script(dir, "bin/promtool", "exit 0");
    const { out } = runVerify(dir);
    expect(out).toMatch(/^PASS +alert rules/m);
    expect(fs.readFileSync(path.join(dir, "promtool-seen.txt"), "utf8").trim()).toBe(path.join(dir, "bin", "promtool"));
  });

  itBash("builds the image when a Docker daemon is there, and fails when that build fails", () => {
    const ok = runVerify(verifyHarness(1, 1, "none", "yes"));
    expect(ok.out).toMatch(/^PASS +docker image build$/m);
    expect(ok.out).not.toMatch(/NOT AVAILABLE +docker/);
    expect(ok.status).toBe(0);
    const bad = runVerify(verifyHarness(1, 1, "none", "build-fails"));
    expect(bad.out).toMatch(/^FAIL +docker image build$/m);
    expect(bad.status).toBe(1);
  });

  itBash("fails when the test command itself fails even though a complete summary was printed", () => {
    const { status, out } = runVerify(verifyHarness(1, 1, "test"));
    expect(out).toMatch(/^FAIL +unit\/integration tests$/m);
    expect(status).toBe(1);
  });

  itNoPromtool("reports the alert-rule check as NOT AVAILABLE, not PASS, without promtool", () => {
    const { status, out } = runVerify(verifyHarness(1, 1));
    expect(out).toMatch(/^NOT AVAILABLE +alert rules \(set PROMTOOL=/m);
    expect(out).not.toMatch(/^PASS +alert rules/m);
    expect(status).toBe(0);
  });
});

describe("scripts/cleanroom.sh", () => {
  /** A git repository holding the real cleanroom.sh and a stub verify.sh that reports where it ran and what it could see. */
  function cleanroomRepo() {
    const repo = tmp("cleanroom-repo-");
    const bin = path.join(repo, "bin");
    fs.mkdirSync(path.join(repo, "scripts"));
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(root, "scripts/cleanroom.sh"), path.join(repo, "scripts/cleanroom.sh"));
    script(repo, "scripts/verify.sh", 'echo "stub verify: VERIFY_COMMIT=$VERIFY_COMMIT dir=$(pwd)"; echo "files: $(ls | tr "\\n" " ")"');
    script(repo, "bin/npm", 'echo "npm $*" >> "$NPM_LOG"; [ -z "${NPM_FAIL:-}" ]');
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TMPDIR: tmp("cleanroom-tmp-"),
      NPM_LOG: path.join(repo, "npm.log"),
      HOME: repo,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", env });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n");
    git("add", "scripts", "tracked.txt");
    git("commit", "-q", "-m", "first");
    const first = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "second.txt"), "added later\n");
    git("add", "second.txt");
    git("commit", "-q", "-m", "second");
    const second = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "leftover.txt"), "never committed\n"); // untracked: must not reach the clean room
    const run = (args: string[] = [], extraEnv: Record<string, string> = {}) => {
      const r = spawnSync("bash", ["scripts/cleanroom.sh", ...args], { cwd: repo, encoding: "utf8", timeout: 60000, env: { ...env, ...extraEnv } });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    return { repo, env, first, second, run };
  }

  itGit("tests the committed tree only, installs from the lockfile, names the commit and cleans up", () => {
    const c = cleanroomRepo();
    const { status, out } = c.run();
    expect(status).toBe(0);
    expect(out).toContain(`cleanroom: ${c.second} exported to `);
    expect(out).toContain(`VERIFY_COMMIT=${c.second}`);
    const files = /^files: (.*)$/m.exec(out)?.[1] ?? "";
    expect(files).toContain("tracked.txt");
    expect(files).toContain("second.txt");
    expect(files).not.toContain("leftover.txt");
    expect(fs.readFileSync(c.env.NPM_LOG, "utf8")).toMatch(/^npm ci /m);
    const dir = /dir=(\S+)/.exec(out)?.[1] ?? "";
    expect(dir).not.toBe("");
    expect(dir).not.toBe(c.repo);
    expect(fs.existsSync(dir)).toBe(false);
  });

  itGit("tests the commit it is given, not the checkout", () => {
    const c = cleanroomRepo();
    const { status, out } = c.run([c.first]);
    expect(status).toBe(0);
    expect(out).toContain(`VERIFY_COMMIT=${c.first}`);
    expect(/^files: (.*)$/m.exec(out)?.[1] ?? "").not.toContain("second.txt");
  });

  itGit("stops at a failed install instead of running the checks on a tree without its dependencies", () => {
    const { status, out } = cleanroomRepo().run([], { NPM_FAIL: "1" });
    expect(status).not.toBe(0);
    expect(out).not.toContain("stub verify");
  });

  itGit("refuses a commit that does not exist", () => {
    const { status, out } = cleanroomRepo().run(["no-such-ref"]);
    expect(status).not.toBe(0);
    expect(out).not.toContain("stub verify");
  });
});

describe("scripts/record-contracts.js", () => {
  // The recording itself needs the providers, which CI cannot be relied on to reach; its chain (record, then replay in
  // tests/gateway-contracts.test.ts) was run once with a stubbed fetch. Here: what it refuses before any request is made.
  const run = (args: string[], env: Record<string, string | undefined>) =>
    spawnSync("node", ["scripts/record-contracts.js", ...args], { encoding: "utf8", timeout: 30000, env: { ...process.env, ...env } });

  it("refuses to run without a User-Agent with contact details (Wikimedia asks for one)", () => {
    const r = run([], { GATEWAY_USER_AGENT: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("set GATEWAY_USER_AGENT");
  });

  it("refuses an unknown option and a --where without a value", () => {
    expect(run(["--force"], { GATEWAY_USER_AGENT: "t (t@example.org)" }).stderr).toContain("unknown option --force");
    expect(run(["--where"], { GATEWAY_USER_AGENT: "t (t@example.org)" }).status).toBe(2);
  });
});
