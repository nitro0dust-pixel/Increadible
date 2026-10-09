# Documentation index

Every document in this repository, in the order you would want to read it. Documents under `features/` belong to the vendored
third-party projects (or are our integration guides for them) and are not listed here.

## By stage, from nothing to running

| Stage | Read | What it gives you |
|---|---|---|
| 1. What is this | [README.md](../README.md) | what the server is, the 13 tools, quick start, configuration |
| 2. Is it true | [ROADMAP.md](../ROADMAP.md) | status with evidence, sprints, gates, owner decisions; the source of truth for what is done |
| 3. Install it in Claude Desktop | [INSTALL-CLAUDE-DESKTOP.md](INSTALL-CLAUDE-DESKTOP.md) | prerequisites, build, config, verification, upkeep |
| 4. It does not work | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | symptom, cause and fix, in the server's own messages |
| 5. Run it in a container or cluster | [DEPLOYMENT.md](../DEPLOYMENT.md) | image, HTTP mode, Kubernetes, secrets, monitoring |

## By purpose

| Purpose | Document |
|---|---|
| How it is built | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Every step taken, in order | [BUILD-HISTORY.md](BUILD-HISTORY.md) |
| What changed for an operator | [CHANGELOG.md](../CHANGELOG.md) |
| How a version becomes a release: who tags, which commit, how the package hash is checked | [RELEASING.md](RELEASING.md) |
| The audit: findings, fixes, what was not verified | [AUDIT.md](../AUDIT.md) |
| What was measured and what the numbers do not say | [PERFORMANCE.md](../PERFORMANCE.md) |
| Third-party tools that run beside this server | [COMPANIONS.md](../COMPANIONS.md) |
| Calling the API gateway from a Claude chat: prompts, answers, mock versus real, the statistics | [USING-THE-GATEWAY.md](USING-THE-GATEWAY.md) |
| The universal API gateway decision (proposed, not built) | [GATEWAY.md](../GATEWAY.md) |
| Option A of that decision as components and an order of work (proposed, not built) | [GATEWAY-GATED-CATALOG.md](GATEWAY-GATED-CATALOG.md) |
| Working on the code | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Context for Claude sessions (stable facts and working rules) | [CLAUDE.md](../CLAUDE.md) |
| Security posture and reporting | [SECURITY.md](../SECURITY.md) |
| The global skill that carries all of this into any Claude session | [skills/omniroute-mcp/SKILL.md](../skills/omniroute-mcp/SKILL.md) |
| Pull request checklist | [.github/pull_request_template.md](../.github/pull_request_template.md) |

## Keeping the set honest

A test (`tests/config.test.ts`) fails when a document in this repository is missing from this index, when a link or a command a
document names does not exist, and when the skill's copies of these documents differ from the originals. After every step: update
the documents that the step changed, add a row to [BUILD-HISTORY.md](BUILD-HISTORY.md), run `node scripts/skill.js sync`, and run `npm test`.
