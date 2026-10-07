# Companions: tools that run beside this server

**Nothing here is a dependency of this repository.** No code of any companion is built, tested, shipped in the image or run by CI. A
companion is a separate program that *you* configure your MCP client (or terminal) to start next to this server. The `features/01-06`
folders are pinned copies of third-party projects kept for reference; this repo does not integrate them.

Status words as everywhere in this repo: `NOT VERIFIED` means nobody here has run it. Snapshot taken **2026-10-07**; stars, versions and
prices move.

## token-optimizer-mcp (decided: side by side, 2026-10-07)

| | |
|---|---|
| What it is | a third-party MCP server and set of command-line tools that try to cut the tokens an agent spends (compression, caching, a proxy, a daemon). MIT. By its authors' account it optimises the *bill*, counting that cached tokens are cheaper than rewritten ones. **That is their claim; this repo has measured no saving from it.** |
| Where | pinned reference copy: `features/03-token-optimizer/token-optimizer-mcp` (package version 7.3.0 at the pinned commit `1fe06109`). The npm package `@ooples/token-optimizer-mcp` was at **7.4.1** on the snapshot date and had been modified that same day: it changes fast |
| Needs | Node 22 or newer; a native SQLite module (`better-sqlite3`); about 14 command-line entry points |
| Why beside, not inside | 65 MB and about 4 600 files, a daemon, installers with machine-wide effects, and a release pace this repo cannot track. Embedding it would be a major new dependency, which needs its own written case; the owner chose not to |
| Interaction with this server | none today: neither calls the other. A client that starts both simply lists both servers' tools. No tool-name clash has been checked: **NOT VERIFIED** |

### Before you run it (read from the pinned 7.3.0 source; the authors' own comments, not observed behaviour)

1. **A plain install is documented not to change your machine, but its installer does.** `token-optimizer-install`, or setting
   `TOKEN_OPTIMIZER_AUTO_INSTALL=1` during an install, writes a hooks block into your **global** Claude settings
   (`~/.claude/settings.json`). Those hooks match nearly every tool call, so they apply to every Claude Code session and project on the machine,
   including ones already running, and can rewrite tool output. The package's own comment records an incident of exactly this (its issue 449).
   If you want it beside this server, configure the MCP server entry only, and **do not run the installer**.
2. **Telemetry is off by default and opt-in, in the source.** Two separate switches, `TOKEN_OPTIMIZER_TELEMETRY` (local counters) and
   `TOKEN_OPTIMIZER_BEACON` (anonymous upload to a Supabase project named in the source), and the standard `DO_NOT_TRACK` is honoured. Leave
   both unset. An upload also needs a key that its release process stamps in, so a source build cannot upload at all.
3. **Re-read before you upgrade.** What was read is 7.3.0; the published version moved on. Pin the version you install and read its
   `scripts/postinstall.cjs` and `src/telemetry/policy.ts` again for that version.
4. **No isolation is claimed.** It runs as you, with your permissions. Run it as you would any third-party program you have not audited.

How to run it beside this server is therefore only: add it as a second MCP server in your client's configuration, from the published package at a
pinned version (command `npx`, arguments `-y` and `@ooples/token-optimizer-mcp@<version>`). **NOT VERIFIED:** this repo has never started it.

## The other vendored projects, and why none is a companion

| Project | What it is | Why not |
|---|---|---|
| `features/03-headroom/headroom` | a 21-file MCP server (compress code and JSON, optimise prompts, redact), ISC, one commit by one author | the only one small enough to embed; the owner chose side by side, so it stays unintegrated |
| `features/01-omniroute/OmniRoute` | a complete AI gateway application, 1.9 GB | it competes with this server's Routing Plugins |
| `features/02-claude-mem/claude-mem`, `features/04-gstack/gstack` | plugins and skills for the Claude Code *client* | they extend the client, not a server |
| `features/06-agentacct/agentacct` | a Python recorder and dashboard for coding-agent logs | see below |

## Measuring real savings, and `agentacct`

The owner's condition for using `agentacct`: it must be the best proven option, running successfully in the market now, and one of its kind in the
world. Checked on 2026-10-07; **it does not meet that condition on the evidence:**

| Claim | Evidence | Verdict |
|---|---|---|
| Proven | its own README says "early alpha"; PyPI classifies it Development Status 3 - Alpha; first release 2026-07-24, so about 10 weeks old; 44 releases since; 7 contributors. Releases 0.12.1 to 0.12.4 shipped without the macOS app and were re-released as 0.12.5 | not proven |
| Running in the market | real and active: [766 stars, 83 forks](https://github.com/mikehasa/agentacct) and a [third-party write-up](https://www.simpmusic.org/blogs/agentacct-turns-coding-agent-logs-into-a-local-truth-layer-for-cost-evidence-and-attribution); no evidence of production or enterprise use | in use by early adopters |
| One of its kind | false: many tools do the same job. The largest, [ccusage](https://github.com/ryoppippi/ccusage), has 18.9k stars, MIT, and reads logs from 18 agents; Claude Code has built-in `/cost`; there are several others in [roundups](https://dev.to/pederaa/how-to-track-claude-code-usage-in-2026-built-in-commands-ccusage-and-desktop-dashboards-compared-1kk1) (many roundups are written by vendors who rank themselves first) | not unique |
| Cost accuracy | its costs are pricing-table estimates, by its own statement; log readers in general estimate | estimates, not invoices |

Stars measure attention, not quality, so none of this makes ccusage "the best"; it only shows that `agentacct` is neither the most adopted nor
the only one. The ground truth for what a model call cost is the provider's own billing record, for Anthropic the
[Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) (beta; needs a Console organization and an admin key, so it is
not available to individual accounts; Priority Tier usage is not in its cost report).

**So the savings measurement does not depend on any tracker.** This server already contains the instrument, built for exactly this:

1. Define the unit of work (a task) and a quality score the owner trusts.
2. Create an experiment with the A/B module: two arms (baseline route, candidate route), `primary_metric` the cost per task with
   `direction: lower_is_better`, and the quality score as a `guardrail`. `assign_variant` with the task id keeps each task in one arm.
3. Record the cost and the quality of every task with `record_metric`, taking the cost from the provider's billing or usage records (cross-check
   with a local log reader if you like, but the billing record decides).
4. Fix the sample size before looking (a result is a snapshot; acting on the first significant answer inflates false positives), then read
   `get_experiment_results`. A saving counts only if the cost difference is significant **and** the quality guardrail does not withhold the winner.

**BLOCKED** on a real workload and a quality score; this sandbox has neither. No saving is claimed anywhere in this repo until that has run.
