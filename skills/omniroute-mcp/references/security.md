<!-- Copy of SECURITY.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Security

This document says what the server does to protect you, what it does not do, and how to report a problem. It makes no compliance
claim: **there is no SOC 2 or GDPR assessment of this code** (`ROADMAP.md`, quality gates).

## Reporting a vulnerability

The repository is private. Report a problem to the repository owner directly. The owner has **not yet enabled GitHub private
vulnerability reporting** (an open decision in `ROADMAP.md`); when it is on, use *Security, Report a vulnerability* on the
repository page and this paragraph will say so. Please do not put exploit details or any secret value in a public place or in an issue
title. Only the latest `main` is supported.

## What is protected, and the evidence

| Area | Protection | Evidence |
|---|---|---|
| Tool input from a model | typed, size-limited and id-checked; one bad input cannot end the process | `tests/ab-inputs.test.ts`, `tests/server.test.ts`, mutation testing (`AUDIT.md` section 6) |
| Gateway live calls | only GET to the API's registered URL: no other host or path, no redirects, JSON only, time and size capped; a model cannot set the credential | `tests/gateway-live.test.ts` against a real local server and a 60 000-endpoint property test. **Never run against a real provider** |
| Credentials | read from environment variables (`GATEWAY_KEY_<API>`); never in a result, error, log line or cache key | the same tests |
| HTTP mode | bearer token compared in constant time; a server on a non-loopback `HOST` refuses to start without `AUTH_TOKEN`; a request with an `Origin` header (a web page's) is refused with 403 unless `ALLOWED_ORIGINS` lists it, before the token check and also without a token (DNS rebinding); an unsupported `MCP-Protocol-Version` is refused; receive timeouts; optional global rate limit (off by default). `Host` is not validated and `Content-Type` is not checked (the probe records both) | `tests/server.test.ts`, `tests/http-origin.test.ts`, `tests/entry-point.test.ts`, `scripts/smoke.sh`, the image probe in CI |
| stdio mode (Claude Desktop) | no network listener; the process is started by the client and sees only the files named in its environment | `tests/entry-point.test.ts` |
| Data file | single writer (lock file); a lost lock makes writes fail closed; created with mode 0600 | `tests/e2e-integration.test.ts`, `tests/ab-boundaries.test.ts` |
| Claude Desktop package | built here from the committed sources and the lockfile (no install scripts), holds no secret, no source and no development tool; checked by `inspect`. **Unsigned**; Claude Desktop installed and ran the unsigned file on Windows (version 1.0.2, 2026-10-09); whether it showed a warning about the missing signature was not recorded | `tests/mcpb.test.ts` |
| Container | non-root user, read-only root filesystem in the manifests, healthcheck; **except on Railway**, where the rehearsal runs as root (`RAILWAY_RUN_UID=0`, because Railway mounts volumes as root) | `Dockerfile`, `k8s/`, image probe in CI, `DEPLOYMENT.md` ("Railway") |
| Dependencies | production tree: 0 advisories (CI gates on `npm audit --omit=dev`); CycloneDX SBOM generated and validated in CI | CI `security` job |
| Secrets in the repository | scanned in CI for **verified** secrets | CI `security` job |

## What is not done

| Gap | State |
|---|---|
| Development dependencies | 6 low advisories in one chain: `deepmerge` (GHSA-gcqx-w48m-w2h4, prototype poisoning through `mergeObject`) used by `jest-config`, hence by `jest` and `ts-jest` (`npm audit`, 2026-10-30). Production has 0. Test-time only: no input from outside reaches it. npm's suggested fix would install `jest@25.1.0`, a downgrade: do not run `npm audit fix --force`; look again when Jest ships a release that does not depend on it. Earlier states: 42 advisories on 2026-10-07 and 20 moderate on 2026-10-09 (`AUDIT.md` F-03); a critical `handlebars` advisory was fixed by updating it to 4.7.10 (PR #40) |
| Container image vulnerability scan | not done (needs a tool choice: open decision) |
| The secret scanner's image pin ages | pinned by digest (`3.99.2@sha256:47a84bc1...`, owner decision of 2026-10-09, `AUDIT.md` D-5), while Dependabot bumps the action itself (3.99.7); the digest is not moved by Dependabot, so it stays old until someone bumps it on purpose. CI reports only secrets the provider confirms are live (`--only-verified`) |
| GitHub Actions are pinned by version tag, not by commit SHA | open decision |
| Image signing; reading the SBOM attestation back | not done / `NOT VERIFIED` |
| TLS, ingress and a NetworkPolicy | TLS and ingress not built. Egress: the manifests allow DNS only, and `k8s/egress-live-cilium.yaml` allows HTTPS to the four keyless providers on a Cilium cluster (`DEPLOYMENT.md`); never applied to a cluster, so **NOT VERIFIED**. Railway has no egress policy |
| A cluster deployment | never done; the production manifest and the monitoring have never been applied to anything |
| Live provider calls | verified for the four keyless APIs only (coingecko, hackernews, wikipedia, wikidata: one real call each from Claude Desktop on the owner's Windows PC, 2026-10-10, package 1.0.3); the key-based APIs have never run live; provider terms and rate limits reviewed on 2026-10-12 but **not approved** (only HN's read on its page; `docs/GATEWAY-GATED-CATALOG.md`, section 11); the User-Agent carries a contact only when `GATEWAY_CONTACT` (or `GATEWAY_USER_AGENT`) gives one, and production refuses Wikimedia calls without it |

## Handling secrets in this project

- Document variable **names** only; never values, in code, documents, logs, pull requests or the skill.
- A key placed in a Claude Desktop config file is stored there in plain text. The `.mcpb` package exists but offers no key settings yet; the vendor's format can keep a sensitive setting in the operating system's keychain (not verified here), so the day the gateway goes live that is the place for keys. Until then keep keys for keyless-capable APIs out of the config altogether (`coingecko`, `hackernews`, `wikipedia` and `wikidata` need none).
- If a secret is ever committed, treat it as exposed: revoke it first, then remove it.
