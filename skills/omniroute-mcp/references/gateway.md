<!-- Copy of GATEWAY.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Universal API gateway: decision record

**Status: option A APPROVED by the owner on 2026-10-10. Nothing has been built from it yet; step 1 of the gated catalog is next.** The gateway in this repository (Feature #9)
still has 9 registered APIs. Written 2026-10-08 from research done on 2026-10-07 and 2026-10-08; every claim carries its
verification status, and the list of what is not verified is at the end.

## The question

The owner asked (2026-10-07) for a **universal gateway**, "the best proven and recommended one", chosen by research first.
The original plan (commit `67e7498`) asked for intelligent access to 1000+ public APIs, intent-based selection, multi-step
workflows, caching, fallbacks and cost tracking. Today the registry has 9 APIs, `call_api` returns mock data unless an API is
switched to live. Live calls were first made on 2026-10-10, one each to the four keyless APIs (coingecko, hackernews, wikipedia, wikidata)
from Claude Desktop on the owner's Windows PC; the key-based APIs have never run live.

## How it was researched, and the limits

Three independent tracks, each required to cite primary sources and to mark vendor-written numbers: hosted integration platforms,
open-source MCP gateways, and the catalog route with its failure modes. I then re-checked the claims the decision depends on
against primary pages. Limits: the authoring sandbox cannot reach every site (for example `docs.docker.com` and some status
pages), GitHub counts are as displayed on 2026-10-07 and rounded, and **almost no adoption evidence that the vendor did not write
itself was found for any candidate**.

## What the research found

| Kind | Candidates | What they do | Fit for 1000+ public APIs |
|---|---|---|---|
| Hosted integration platforms | Composio, Pipedream, Zapier MCP, Make, Nango, Arcade, Merge, Apideck, Smithery | Authenticated SaaS actions: OAuth, per-user connections, vendor-held credentials | Poor: not public no-auth REST APIs, and your users' credentials live with the vendor |
| Open-source MCP gateways | agentgateway, IBM ContextForge, MetaMCP, Docker MCP Gateway, Microsoft MCP Gateway, ToolHive, Unla | Proxy or govern MCP servers you supply, or convert an OpenAPI spec you supply | None by themselves: **they add governance, not breadth** |
| LLM or enterprise API gateways | Agent Router (ex Envoy AI Gateway), LiteLLM, Kong, Cloudflare portals | Route model traffic, or general API management | Not the same problem |
| Catalogs | APIs.guru (OpenAPI directory), public-apis | A list of APIs, not a runtime | Seed material only (below) |

Facts that carry the decision:

| Fact | Status |
|---|---|
| APIs.guru's data last changed on **2024-03-01**, although the repository states weekly updates | **Verified** (primary page) |
| APIs.guru lists about 2,500 APIs | Third-party figure, **NOT VERIFIED** |
| public-apis has about 1,980 entries, roughly half needing no auth, and is Markdown tables (not machine-readable) | The research agent's tally was NOT VERIFIED; **counted on 2026-10-10** (gated catalog, step 4) from the list's README (SHA-256 `cf00cccb...`): **2,032 entries** in 51 categories, **972 listed with no auth** (47.8%), 903 `apiKey`, 149 `OAuth`, 6 `X-Mashape-Key`, 2 `User-Agent`; 5 rows malformed in the source. The tables are regular enough to parse (`scripts/seed-candidates.js`); a listing says nothing about whether an API works |
| agentgateway (Linux Foundation, Apache-2.0): 5 security advisories, 1 High, **two on MCP-to-OpenAPI parameter sanitization** (the latest 2 Oct 2026), the very path a converter-based design would rely on | **Verified** (GitHub advisories page) |
| IBM ContextForge: 10+ advisories, 2 Critical on 25 Aug 2026 (SSRF in a bundled server; a default JWT secret in the Docker Compose file); its `SECURITY.md` says the admin UI and API "must be disabled in production" | Research agent's reading of the repository, 2026-10-07, not re-read by me |
| Docker MCP Gateway: needs a Docker daemon (a Kubernetes pod has none); 8 advisories, 2 Critical on 9 Jul 2026; catalog "300+" servers, Beta | Same; the catalog figure is from a search summary, `docs.docker.com` was not fetchable |
| Composio disclosed a credential incident in May 2026 (company bulletin; Mintlify's status page; a third-party write-up). The scale differs between sources ("about 0.3% of active connections" against about 5,241 API keys and 5,001 GitHub OAuth tokens) and was **not reconciled** | Incident **corroborated** by independent sources; scale **NOT VERIFIED** |
| No candidate has independent evidence of production use that its vendor did not write | As found; absence of evidence, not proof of absence |

## The true requirements

| # | Requirement | Evidence | Status today |
|---|---|---|---|
| 1 | 1000+ **usable** APIs, not 1000 listed | Both catalogs are seed material: one is frozen since 2024-03-01, the other is not machine-readable | 9 APIs |
| 2 | Safe execution of untrusted model input | The live layer refuses other hosts and paths, redirects, non-JSON, oversize and slow responses; tested against a real local server and a 60 000-endpoint property test | Done; **run against the real providers for the four keyless APIs only** (one call each, 2026-10-10, from Claude Desktop); the key-based APIs never |
| 3 | The catalog is untrusted input | Specs go stale or are edited by AI tools: pin each base URL when an API is registered and never take `servers` from a spec | Not built |
| 4 | Authentication beyond API keys | OAuth2 and Bearer are common; hundreds of keys need a secret store, which is the owner's decision | API keys only |
| 5 | Terms per API | For example, a free tier can be non-commercial only | Not built |
| 6 | Health probing | Neither catalog has any; an audit quoted by a snippet estimated about 20% of listed APIs broken (**NOT VERIFIED**) | Not built |
| 7 | Intent selection, workflows, fallbacks, cost tracking | Descriptions are uneven, so ranking and rewritten descriptions are needed | Partial: discovery, cache, parallel calls |

## Options

| Option | For | Against |
|---|---|---|
| **A. Build the core, buy nothing** (recommended) | Keeps the hardened call layer and the A/B module that can measure cost and quality; the advertised count can equal the count that passed its gates; no vendor holds credentials | Real work; independent proof of production use has to be earned |
| B. A hosted platform | Fast OAuth for SaaS actions | Wrong product for public APIs; vendor-held credentials; a verified vendor incident |
| C. An open-source gateway in front | Governance, policy, observability | No breadth; recent advisories in exactly the conversion path; a second large service to run (databases, a Docker daemon, or Envoy and Kubernetes, depending on the product) |
| D. A plus a hosted platform for SaaS actions only | Covers user-delegated SaaS (mail, chat) | Same cautions as B for that slice; the owner's call, and `COMPANIONS.md` already says third-party tools run beside this server, never inside it |

## Recommendation: A, with a gated catalog

1. **Keep the four-tool interface** (`discover_apis`, `call_api`, `aggregate_apis`, `get_api_stats`): a few meta-tools, not a tool per API.
2. **Seed from APIs.guru and public-apis, as seed only.** Nothing is trusted because it is listed.
3. **Gated promotion.** An API enters the registry only after: its auth is classified, its terms are recorded, its base URL is pinned at registration, a health probe passes, its description is rewritten, and tests exist. **The advertised count is the number that passed.**
4. **Publish the evidence per API**: probe history, latency, error rate, terms.
5. **Measure with the A/B module** (cost as the primary metric, quality as a guardrail) on a real workload.
6. **Optional, side by side:** a hosted platform for SaaS actions only, if wanted.

Independent proof of production use cannot be produced by code alone. It needs a deployment the owner approves, real traffic,
published measurements and incident write-ups, and a third-party security review. This repository has none of those today.

## What would change the recommendation

- A need for **user-delegated SaaS actions** (acting inside each user's mail, chat or tickets): use a hosted platform for that slice (option D).
- Independent evidence of production use, or an independent security review, for one of the open-source gateways.
- The owner choosing speed over control of the catalog.

## Not verified

The APIs.guru API count; the public-apis count and no-auth share; the roughly 20% broken-API estimate; the ContextForge and
Docker advisory details (a research agent read them on 2026-10-07; only agentgateway's were re-read); the Docker catalog size;
the scale of the Composio incident; licences other than the ones named; every contributor count; the behaviour of any
candidate when run (none was installed or run).

## Decisions requested from the owner

The gated catalog of option A, as components and an order of work: [`docs/GATEWAY-GATED-CATALOG.md`](docs/GATEWAY-GATED-CATALOG.md) (approved 2026-10-10, not built yet).


- [x] Approve the direction: **build the core, no giant** (option A). **Approved by the owner on 2026-10-10.**
- [x] Approve starting the **gated catalog** (the seeding and gating pipeline) after the audit. **Approved with option A on 2026-10-10**; step 1 (`docs/GATEWAY-GATED-CATALOG.md`, section 4) is next.
- [ ] Say whether option D (a hosted platform beside the server for SaaS actions) is wanted.
- [ ] Choose where API keys will live when live mode is used for more than the keyless APIs (a Secret in the cluster is the assumption in `DEPLOYMENT.md`).
