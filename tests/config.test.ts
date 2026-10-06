import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { RoutingPluginsMCP } from "../features/07-routing-plugins/src/mcp-server";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf-8");
const docs = (p: string): any[] => yaml.parseAllDocuments(read(p)).map((d) => d.toJS());
const pkg = JSON.parse(read("package.json"));
const dockerfile = read("Dockerfile");

describe.each(["k8s/staging-deployment.yaml", "k8s/production-deployment.yaml"])("%s", (file) => {
  const all = docs(file);
  const kind = (k: string) => all.find((d) => d.kind === k);
  const deployment = kind("Deployment");
  const container = deployment.spec.template.spec.containers[0];
  const ns = deployment.metadata.namespace;

  it("keeps every object in the same, declared namespace", () => {
    expect(kind("Namespace").metadata.name).toBe(ns);
    for (const d of all.filter((x) => x.kind !== "Namespace")) expect(d.metadata.namespace).toBe(ns);
  });

  it("wires the server env to what the code reads", () => {
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value ?? e.valueFrom]));
    expect(env.PORT).toBe(String(container.ports[0].containerPort));
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.AUTH_TOKEN.secretKeyRef).toEqual({ name: "increadible-secrets", key: "auth-token" });
  });

  it("warns about A/B data growth while the volume is still mostly empty (the data file is never compacted)", () => {
    // Memory does not grow with the file (running aggregates, guarded in tests/ab-golden.test.ts), so the volume is what fills up.
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    const warnBytes = Number(env.AB_DATA_WARN_BYTES);
    expect(warnBytes).toBeGreaterThan(0);
    const claim = kind("PersistentVolumeClaim");
    const unit: Record<string, number> = { Mi: 2 ** 20, Gi: 2 ** 30 };
    const [, size, u] = /^(\d+)(Mi|Gi)$/.exec(claim.spec.resources.requests.storage)!;
    const volumeBytes = Number(size) * unit[u];
    expect({ warnBytes, volumeBytes, early: warnBytes <= 0.25 * volumeBytes }).toMatchObject({ early: true });
  });

  it("is probed under the memory limit it deploys with, and smoke caps the heap, so the A/B memory regression checks cannot go slack", () => {
    // scripts/probe-image.sh starts the image with a large A/B data file under --memory=<limit>; if the manifests' limit moved and the
    // probe's did not, the probe would be checking a different container. scripts/smoke.sh does the same with a capped Node heap.
    const limitMiB = Number(/^(\d+)Mi$/.exec(container.resources.limits.memory)![1]);
    const probe = /--memory=(\d+)m\b/.exec(read("scripts/probe-image.sh"));
    expect(probe).not.toBeNull();
    expect(Number(probe![1])).toBe(limitMiB);
    const smoke = read("scripts/smoke.sh");
    expect(smoke).toMatch(/NODE_OPTIONS=--max-old-space-size=\d+/);
    expect(smoke).toContain("scripts/make-ab-data.js");
  });

  it("gives the kubelet more time to stop the pod than the server needs to drain and cut connections", () => {
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    const drainMs = Number(env.SHUTDOWN_DRAIN_MS);
    const cutMs = Number(env.SHUTDOWN_TIMEOUT_MS);
    const grace = deployment.spec.template.spec.terminationGracePeriodSeconds;
    expect(drainMs).toBeGreaterThan(0);
    expect(cutMs).toBeGreaterThan(0);
    expect(grace).toBeGreaterThan(0); // a SIGKILL from the kubelet would leave the A/B data file lock behind
    expect((drainMs + cutMs) / 1000).toBeLessThan(grace);
  });

  it("persists A/B data on a PersistentVolumeClaim mounted where AB_DATA_FILE points", () => {
    const dataPath = container.env.find((e: any) => e.name === "AB_DATA_FILE").value;
    const mount = container.volumeMounts.find((m: any) => dataPath.startsWith(m.mountPath + "/"));
    expect(mount).toBeDefined();
    expect(mount.readOnly).toBeUndefined();
    const vol = deployment.spec.template.spec.volumes.find((v: any) => v.name === mount.name);
    const pvc = kind("PersistentVolumeClaim");
    expect(vol.persistentVolumeClaim.claimName).toBe(pvc.metadata.name);
    expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(deployment.spec.strategy.type).toBe("Recreate"); // an RWO volume cannot be attached to two pods
    expect(deployment.spec.template.spec.securityContext.fsGroup).toBe(deployment.spec.template.spec.securityContext.runAsUser);
  });

  it("can pull a private GHCR image through an optional ghcr-pull secret that DEPLOYMENT.md tells you to create", () => {
    expect(deployment.spec.template.spec.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
    const doc = read("DEPLOYMENT.md");
    expect(doc).toContain("create secret docker-registry ghcr-pull --docker-server=ghcr.io");
    expect(doc).toContain("imagePullSecrets");
    expect(container.image.startsWith("ghcr.io/")).toBe(true);
  });

  it("probes endpoints the server actually serves, on the named container port", () => {
    expect(container.livenessProbe.httpGet).toEqual({ path: "/health", port: "http" });
    expect(container.readinessProbe.httpGet).toEqual({ path: "/ready", port: "http" });
    expect(container.ports[0].name).toBe("http");
    expect(read("src/index.ts")).toContain('"/health"');
    expect(read("src/index.ts")).toContain('"/ready"');
  });

  it("has a Service selecting the pods and exposing the named port", () => {
    const svc = kind("Service");
    expect(svc.spec.selector).toEqual(deployment.spec.template.metadata.labels);
    expect(svc.spec.ports[0].targetPort).toBe("http");
    expect(svc.spec.type).toBe("ClusterIP");
  });

  it("runs hardened and single-replica (state is in memory)", () => {
    expect(deployment.spec.replicas).toBe(1);
    expect(all.some((d) => d.kind === "HorizontalPodAutoscaler")).toBe(false);
    expect(deployment.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
    expect(deployment.spec.template.spec.serviceAccountName).toBe(kind("ServiceAccount").metadata.name);
  });

  it("mounts the ConfigMap that RULES_FILE points at, and the rules load and route correctly", () => {
    const rulesPath = container.env.find((e: any) => e.name === "RULES_FILE").value;
    const mount = container.volumeMounts.find((m: any) => rulesPath.startsWith(m.mountPath));
    expect(mount.readOnly).toBe(true);
    const vol = deployment.spec.template.spec.volumes.find((v: any) => v.name === mount.name);
    const cm = kind("ConfigMap");
    expect(vol.configMap.name).toBe(cm.metadata.name);
    expect(cm.data[path.basename(rulesPath)]).toBeDefined();

    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "cfg-"));
    const file = path.join(tmp, "rules.yaml");
    fs.writeFileSync(file, cm.data[path.basename(rulesPath)]);
    const router = new RoutingPluginsMCP(file);
    expect(router.getStats().enabled_rules).toBe(3);
    expect(router.applyRoutingRules({ task_type: "qa", task_complexity: "low" }).provider).toBe("claude-haiku");
    expect(router.applyRoutingRules({ task_type: "audit", priority: "critical" }).provider).toBe("claude-opus");
    expect(router.applyRoutingRules({ task_type: "development" }).provider).toBe("claude-sonnet");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("k8s/monitoring.yaml", () => {
  const all = docs("k8s/monitoring.yaml");
  const emitted = read("src/server.ts");

  it("only references increadible_* metrics that the server emits", () => {
    const exprs = JSON.stringify(all.find((d) => d.kind === "PrometheusRule"));
    const used = new Set(exprs.match(/increadible_[a-z_]+/g));
    expect(used.size).toBeGreaterThan(0);
    for (const metric of used) expect(emitted).toContain(metric);
  });

  it("has a firing case and a quiet case in the promtool unit tests for every alert, and none for a rule that is gone", () => {
    const rule = all.find((d) => d.kind === "PrometheusRule");
    const alerts: string[] = rule.spec.groups.flatMap((g: any) => g.rules.filter((r: any) => r.alert).map((r: any) => r.alert));
    const cases: any[] = yaml.parse(read("monitoring/alerts.test.yaml")).tests.flatMap((t: any) => t.alert_rule_test);
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      const mine = cases.filter((c) => c.alertname === alert);
      expect({ alert, hasFiringCase: mine.some((c) => c.exp_alerts.length > 0) }).toEqual({ alert, hasFiringCase: true });
      expect({ alert, hasQuietCase: mine.some((c) => c.exp_alerts.length === 0) }).toEqual({ alert, hasQuietCase: true });
    }
    for (const c of cases) expect(alerts).toContain(c.alertname);
  });

  it("is checked and unit-tested with promtool in CI, built from a pinned and checksummed Prometheus release", () => {
    const workflow = yaml.parse(read(".github/workflows/ci-cd.yml"));
    const runs = workflow.jobs.prometheus.steps.map((s: any) => s.run ?? "").join("\n");
    expect(runs).toContain("scripts/install-promtool.sh");
    expect(runs).toContain("scripts/check-prometheus.sh");
    const install = read("scripts/install-promtool.sh");
    expect(install).toMatch(/^VERSION=v0\.\d+\.\d+/m);
    expect(install).toMatch(/^SUM='h1:[A-Za-z0-9+/]+=*'/m);
    expect(install).toContain("GOWORK=off");
    expect(read("scripts/check-prometheus.sh")).toContain('"$PROMTOOL" test rules');
    expect(read("DEPLOYMENT.md")).toContain("scripts/check-prometheus.sh");
  });

  it("scrapes the Service port by name with the auth secret the Deployment uses", () => {
    const sm = all.find((d) => d.kind === "ServiceMonitor");
    expect(sm.spec.endpoints[0].port).toBe("http");
    expect(sm.spec.endpoints[0].authorization.credentials).toEqual({ name: "increadible-secrets", key: "auth-token" });
    expect(sm.metadata.namespace).toBe("increadible");
  });
});

describe("Dockerfile and package.json", () => {
  it("starts the file that the build produces", () => {
    expect(pkg.scripts.start).toBe("node dist/src/index.js");
    expect(pkg.main).toBe("dist/src/index.js");
    expect(dockerfile).toContain('CMD ["node", "dist/src/index.js"]');
    expect(read("tsconfig.build.json")).toContain("src/**/*.ts");
  });

  it("persists A/B data under the writable /data volume in the image", () => {
    expect(dockerfile).toMatch(/AB_DATA_FILE=\/data\/ab-data\.jsonl/);
    expect(dockerfile).toMatch(/chown node:node \/data/);
  });

  it("copies every script the build command runs into the image's builder stage", () => {
    const referenced = [...pkg.scripts.build.matchAll(/scripts\/[\w.-]+/g)].map((m: RegExpMatchArray) => m[0]);
    expect(referenced.length).toBeGreaterThan(0);
    const builder = dockerfile.slice(dockerfile.indexOf("AS builder"), dockerfile.indexOf("# ---- runtime ----"));
    for (const file of referenced) {
      expect(builder).toMatch(new RegExp(`COPY\\s+${file.replace(/[.]/g, "\\.")}\\s`));
    }
  });

  it("pins one Node major in both image stages, in every CI setup-node step and in @types/node, inside the engines range", () => {
    const images = [...dockerfile.matchAll(/^FROM node:(\d+)-alpine/gm)].map((m) => Number(m[1]));
    expect(images).toHaveLength(2);
    const wf: any = yaml.parse(read(".github/workflows/ci-cd.yml"));
    const ci: number[] = Object.values<any>(wf.jobs).flatMap((job) =>
      (job.steps ?? [])
        .filter((s: any) => /^actions\/setup-node@/.test(s.uses ?? ""))
        .map((s: any) => Number(s.with["node-version"]))
    );
    expect(ci.length).toBeGreaterThan(0);
    const major = images[0];
    expect(new Set([...images, ...ci])).toEqual(new Set([major]));
    expect(Number(/(\d+)/.exec(pkg.devDependencies["@types/node"])![1])).toBe(major);
    expect(major).toBeGreaterThanOrEqual(Number(/(\d+)/.exec(pkg.engines.node)![1]));
  });

  it("documents every A/B data file env var the code reads, and the lock", () => {
    const code = read("features/08-ab-testing/src/mcp-server.ts");
    const deployment = read("DEPLOYMENT.md");
    for (const name of ["AB_DATA_FILE", "AB_FSYNC", "AB_DATA_WARN_BYTES"]) {
      expect(code).toContain(`process.env.${name}`);
      expect(deployment).toContain(name);
      expect(read("README.md")).toContain(name);
    }
    expect(deployment).toContain(".lock");
    expect(read("src/index.ts")).toMatch(/process\.on\("SIGTERM"/); // stdio mode must release the lock on SIGTERM too
  });

  it("documents every HTTP hardening env var the code reads", () => {
    const code = read("src/index.ts");
    for (const name of ["HTTP_HEADERS_TIMEOUT_MS", "HTTP_REQUEST_TIMEOUT_MS", "RATE_LIMIT_PER_MINUTE", "SHUTDOWN_DRAIN_MS", "SHUTDOWN_TIMEOUT_MS", "ALLOW_UNAUTHENTICATED"]) {
      expect(code).toContain(name);
      expect(read("DEPLOYMENT.md")).toContain(name);
      expect(read("README.md")).toContain(name);
    }
  });

  it("probes the HTTP hardening with real processes and in the real image", () => {
    const smoke = read("scripts/smoke.sh");
    expect(smoke).toContain("query must be a string");
    expect(smoke).toContain("Refusing to listen");
    expect(smoke).toContain("SHUTDOWN_DRAIN_MS");
    expect(smoke).toContain("deadline passed");
    expect(smoke).toContain("increadible_tool_call_duration_seconds_count");
    expect(smoke).toContain('reason="unauthorized"');
    const probe = read("scripts/probe-image.sh");
    expect(probe).toContain('"name":"discover_apis","arguments":{"query":123}');
    expect(probe).toContain("Refusing to listen");
    expect(probe).toContain('docker stop -t 20 "$B"');
    expect(probe).toContain("increadible_tool_call_duration_seconds_count");
    expect(probe).toContain("ab-data.jsonl.lock");
  });

  it("probes the A/B data file lock in a real container: hard kill with fsync on, and a second container refused", () => {
    const probe = read("scripts/probe-image.sh");
    expect(probe).toContain("-e AB_FSYNC=1");
    expect(probe).toContain('docker wait "$C"');
    expect(probe).toMatch(/in use by pid\|could not be checked from here/);
    expect(read("scripts/smoke.sh")).toContain("kill -KILL");
  });

  it("never pipes into `grep -q` in a pipefail script (SIGPIPE makes a correct match report failure)", () => {
    // `cmd | grep -q x` under pipefail exits 141 when cmd is still writing after the first match: it failed the real-container
    // probe in CI although the container had logged exactly the expected refusal. Capture the output, then match the variable.
    const dir = path.join(root, "scripts");
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sh"))) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      if (!/pipefail/.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        if (/\|\s*grep\s+(-[A-Za-z]*q|--quiet)/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("uses a tracked lockfile for reproducible installs", () => {
    expect(fs.existsSync(path.join(root, "package-lock.json"))).toBe(true);
    expect(read(".gitignore")).not.toMatch(/^package-lock\.json$/m);
    expect(dockerfile).toContain("npm ci");
  });

  it("exposes the port the server defaults to and runs as non-root", () => {
    expect(dockerfile).toMatch(/PORT=3000/);
    expect(dockerfile).toMatch(/EXPOSE 3000/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it("has no dependency on the unused Anthropic SDK", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["yaml"]);
  });
});

describe(".github/workflows/ci-cd.yml", () => {
  const wf: any = yaml.parse(read(".github/workflows/ci-cd.yml"));
  const docker = wf.jobs.docker;
  const verify = wf.jobs["verify-published-image"];
  const allRuns = (job: any) => job.steps.map((s: any) => s.run ?? "").join("\n");

  it("only references scripts that exist", () => {
    const refs = [...JSON.stringify(wf).matchAll(/scripts\/[a-z-]+\.sh/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of new Set(refs)) expect(fs.existsSync(path.join(root, r))).toBe(true);
  });

  it("probes the locally built image before anything is pushed", () => {
    const names = docker.steps.map((s: any) => s.name ?? s.uses);
    const probe = names.findIndex((n: string) => /Probe the image/.test(n));
    const push = names.findIndex((n: string) => n === "Push image");
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(push);
    expect(allRuns(docker)).toContain("scripts/probe-image.sh increadible:ci");
  });

  it("hands the pushed digest from the push step to the verify job", () => {
    const pushStep = docker.steps.find((s: any) => s.name === "Push image");
    expect(pushStep.id).toBe("push");
    expect(docker.outputs.digest).toBe("${{ steps.push.outputs.digest }}");
    expect(verify.needs).toBe("docker");
    expect(verify.env.DIGEST).toBe("${{ needs.docker.outputs.digest }}");
  });

  it("verifies the published image by digest, only on pushes to main, with read-only package access", () => {
    expect(verify.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(verify.permissions).toEqual({ contents: "read", packages: "read" });
    const runs = allRuns(verify);
    expect(runs).toContain('docker pull "$IMAGE@$DIGEST"');
    expect(runs).toContain('scripts/probe-image.sh "$IMAGE@$DIGEST"');
    expect(runs).toContain("imagetools inspect");
  });

  it("does not mask failures with continue-on-error", () => {
    expect(read(".github/workflows/ci-cd.yml")).not.toContain("continue-on-error");
  });

  it("generates a CycloneDX SBOM of the production dependency tree after npm ci, rejects an empty one, and keeps it", () => {
    const steps: any[] = wf.jobs.security.steps;
    const install = steps.findIndex((s) => s.run === "npm ci");
    const generate = steps.findIndex((s) => /npm sbom --omit=dev --sbom-format cyclonedx/.test(s.run ?? ""));
    expect(install).toBeGreaterThan(-1);
    expect(generate).toBeGreaterThan(install);
    expect(allRuns(wf.jobs.security)).toContain("bomFormat !== 'CycloneDX'");
    const upload = steps.find((s) => /^actions\/upload-artifact@/.test(s.uses ?? "") && s.with?.name === "sbom-npm");
    expect(upload).toBeDefined();
    expect(upload.with["if-no-files-found"]).toBe("error");
  });

  it("attaches an SBOM attestation to the pushed image and does not disable provenance", () => {
    const push = docker.steps.find((s: any) => s.name === "Push image");
    expect(push.with.sbom).toBe(true);
    expect([undefined, true, "true"].concat(["mode=min", "mode=max"])).toContain(push.with.provenance);
  });
});

describe(".github/dependabot.yml", () => {
  const cfg: any = yaml.parse(read(".github/dependabot.yml"));
  const updates: any[] = cfg.updates;
  const forEcosystem = (name: string) => updates.find((u) => u["package-ecosystem"] === name);

  it("covers npm, github-actions and docker from the repository root and aims at main", () => {
    expect(cfg.version).toBe(2);
    expect(updates.map((u) => u["package-ecosystem"]).sort()).toEqual(["docker", "github-actions", "npm"]);
    for (const u of updates) {
      expect(u.directory).toBe("/");
      expect(u["target-branch"]).toBe("main");
    }
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "Dockerfile"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".github/workflows"))).toBe(true);
  });

  it("never proposes major bumps of npm packages or of the Node base image (the Node major is pinned by a test)", () => {
    const major = "version-update:semver-major";
    expect(forEcosystem("npm").ignore).toContainEqual({ "dependency-name": "*", "update-types": [major] });
    expect(forEcosystem("docker").ignore).toContainEqual({ "dependency-name": "node", "update-types": [major] });
  });
});

describe("repository hygiene", () => {
  it("declares every submodule path in .gitmodules and has the directory", () => {
    const paths = [...read(".gitmodules").matchAll(/path = (.+)/g)].map((m) => m[1]);
    expect(paths.length).toBe(6);
    for (const p of paths) expect(fs.existsSync(path.join(root, p))).toBe(true);
  });

  it("keeps an integration guide for every feature directory", () => {
    for (const dir of fs.readdirSync(path.join(root, "features"))) {
      expect(fs.existsSync(path.join(root, "features", dir, "INTEGRATION_GUIDE.md"))).toBe(true);
    }
  });

  it("stays buildable and checkable on Windows (no rm, LF endings, tracked clean script)", () => {
    expect(pkg.scripts.build).not.toMatch(/\brm\b/);
    expect(pkg.scripts.build).toContain("scripts/clean.js");
    expect(fs.existsSync(path.join(root, "scripts/clean.js"))).toBe(true);
    expect(read(".gitignore")).toContain("!scripts/*.js");
    const attrs = read(".gitattributes");
    expect(attrs).toMatch(/\*\s+text=auto\s+eol=lf/);
    expect(attrs).toMatch(/\*\.sh\s+text\s+eol=lf/);
  });

  it("keeps ROADMAP.md present, linked from the README, and listing owner decisions", () => {
    expect(fs.existsSync(path.join(root, "ROADMAP.md"))).toBe(true);
    expect(read("README.md")).toContain("(ROADMAP.md)");
    const roadmap = read("ROADMAP.md");
    expect(roadmap).toContain("## Open decisions");
    expect(roadmap).toContain("NOT VERIFIED");
  });

  it("has no unmeasured headline claims left in the docs", () => {
    const text = [read("README.md"), read("DEPLOYMENT.md")].join("\n");
    expect(text).not.toMatch(/PRODUCTION DEPLOYMENT AUTHORIZED|1000\+ APIs|99\.98% (cost )?(reduction|savings|optimization)/i);
  });
});

describe("CLAUDE.md and CHANGELOG.md", () => {
  const claude = read("CLAUDE.md");
  const changelog = read("CHANGELOG.md");
  const sourceDirs = ["src", "features/07-routing-plugins/src", "features/08-ab-testing/src", "features/09-api-gateway/src"];
  const sources = sourceDirs
    .flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".ts")).map((f) => read(`${d}/${f}`)))
    .join("\n");

  it("names every environment variable the code reads, and only those", () => {
    const used = new Set([...sources.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g), ...sources.matchAll(/envInt\("([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]));
    const section = /Configuration \(names only[^\n]*\n(?:[^\n]+\n)*/.exec(claude);
    expect(section).not.toBeNull();
    const listed = new Set([...section![0].matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual([...listed].sort());
  });

  it("mentions only npm scripts and files that exist, and describes every CI job", () => {
    const scripts = pkg.scripts as Record<string, string>;
    for (const m of claude.matchAll(/npm run ([a-z:-]+)/g)) expect({ script: m[1], exists: m[1] in scripts }).toEqual({ script: m[1], exists: true });
    for (const m of claude.matchAll(/(?:scripts|monitoring|k8s)\/[A-Za-z0-9._-]+/g)) {
      expect({ file: m[0], exists: fs.existsSync(path.join(root, m[0])) }).toEqual({ file: m[0], exists: true });
    }
    const jobs = Object.keys(yaml.parse(read(".github/workflows/ci-cd.yml")).jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect({ job, described: claude.includes("`" + job + "`") }).toEqual({ job, described: true });
  });

  it("PERFORMANCE.md names only commands and files that exist, is linked, and quotes the warning threshold the manifests set", () => {
    const perf = read("PERFORMANCE.md");
    const scripts = pkg.scripts as Record<string, string>;
    for (const m of perf.matchAll(/npm run ([a-z:-]+)/g)) expect({ script: m[1], exists: m[1] in scripts }).toEqual({ script: m[1], exists: true });
    for (const m of perf.matchAll(/scripts\/[A-Za-z0-9._-]+/g)) expect({ file: m[0], exists: fs.existsSync(path.join(root, m[0])) }).toEqual({ file: m[0], exists: true });
    for (const doc of ["README.md", "CLAUDE.md"]) expect({ doc, links: read(doc).includes("PERFORMANCE.md") }).toEqual({ doc, links: true });
    for (const file of ["k8s/staging-deployment.yaml", "k8s/production-deployment.yaml"]) {
      const container = docs(file).find((d) => d.kind === "Deployment").spec.template.spec.containers[0];
      const warn = Number(container.env.find((e: any) => e.name === "AB_DATA_WARN_BYTES").value);
      expect(perf).toContain(`${warn / 2 ** 20} MiB`);
    }
  });

  it("holds no secret-looking value", () => {
    for (const doc of [claude, changelog]) expect(doc).not.toMatch(/(ghp_|github_pat_|AKIA[0-9A-Z]{12}|-----BEGIN|Bearer [A-Za-z0-9._-]{10,})/);
    expect(claude).not.toMatch(/AUTH_TOKEN=\S/);
  });

  it("has an Unreleased section and mentions every pull request the roadmap lists as done", () => {
    expect(changelog).toMatch(/^## \[Unreleased\]/m);
    const listed = [...read("ROADMAP.md").matchAll(/^\d+\. \*\*\[PR #(\d+)\]/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(5);
    for (const n of listed) expect({ pr: n, inChangelog: changelog.includes(`pull/${n})`) }).toEqual({ pr: n, inChangelog: true });
  });

  it("is linked from the README, and the ROADMAP no longer lists either as missing", () => {
    expect(read("README.md")).toContain("CLAUDE.md");
    expect(read("README.md")).toContain("CHANGELOG.md");
    expect(read("ROADMAP.md")).not.toMatch(/no CHANGELOG|no `CLAUDE\.md`/);
  });
});
