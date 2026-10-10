/**
 * Egress allowlist (step 3 of the gated catalog's order of work, `docs/GATEWAY-GATED-CATALOG.md`): the deployment manifests allow
 * DNS only, and the opt-in Cilium policy allows HTTPS to the keyless providers' hosts only. These tests read the manifests;
 * whether a cluster enforces them is NOT VERIFIED (no cluster is available to this project).
 */
import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { CATALOG } from "../features/09-api-gateway/src/catalog";

const root = path.join(__dirname, "..");
const docs = (p: string): any[] => yaml.parseAllDocuments(fs.readFileSync(path.join(root, p), "utf-8")).map((d) => d.toJS());
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** The hosts of the APIs that need no key: the only ones verified live, and the only ones the live policy may reach. */
const keylessHosts = CATALOG.filter((e) => e.definition.auth === "none").map((e) => new URL(e.definition.endpoint).hostname);

/** Every way the DNS-only NetworkPolicy fails to hold for `deployment`; empty when it holds. */
function egressProblems(policy: any, deployment: any): string[] {
  if (!policy) return ["no NetworkPolicy"];
  const found: string[] = [];
  const labels = deployment.spec.template.metadata.labels;
  const selector = policy.spec?.podSelector?.matchLabels ?? {};
  if (Object.keys(selector).length === 0 || !Object.entries(selector).every(([k, v]) => labels[k] === v))
    found.push("podSelector does not select the deployment's pods");
  if (JSON.stringify(policy.spec?.policyTypes) !== JSON.stringify(["Egress"])) found.push("policyTypes must be exactly [Egress] (ingress is not restricted here)");
  const rules: any[] = policy.spec?.egress ?? [];
  const ports = rules.flatMap((r) => (r.ports ?? []).map((p: any) => `${p.protocol}/${p.port}`)).sort();
  if (JSON.stringify(ports) !== JSON.stringify(["TCP/53", "UDP/53"])) found.push(`egress ports are ${ports.join(", ") || "none"}, not DNS only`);
  if (rules.some((r) => !r.ports || r.ports.length === 0)) found.push("an egress rule without ports allows every port");
  return found;
}

/** Every way the Cilium live policy fails to hold; empty when it holds. */
function ciliumProblems(policy: any, deployment: any): string[] {
  const found: string[] = [];
  if (policy.apiVersion !== "cilium.io/v2" || policy.kind !== "CiliumNetworkPolicy") found.push("not a cilium.io/v2 CiliumNetworkPolicy");
  if (policy.metadata?.namespace !== undefined) found.push("a namespace is set: it must be applied with -n into the deployment's namespace");
  const labels = deployment.spec.template.metadata.labels;
  const selector = policy.spec?.endpointSelector?.matchLabels ?? {};
  if (Object.keys(selector).length === 0 || !Object.entries(selector).every(([k, v]) => labels[k] === v))
    found.push("endpointSelector does not select the deployment's pods");
  const rules: any[] = policy.spec?.egress ?? [];
  for (const r of rules) {
    const ports = (r.toPorts ?? []).flatMap((t: any) => t.ports.map((p: any) => `${p.protocol}/${p.port}`));
    if (r.toFQDNs) {
      if (JSON.stringify(ports) !== JSON.stringify(["TCP/443"])) found.push(`FQDN rule ports are ${ports.join(", ")}, not TCP/443 only`);
      if (r.toFQDNs.some((f: any) => f.matchPattern !== undefined)) found.push("a wildcard (matchPattern) in toFQDNs");
    } else if (r.toEndpoints) {
      if (JSON.stringify(ports) !== JSON.stringify(["ANY/53"])) found.push(`DNS rule ports are ${ports.join(", ")}, not 53`);
      if (!r.toPorts?.[0]?.rules?.dns) found.push("the DNS rule has no dns rules: Cilium would not learn the addresses behind the names");
    } else found.push("an egress rule with neither toFQDNs nor toEndpoints (it could open more than the providers)");
  }
  const hosts = rules.flatMap((r) => (r.toFQDNs ?? []).map((f: any) => f.matchName)).sort();
  if (JSON.stringify(hosts) !== JSON.stringify([...keylessHosts].sort())) found.push(`hosts ${hosts.join(", ")} are not the keyless APIs' hosts ${keylessHosts.join(", ")}`);
  return found;
}

const manifests = ["k8s/staging-deployment.yaml", "k8s/production-deployment.yaml"];
const live = docs("k8s/egress-live-cilium.yaml");

