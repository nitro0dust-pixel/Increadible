import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { RoutingPluginsMCP } from "../features/07-routing-plugins/src/mcp-server";
import { fsyncFromEnv } from "../features/08-ab-testing/src/mcp-server";
import { bitwiseCrc32, readZip } from "./helpers/zip";

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

  it("flushes every A/B append to disk (the owner's AB_FSYNC decision), with a value the code actually reads as on", () => {
    // The image and the code default to off. A value such as "on" would be silently read as off, so the manifest value is checked
    // against the code's own parser, not against a copy of its regex.
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    expect({ value: env.AB_FSYNC, on: fsyncFromEnv(env.AB_FSYNC) }).toEqual({ value: env.AB_FSYNC, on: true });
  });

  it("keeps live API gateway calls off: no manifest sets GATEWAY_LIVE_APIS or a gateway key (enabling them is the owner's decision)", () => {
    const names = container.env.map((e: any) => e.name as string);
    expect(names.filter((n: string) => n === "GATEWAY_LIVE_APIS" || n.startsWith("GATEWAY_KEY_"))).toEqual([]);
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

  it("gives a pod that replays a full volume of A/B data time to start before the liveness probe can restart it", () => {
    // Startup replays the whole data file before the HTTP port opens. Measured (PERFORMANCE.md, Node 24): 120 bytes per measurement on
    // disk, and 2.6 microseconds per measurement to replay at about half a core, the CPU limit below. If the limit changes, measure again.
    const DISK_BYTES_PER_MEASUREMENT = 120;
    const REPLAY_SECONDS_PER_MEASUREMENT_AT_HALF_CPU = 2.6e-6;
    expect(container.resources.limits.cpu).toBe("500m");
    const unit: Record<string, number> = { Mi: 2 ** 20, Gi: 2 ** 30 };
    const [, size, u] = /^(\d+)(Mi|Gi)$/.exec(kind("PersistentVolumeClaim").spec.resources.requests.storage)!;
    const replaySeconds = ((Number(size) * unit[u]) / DISK_BYTES_PER_MEASUREMENT) * REPLAY_SECONDS_PER_MEASUREMENT_AT_HALF_CPU;
    const probe = container.startupProbe;
    expect(probe?.httpGet).toEqual({ path: "/health", port: "http" });
    const windowSeconds = probe.periodSeconds * probe.failureThreshold;
    expect({ windowSeconds, fullVolumeReplaySeconds: Math.round(replaySeconds), fourTimes: windowSeconds >= 4 * replaySeconds }).toMatchObject({ fourTimes: true });
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

  // That every increadible_* metric the rules use is really emitted is checked against the rendered /metrics output in tests/server.test.ts.

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
    expect(smoke).toContain("increadible_event_loop_delay_seconds_count");
    expect(smoke).toContain('kill -STOP "$PID"'); // a stalled process must show as a late tick
    const probe = read("scripts/probe-image.sh");
    expect(probe).toContain('"name":"discover_apis","arguments":{"query":123}');
    expect(probe).toContain("Refusing to listen");
    expect(probe).toContain('docker stop -t 20 "$B"');
    expect(probe).toContain('docker pause "$A"'); // a stalled container must show as a late tick
    expect(probe).toContain("increadible_event_loop_delay_seconds_count");
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

  it("README states the number of vendored projects that .gitmodules declares, and lists each of them", () => {
    const paths = [...read(".gitmodules").matchAll(/^\s*path\s*=\s*(\S+)/gm)].map((m) => m[1]);
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
    expect(paths.length).toBeGreaterThan(0);
    const readme = read("README.md");
    expect(readme).toContain(`vendors ${words[paths.length]} third-party projects`);
    for (const p of paths) expect(readme).toContain(`submodule \`${p}\``);
  });

  it("documents every file in scripts/ (by name in a document, or through the npm script that runs it)", () => {
    const docs = ["README.md", "CLAUDE.md", "DEPLOYMENT.md", "PERFORMANCE.md"].map(read).join("\n");
    const pkg = read("package.json");
    const undocumented = fs.readdirSync(path.join(root, "scripts")).filter((f) => !docs.includes(f) && !pkg.includes(`scripts/${f}`));
    expect(undocumented).toEqual([]);
  });

  it("is proprietary (owner decision, 2026-10-09): package.json says UNLICENSED and private, LICENSE reserves all rights for the author", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.license).toBe("UNLICENSED"); // npm's marker for "no licence granted"
    expect(pkg.private).toBe(true); // npm refuses to publish it
    const license = read("LICENSE");
    expect(license).toMatch(new RegExp(`^Copyright \\(c\\) 2026 ${pkg.author}\\. All rights reserved\\.\\n`));
    expect(license).not.toMatch(/Permission is hereby granted|MIT License/);
    // the notice must travel with every copy, and the image is a copy
    const runtime = dockerfile.slice(dockerfile.indexOf("# ---- runtime ----"));
    expect(runtime).toMatch(/^COPY .*\bLICENSE\b/m);
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

  it("runs the secret scanner from an image pinned by digest, never the moving latest (audit D-5)", () => {
    const scan = wf.jobs.security.steps.find((s: any) => /^trufflesecurity\/trufflehog@/.test(s.uses ?? ""));
    expect(scan).toBeDefined();
    expect(String(scan.with?.version)).toMatch(/^\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

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

  it("cancels a superseded run on a pull request but never a run on main", () => {
    // Two quick merges would otherwise cancel the first merge's run midway: no image push, no verification by digest, no record.
    expect(wf.concurrency.group).toBe("ci-${{ github.ref }}");
    expect(wf.concurrency["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/main' }}");
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

describe("API gateway live mode is documented", () => {
  const gateway = read("features/09-api-gateway/src/mcp-server.ts");
  const deployment = read("DEPLOYMENT.md");

  it("names every gateway variable the code reads in README.md and DEPLOYMENT.md", () => {
    for (const name of ["GATEWAY_LIVE_APIS", "GATEWAY_TIMEOUT_MS", "GATEWAY_MAX_RESPONSE_BYTES", "GATEWAY_USER_AGENT"]) {
      expect({ name, read: gateway.includes(`process.env.${name}`) }).toEqual({ name, read: true });
      expect({ name, deployment: deployment.includes(name), readme: read("README.md").includes(name) }).toEqual({ name, deployment: true, readme: true });
    }
  });

  it("names every credential variable and every host the registry uses in DEPLOYMENT.md (the egress advice depends on the hosts)", () => {
    const credentials = [...gateway.matchAll(/env: "(GATEWAY_KEY_[A-Z0-9_]+)"/g)].map((m) => m[1]);
    const hosts = [...gateway.matchAll(/endpoint: "https:\/\/([^/"]+)/g)].map((m) => m[1]);
    expect(credentials).toHaveLength(4);
    expect(hosts).toHaveLength(9);
    for (const name of [...credentials, ...hosts]) expect({ name, documented: deployment.includes(name) }).toEqual({ name, documented: true });
  });
});

describe("COMPANIONS.md", () => {
  const doc = read("COMPANIONS.md");

  it("is linked from README.md and CLAUDE.md", () => {
    expect(read("README.md")).toContain("COMPANIONS.md");
    expect(read("CLAUDE.md")).toContain("COMPANIONS.md");
  });

  it("names only vendored folders that exist, and states that nothing here is a dependency of the repository", () => {
    const paths = [...doc.matchAll(/`(features\/0[1-6]-[a-z-]+\/[A-Za-z0-9._-]+)`/g)].map((m) => m[1]); // two-level folders, not the range features/01-06
    expect(paths.length).toBeGreaterThan(4);
    for (const p of paths) expect({ path: p, exists: fs.existsSync(path.join(root, p)) }).toEqual({ path: p, exists: true });
    expect(doc).toContain("Nothing here is a dependency of this repository");
  });

  it("keeps its honesty markers and claims no saving: untried companions are NOT VERIFIED and the savings measurement is BLOCKED", () => {
    expect(doc).toContain("NOT VERIFIED");
    expect(doc).toContain("**BLOCKED**");
    expect(doc).toMatch(/No saving is claimed/);
    // the one place a saving could be quoted as a result is a percentage or a dollar figure next to the word saving
    expect(doc).not.toMatch(/saving[s]? (of|is|was|are|were) [~$]?\d/i);
  });
});

describe("GATEWAY.md", () => {
  const doc = read("GATEWAY.md");

  it("is linked from README.md, CLAUDE.md and ROADMAP.md", () => {
    for (const f of ["README.md", "CLAUDE.md", "ROADMAP.md"]) expect({ file: f, links: read(f).includes("GATEWAY.md") }).toEqual({ file: f, links: true });
  });

  it("says it is a proposal waiting on the owner and that nothing was built, and keeps its NOT VERIFIED list", () => {
    expect(doc).toContain("**Status: PROPOSED. Waiting for the owner's decision. Nothing has been built from it.**");
    expect(doc).toContain("NOT VERIFIED");
    expect(doc).toContain("## Not verified");
    expect(doc).toContain("## Decisions requested from the owner");
    // the decisions stay unticked until the owner makes them
    expect(doc.split("## Decisions requested from the owner")[1]).not.toMatch(/- \[x\]/i);
  });

  it("states the size of the registry it is a proposal to change", () => {
    const registered = (read("features/09-api-gateway/src/mcp-server.ts").match(/^\s*id: "[a-z]+",\s*\n\s*name:/gm) ?? []).length;
    expect(registered).toBe(9);
    expect(doc).toContain(`${registered} registered APIs`);
  });
});

describe("lint and test tooling", () => {
  const pkg = JSON.parse(read("package.json"));

  it("lints with a flat config; the old .eslintrc.json is gone and the removed --ext flag is not used", () => {
    expect(fs.existsSync(path.join(root, "eslint.config.mjs"))).toBe(true); // .mjs: .gitignore ignores every other *.js
    expect(fs.existsSync(path.join(root, ".eslintrc.json"))).toBe(false);
    expect(pkg.scripts.lint).toMatch(/^eslint /);
    expect(pkg.scripts.lint).not.toContain("--ext");
    const config = read("eslint.config.mjs");
    // the two rules the old config switched off stay off (the second was called no-var-requires)
    expect(config).toContain('"@typescript-eslint/no-explicit-any": "off"');
    expect(config).toContain('"@typescript-eslint/no-require-imports": "off"');
    expect(Object.keys(pkg.devDependencies)).not.toContain("@typescript-eslint/eslint-plugin");
  });

  it("keeps TypeScript below the major that ts-jest 29 and typescript-eslint 8 do not support yet", () => {
    // ts-jest 29.4 accepts TypeScript <7 and typescript-eslint 8.71 accepts <6.1: raise this only after checking both.
    const installed: string = JSON.parse(fs.readFileSync(path.join(root, "node_modules/typescript/package.json"), "utf8")).version;
    expect(Number(installed.split(".")[0])).toBeLessThan(6);
    expect(pkg.devDependencies.typescript).toMatch(/^\^5\./);
  });

  it("throws inside catch blocks keep their cause, except where the cause could carry a credential", () => {
    // eslint 10's preserve-caught-error found three throws; the two in the gateway are deliberate and say why.
    const gateway = read("features/09-api-gateway/src/mcp-server.ts");
    expect((gateway.match(/eslint-disable-next-line preserve-caught-error/g) ?? []).length).toBe(2);
    expect(gateway).toContain("could carry a");
    expect(read("features/08-ab-testing/src/mcp-server.ts")).toContain("{ cause: error }");
  });
});

describe("AUDIT.md", () => {
  const doc = read("AUDIT.md");

  it("is linked from README.md, CLAUDE.md and ROADMAP.md", () => {
    for (const f of ["README.md", "CLAUDE.md", "ROADMAP.md"]) expect({ file: f, links: read(f).includes("AUDIT.md") }).toEqual({ file: f, links: true });
  });

  it("is finished: nothing left to do in it, and it keeps its list of what was not verified and the decisions it asks of the owner", () => {
    expect(doc).not.toMatch(/TODO\(/);
    expect(doc).toContain("NOT VERIFIED");
    expect(doc).toContain("## 5. Not verified, and blocked on the owner");
    expect(doc).toContain("## 8. Decisions the owner is asked for");
    // the decisions stay unticked until the owner makes them
    expect(doc.split("## 8. Decisions the owner is asked for")[1]).not.toMatch(/- \[x\]/i);
  });

  it("names every test file the mutation-testing section says it added, and each exists", () => {
    const named = [...doc.matchAll(/`(tests\/[a-z0-9-]+\.test\.ts)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const file of new Set(named)) expect({ file, exists: fs.existsSync(path.join(root, file)) }).toEqual({ file, exists: true });
  });
});

describe("the documentation set", () => {
  /** Every markdown file that is ours: not vendored (features/), not installed, not built, and not a synced copy inside the skill. */
  const ownDocuments = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (["node_modules", "features", "dist", "coverage", ".git"].includes(entry.name) || rel === "skills/omniroute-mcp/references") continue;
          walk(rel);
        } else if (entry.name.endsWith(".md")) found.push(rel);
      }
    };
    walk("");
    return found.sort();
  };
  const index = read("docs/README.md");
  /** The link target that docs/README.md must hold for a document. */
  const targetFrom = (file: string) => (file.startsWith("docs/") ? file.slice(5) : `../${file}`);

  it("lists every document of the repository in docs/README.md, and every link in it points at a file that exists", () => {
    for (const file of ownDocuments()) {
      if (file === "docs/README.md") continue;
      expect({ file, listed: index.includes(`](${targetFrom(file)})`) }).toEqual({ file, listed: true });
    }
    for (const [, target] of index.matchAll(/\]\(([^)#]+?)\)/g)) {
      if (/^https?:/.test(target)) continue;
      expect({ target, exists: fs.existsSync(path.join(root, "docs", target)) }).toEqual({ target, exists: true });
    }
  });

  it("has the documents a person needs from nothing to a running Claude Desktop", () => {
    for (const file of ["README.md", "ROADMAP.md", "docs/INSTALL-CLAUDE-DESKTOP.md", "docs/TROUBLESHOOTING.md", "docs/ARCHITECTURE.md", "docs/BUILD-HISTORY.md", "DEPLOYMENT.md", "CONTRIBUTING.md", "SECURITY.md", "CLAUDE.md", "CHANGELOG.md", ".github/pull_request_template.md"]) {
      expect({ file, exists: fs.existsSync(path.join(root, file)) }).toEqual({ file, exists: true });
    }
    for (const file of ["README.md", "CLAUDE.md"]) expect({ file, links: read(file).includes("docs/README.md") }).toEqual({ file, links: true });
  });

  it("names only npm scripts, script files and settings that exist", () => {
    const own = ownDocuments().filter((f) => f.startsWith("docs/") || ["CONTRIBUTING.md", "SECURITY.md"].includes(f));
    const sources = ["src/index.ts", "src/server.ts", "features/07-routing-plugins/src/mcp-server.ts", "features/08-ab-testing/src/mcp-server.ts", "features/09-api-gateway/src/mcp-server.ts"].map(read).join("\n");
    for (const file of own) {
      const text = read(file);
      for (const [, script] of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) expect({ file, script, exists: script in pkg.scripts }).toEqual({ file, script, exists: true });
      for (const [, name] of text.matchAll(/`(scripts\/[A-Za-z0-9._/-]+?)`/g)) expect({ file, name, exists: fs.existsSync(path.join(root, name)) }).toEqual({ file, name, exists: true });
      for (const [, name] of text.matchAll(/`((?:AB|GATEWAY|HTTP|RATE|SHUTDOWN|RULES|EXPERIMENTS|ALLOW)_[A-Z0-9_]+)`/g)) {
        if (name === "GATEWAY_KEY_") continue;
        expect({ file, name, readByCode: sources.includes(name) }).toEqual({ file, name, readByCode: true });
      }
    }
  });

  it("tells the reader about all 13 tools by their real names, and what is not verified", () => {
    const tools = [...[
      "features/07-routing-plugins/src/mcp-server.ts",
      "features/08-ab-testing/src/mcp-server.ts",
      "features/09-api-gateway/src/mcp-server.ts",
    ].map(read).join("\n").matchAll(/^ {2}name: "([a-z]+(?:_[a-z]+)+)",$/gm)].map((m) => m[1]);
    expect(tools).toHaveLength(13);
    const guide = read("docs/INSTALL-CLAUDE-DESKTOP.md");
    for (const tool of tools) expect({ tool, named: guide.includes(`\`${tool}\``) }).toEqual({ tool, named: true });
    expect(guide).toContain("NOT VERIFIED");
    expect(guide).toContain("claude_desktop_config.json");
    expect(read("docs/TROUBLESHOOTING.md")).toContain("NOT VERIFIED");
  });

  it("records every pull request that ROADMAP.md lists as done, in order, in docs/BUILD-HISTORY.md", () => {
    const history = read("docs/BUILD-HISTORY.md");
    const listed = [...read("ROADMAP.md").matchAll(/^\d+\. \*\*\[PR #(\d+)\]/gm)].map((m) => Number(m[1]));
    const recorded = [...history.matchAll(/^\| \d+ \| [^|]+ \| \[#(\d+)\]/gm)].map((m) => Number(m[1]));
    expect(listed.length).toBeGreaterThan(20);
    for (const pr of listed) expect({ pr, recorded: recorded.includes(pr) }).toEqual({ pr, recorded: true });
    expect([...recorded].sort((a, b) => a - b)).toEqual(recorded); // merged order is number order here
    expect(history).toContain("## 5. How to add a step");
  });

  it("has a pull request template that asks for the record to be updated, the skill included", () => {
    const template = read(".github/pull_request_template.md");
    expect(template).toContain("node scripts/skill.js sync");
    expect(template).toContain("docs/BUILD-HISTORY.md");
    expect(template).toContain("## Not verified");
  });
});

describe("the global skill omniroute-mcp", () => {
  const skill = require("../scripts/skill.js");
  const skillDir = path.join(root, "skills", "omniroute-mcp");
  const text = read("skills/omniroute-mcp/SKILL.md");
  const tmp = () => fs.mkdtempSync(path.join(require("os").tmpdir(), "skill-"));

  it("is sound and in step with the documents it carries (node scripts/skill.js check)", () => {
    expect(skill.problems()).toEqual([]);
  });

  it("carries every reference file and nothing else, and SKILL.md points to each", () => {
    const refs = fs.readdirSync(path.join(skillDir, "references")).sort();
    expect(refs).toEqual(Object.values(skill.REFERENCES as Record<string, string>).sort());
    for (const ref of refs) expect(text).toContain(`references/${ref}`);
  });

  it("has front matter a skill loader accepts: the name of its folder, a description of at most 1024 characters, no angle brackets", () => {
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)!;
    expect(front).not.toBeNull();
    expect(front[1]).toMatch(/^name: omniroute-mcp$/m);
    const description = front[1].match(/^description: "(.*)"$/m)![1];
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);
    expect(description).toMatch(/Claude Desktop/);
  });

  it("warns that OmniRoute is the vendored third-party project, not what was built", () => {
    expect(text).toMatch(/OmniRoute\*\* \| A \*\*third-party\*\* project/);
    expect(text).toContain("features/01-omniroute");
  });

  it("names the last merged pull request of the build history, and states what is not verified", () => {
    const recorded = [...read("docs/BUILD-HISTORY.md").matchAll(/^\| \d+ \| [^|]+ \| \[#(\d+)\]/gm)].map((m) => Number(m[1]));
    expect(text).toContain(`| Last merged PR | #${Math.max(...recorded)} |`);
    expect(text).toContain("## Update protocol: after every step, without exception");
    expect(text).toContain("NOT VERIFIED");
    expect(text).toContain("## Status at a glance");
  });

  it("is detected as out of step when a copy is edited, and when a reference is missing", () => {
    const ref = path.join(skillDir, "references", "troubleshooting.md");
    const original = fs.readFileSync(ref, "utf8");
    try {
      fs.writeFileSync(ref, original + "\nedited by hand\n");
      expect(skill.problems().join("\n")).toContain("references/troubleshooting.md differs from docs/TROUBLESHOOTING.md");
    } finally {
      fs.writeFileSync(ref, original);
    }
    expect(skill.problems()).toEqual([]);
  });

  it("computes CRC-32 as the standard defines it (the published check value for \"123456789\", and the empty input)", () => {
    expect(skill.crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(skill.crc32(Buffer.alloc(0))).toBe(0);
    expect(skill.crc32(Buffer.from("123456789"))).toBe(bitwiseCrc32(Buffer.from("123456789")));
  });

  it("sync writes every reference from its source and check fails until it has (run in a copy of the layout, never in the repository)", () => {
    const copy = tmp();
    const put = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(copy, rel));
    };
    for (const rel of ["scripts/skill.js", "scripts/zip.js", "skills/omniroute-mcp/SKILL.md", ...Object.keys(skill.REFERENCES)]) put(rel);
    const run = (command: string) => require("child_process").spawnSync(process.execPath, [path.join(copy, "scripts", "skill.js"), command], { encoding: "utf8" });
    const reference = path.join(copy, "skills", "omniroute-mcp", "references", "roadmap.md");

    expect(run("check").status).toBe(1); // no references yet
    expect(run("sync").status).toBe(0);
    expect(fs.readFileSync(reference, "utf8")).toBe(`<!-- Copy of ROADMAP.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->\n\n` + read("ROADMAP.md"));
    expect(run("check").status).toBe(0);

    fs.appendFileSync(path.join(copy, "ROADMAP.md"), "\na line added to the source\n");
    expect(run("check").status).toBe(1); // the source moved on
    expect(run("sync").status).toBe(0);
    expect(run("check").status).toBe(0);
    expect(fs.readFileSync(reference, "utf8")).toContain("a line added to the source");
  });

  it("packages to a zip that an independent reader accepts: every file, its content, the folder name, and a matching checksum", () => {
    const out = path.join(tmp(), "skill.zip");
    const { files } = skill.packageZip(out);
    const zip = fs.readFileSync(out);
    const entries = readZip(zip);
    expect(entries).toHaveLength(files);
    for (const { name, crc, usize, data } of entries) {
      expect(data.length).toBe(usize);
      expect(bitwiseCrc32(data)).toBe(crc); // not skill.crc32: a function cannot vouch for its own output
      expect(name.startsWith("omniroute-mcp/")).toBe(true);
      expect(data.equals(fs.readFileSync(path.join(skillDir, ...name.slice("omniroute-mcp/".length).split("/"))))).toBe(true);
    }
    const seen = entries.map((e) => e.name);
    expect(seen).toContain("omniroute-mcp/SKILL.md");
    expect(seen.filter((n) => n.includes("/references/"))).toHaveLength(Object.keys(skill.REFERENCES).length);
    expect(skill.packageZip(out).files).toBe(files);
    expect(fs.readFileSync(out).equals(zip)).toBe(true); // the same input gives the same bytes
  });

  it("stores what does not compress and deflates what does, each with the matching method flag (empty, random, repetitive, non-ASCII names)", () => {
    const random = require("crypto").randomBytes(512);
    const text = Buffer.from("abc ".repeat(500));
    const entries = readZip(skill.zip([["empty.txt", Buffer.alloc(0)], ["random.bin", random], ["text.txt", text], ["ünï/cødé.md", Buffer.from("x")]]));
    const by = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(by["empty.txt"].method).toBe(0);
    expect(by["random.bin"].method).toBe(0);
    expect(by["text.txt"].method).toBe(8);
    expect(by["random.bin"].data.equals(random)).toBe(true);
    expect(by["text.txt"].data.equals(text)).toBe(true);
    expect(Object.keys(by)).toContain("ünï/cødé.md");
    for (const e of entries) {
      expect(bitwiseCrc32(e.data)).toBe(e.crc);
      expect(e.flags & 0x0800).toBe(0x0800); // names are UTF-8, in the central directory and in the local header
      expect(e.localFlags & 0x0800).toBe(0x0800);
    }
  });

  it("installs into the folder it owns only: a dry run writes nothing, a real run replaces the old copy and leaves other skills alone", () => {
    const target = tmp();
    fs.mkdirSync(path.join(target, "other-skill"));
    fs.writeFileSync(path.join(target, "other-skill", "SKILL.md"), "keep me");
    skill.install(target, true);
    expect(fs.existsSync(path.join(target, "omniroute-mcp"))).toBe(false);
    fs.mkdirSync(path.join(target, "omniroute-mcp"));
    fs.writeFileSync(path.join(target, "omniroute-mcp", "stale.txt"), "old");
    const { files } = skill.install(target, false);
    expect(files).toBe(1 + Object.keys(skill.REFERENCES).length);
    expect(fs.existsSync(path.join(target, "omniroute-mcp", "stale.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "omniroute-mcp", "SKILL.md"), "utf8")).toBe(text);
    expect(fs.readFileSync(path.join(target, "other-skill", "SKILL.md"), "utf8")).toBe("keep me");
  });
});

describe("owner-facing diagnostics that name the running version", () => {
  // The server prints `increadible <version>: ready on stdio` (src/index.ts; tests/entry-point.test.ts pins it to package.json). The
  // install guide tells the owner to read its absence as "the server never started", so a stale literal would send the owner to a wrong
  // conclusion after a version bump. History rows (CHANGELOG, BUILD-HISTORY, ROADMAP numbered rows) keep their literals on purpose.
  // docs/USING-THE-GATEWAY.md is deliberately NOT scanned: it names versions in prose and uses the placeholder for the banner.
  const literal = /increadible (\d+\.\d+\.\d+): ready on stdio/g;
  it("uses the placeholder, or the current version, never a stale number", () => {
    for (const file of ["docs/INSTALL-CLAUDE-DESKTOP.md", "docs/TROUBLESHOOTING.md"]) {
      expect({ file, literals: [...read(file).matchAll(literal)].map((m) => m[1]) }).toEqual({ file, literals: [] });
    }
    expect(read("docs/INSTALL-CLAUDE-DESKTOP.md")).toContain("increadible <version>: ready on stdio");
    const open = read("ROADMAP.md").split("\n").find((l) => l.startsWith("- [ ] **Retest the package in Claude Desktop"));
    expect(open).toBeDefined();
    for (const [, v] of open!.matchAll(literal)) expect(v).toBe(pkg.version);
  });
});
