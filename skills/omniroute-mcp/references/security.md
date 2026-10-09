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
| HTTP mode | bearer token compared in constant time; a server on a non-loopback `HOST` refuses to start without `AUTH_TOKEN`; receive timeouts; optional global rate limit (off by default) | `tests/server.test.ts`, `scripts/smoke.sh`, the image probe in CI |
| stdio mode (Claude Desktop) | no network listener; the process is started by the client and sees only the files named in its environment | `tests/entry-point.test.ts` |
| Data file | single writer (lock file); a lost lock makes writes fail closed; created with mode 0600 | `tests/e2e-integration.test.ts`, `tests/ab-boundaries.test.ts` |
| Container | non-root user, read-only root filesystem in the manifests, healthcheck | `Dockerfile`, `k8s/`, image probe in CI |
| Dependencies | production tree: 0 advisories (CI gates on `npm audit --omit=dev`); CycloneDX SBOM generated and validated in CI | CI `security` job |
| Secrets in the repository | scanned in CI for **verified** secrets | CI `security` job |

## What is not done

| Gap | State |
|---|---|
| Development dependencies | 20 advisories, none high, one chain (`sprintf-js` has no patched version); not reachable by any input |
| Container image vulnerability scan | not done (needs a tool choice: open decision) |
| The secret scanner image is not pinned | recorded as D-5 in `AUDIT.md`; owner decision |
| GitHub Actions are pinned by version tag, not by commit SHA | open decision |
| Image signing; reading the SBOM attestation back | not done / `NOT VERIFIED` |
| TLS, ingress and a NetworkPolicy | not built; the gateway has no egress policy |
| A cluster deployment | never done; the production manifest and the monitoring have never been applied to anything |
| Live provider calls | never run against a real provider |

## Handling secrets in this project

- Document variable **names** only; never values, in code, documents, logs, pull requests or the skill.
- A key placed in a Claude Desktop config file is stored there in plain text. Prefer the `.mcpb` package's settings (the operating system's keychain) when it exists, and keep keys for keyless-capable APIs out of the config altogether (`coingecko`, `hackernews`, `wikipedia` and `wikidata` need none).
- If a secret is ever committed, treat it as exposed: revoke it first, then remove it.
