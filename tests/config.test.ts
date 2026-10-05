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

  it("has no unmeasured headline claims left in the docs", () => {
    const text = [read("README.md"), read("DEPLOYMENT.md")].join("\n");
    expect(text).not.toMatch(/PRODUCTION DEPLOYMENT AUTHORIZED|1000\+ APIs|99\.98% (cost )?(reduction|savings|optimization)/i);
  });
});