describe.each(manifests)("%s: egress is DNS only", (file) => {
  const all = docs(file);
  const deployment = all.find((d) => d.kind === "Deployment");
  const policy = all.find((d) => d.kind === "NetworkPolicy");

  it("selects the deployment's pods, restricts egress only, and allows nothing but DNS", () => {
    expect(egressProblems(policy, deployment)).toEqual([]);
  });

  it("fits a deployment whose live calls are off (with live calls on, it would refuse them)", () => {
    const names = deployment.spec.template.spec.containers[0].env.map((e: any) => e.name);
    expect(names).not.toContain("GATEWAY_LIVE_APIS");
  });
});

describe("k8s/egress-live-cilium.yaml: HTTPS to the keyless providers only", () => {
  const deployment = docs(manifests[1]).find((d) => d.kind === "Deployment");

  it("is one CiliumNetworkPolicy without a namespace, selecting the deployment's pods", () => {
    expect(live).toHaveLength(1);
    expect(ciliumProblems(live[0], deployment)).toEqual([]);
  });

  it("names exactly the four keyless APIs' hosts, which DEPLOYMENT.md lists", () => {
    expect([...keylessHosts].sort()).toEqual(["api.coingecko.com", "en.wikipedia.org", "hacker-news.firebaseio.com", "www.wikidata.org"]);
    const deploymentDoc = fs.readFileSync(path.join(root, "DEPLOYMENT.md"), "utf-8");
    expect(deploymentDoc).toContain("k8s/egress-live-cilium.yaml");
    for (const host of keylessHosts) expect(deploymentDoc).toContain(host);
  });
});

describe("the checks report each breakage", () => {
  const all = docs(manifests[1]);
  const deployment = all.find((d) => d.kind === "Deployment");
  const policy = all.find((d) => d.kind === "NetworkPolicy");

  const egressCases: Array<[string, (p: any) => void, RegExp]> = [
    ["HTTPS added to the DNS-only policy", (p) => p.spec.egress.push({ ports: [{ protocol: "TCP", port: 443 }] }), /not DNS only/],
    ["a rule without ports (every port)", (p) => p.spec.egress.push({}), /without ports allows every port/],
    ["a selector for other pods", (p) => (p.spec.podSelector.matchLabels = { app: "other" }), /does not select/],
    ["an empty selector (every pod in the namespace)", (p) => (p.spec.podSelector = {}), /does not select/],
    ["ingress restricted too", (p) => p.spec.policyTypes.push("Ingress"), /exactly \[Egress\]/],
  ];
  it.each(egressCases)("NetworkPolicy: %s", (_n, change, expected) => {
    const p = clone(policy);
    change(p);
    expect(egressProblems(p, deployment).join("\n")).toMatch(expected);
  });
  it("NetworkPolicy: missing", () => expect(egressProblems(undefined, deployment)).toEqual(["no NetworkPolicy"]));

  const ciliumCases: Array<[string, (p: any) => void, RegExp]> = [
    ["a key-based provider's host added", (p) => p.spec.egress[1].toFQDNs.push({ matchName: "finnhub.io" }), /are not the keyless APIs' hosts/],
    ["a host removed", (p) => p.spec.egress[1].toFQDNs.pop(), /are not the keyless APIs' hosts/],
    ["a wildcard host", (p) => (p.spec.egress[1].toFQDNs[0] = { matchPattern: "*.coingecko.com" }), /wildcard/],
    ["port 80 opened to the providers", (p) => p.spec.egress[1].toPorts[0].ports.push({ port: "80", protocol: "TCP" }), /not TCP\/443 only/],
    ["the DNS proxy rule dropped", (p) => delete p.spec.egress[0].toPorts[0].rules, /no dns rules/],
    ["a CIDR rule added", (p) => p.spec.egress.push({ toCIDR: ["0.0.0.0/0"] }), /neither toFQDNs nor toEndpoints/],
    ["a namespace pinned", (p) => (p.metadata.namespace = "increadible"), /a namespace is set/],
    ["another kind", (p) => (p.kind = "NetworkPolicy"), /not a cilium\.io\/v2/],
  ];
  it.each(ciliumCases)("Cilium policy: %s", (_n, change, expected) => {
    const p = clone(live[0]);
    change(p);
    expect(ciliumProblems(p, deployment).join("\n")).toMatch(expected);
  });
});
