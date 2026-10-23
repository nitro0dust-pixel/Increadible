# Driving the drivers with agents: `drive:all` and the two workflows

[DRIVERS.md](DRIVERS.md) describes the four request drivers and what they check. This document is Stage 3 of the plan for drivers: running **all** of them
at once (`npm run drive:all`, no agents, no model), and two **multi-agent workflows** in `workflows/` that put separate agents around that run so that nobody
judges their own work. The workflows are an option: everything they rely on works without them.

| | |
|---|---|
| Status | `drive:all` and both workflow scripts are built and tested (section 11). The orchestration rules of the workflows are tested with stand-ins for the agents. **The two workflows have not been run with real agents: NOT VERIFIED** (section 11) |
| Cost | `drive:all` costs seconds and no tokens. `drive-gate` is 4 agents with the defaults (1 Testing runner, 3 critics). `engineer-loop` is 2 agents to prepare and 4 per round (default 3 rounds, at most 7): up to 30 agents. Read section 10 before starting one |
| Nothing here deploys | No workflow pushes, merges, opens a pull request, publishes an image or touches production or another repository. A deployment to production needs a human's explicit approval (section 8) |
| Windows, a real provider, Claude Desktop itself | **NOT VERIFIED / NOT AVAILABLE** here, as in DRIVERS.md |

## 1. Which tool answers which question

| Question | Use | Agents | What you get |
|---|---|---|---|
| "Do all the drivers pass on this checkout, right now?" | `npm run drive:all` | none | one table, an exit code (section 2) |
| "Do they pass, is the evidence complete, did the run behave safely, and can the gate fail at all?" | the workflow `drive-gate` | 1 runner per run + 3 critics | PASS, FAIL or REVIEW_REQUIRED with reasons, evidence and findings (section 4) |
| "Build or fix something, with separate agents testing and criticising it, and hand me a patch." | the workflow `engineer-loop` | research, planning, then 4 per round | a local branch and four reports, never a push (section 5) |

## 2. `npm run drive:all` (no agents)

```
npm run build
npm run mcpb                          # only for the bundle jobs
npm run drive:all
npm run drive:all -- --only stdio,http --scenario basic,gateway --concurrency 2
npm run drive:all -- --list           # the jobs it would run
npm run drive:all -- --json > drive-all.json
```

`scripts/drive-all.js` runs the jobs side by side: **stdio, http and bundle once per shipped scenario** (all of `scripts/drive-scenarios/`) **and the probe once**: 13
jobs today. Each job is one driver process, started with `--json`, with its own port and work directory; the drivers share nothing (DRIVERS.md section 10 records twelve at
once and sixteen http runs at once). The default concurrency is four, the default deadline per job 180 s.

| Option | Meaning |
|---|---|
| `--only a,b` | the drivers to run: `stdio`, `http`, `probe`, `bundle` |
| `--scenario a,b` | the scenarios for stdio, http and bundle (default: all that ship) |
| `--root DIR`, `--bundle FILE` | a checkout other than this one (stdio, http, probe), a package other than `dist/mcpb/<name>-<version>.mcpb` (bundle) |
| `--concurrency N`, `--timeout-s N` | at most N jobs at once; a job that has no verdict after N seconds is stopped (TIMEOUT) |
| `--expect FILE`, `--no-expect` | the file of expected step counts (default `scripts/drive-expected.json`), or none |
| `--json`, `--list` | one JSON report instead of the table; list the jobs and stop |

```
job                   result  steps  time     note
stdio:ab-statistics   PASS    23/23  176 ms
stdio:basic           PASS    19/19  168 ms
...
probe                 PASS    27/27  1873 ms

PASS: 13 of 13 jobs passed
```

How a job is judged, beyond what its driver says:

| Result | When |
|---|---|
| `PASS` | the driver exited 0, every step is ok, and the number of steps is the one in `scripts/drive-expected.json` |
| `FAIL` | a step failed (which one and why are printed), or the driver's exit code or report says not ok, or **the number of steps differs from the expected one even though all passed** (a driver or scenario that quietly lost steps) |
| `TIMEOUT` | no verdict within the deadline |
| `CANNOT RUN` | the driver exited 2 or printed no report; the first line of what it said is shown |

The run fails as a whole (exit code 1) when any job is `FAIL` or `TIMEOUT`, **or when a driver left one of its work directories (`increadible-drive-*`) behind in the temporary folder**. It exits 2 when
no job could be judged, and before starting anything when the build or the package is missing (the message names `npm run build` or `npm run mcpb`). Exit 0 is every job passing.
`scripts/drive-expected.json` is changed together with the scenario or driver that changes it, in the same pull request; a test checks that it covers exactly the jobs of the default plan and equals each
scenario's steps plus the steps its driver adds.

## 3. The workflows: how to start one

The workflows are scripts for Claude Code's **Workflow** tool. A workflow starts many agents, so Claude Code runs one only when you ask for multi-agent orchestration in your own words. Say, in a session in
this repository:

```
Use a workflow: run workflows/drive-gate.js on this checkout.
```

or with arguments:

```
Use a workflow: run workflows/engineer-loop.js with
  task: "Make drive-all print the slowest job",
  run_id: "20261020-1500", max_iterations: 3, sprint: 4
```

Claude passes the file as `scriptPath` and the arguments as `args`. Watch it with `/workflows`. The result comes back to the conversation when it ends. To use a script by name (`Workflow` with `name: "drive-gate"`)
copy it to `.claude/workflows/`; `.claude/` is ignored by git, so the copy stays on your machine. A script can be run again from where it stopped (`resumeFromRunId`), and finished agents are not run again.

## 4. `drive-gate`: run, then criticise, then decide

```
Run (Testing)  ->  Critique (Validation, Security, Adversarial tester)  ->  Verdict (Orchestrator)
```

| Arguments | Meaning |
|---|---|
| `repo` | the checkout to judge (default: the current directory) |
| `evidence_dir` | where the raw reports are kept (default `/tmp/drive-gate-evidence`, outside the repository) |
| `runs` | `[{ label, path_prefix }]`: one runner per entry, in parallel: the same checkout under two Node versions, for example. `path_prefix` goes in front of `PATH` |
| `breakages` | how many deliberate server breakages the adversarial tester tries (default 3, 1 to 6) |

| Role | What it does | What it may not do |
|---|---|---|
| **Testing runner** | builds if `dist/` is missing, runs `node scripts/drive-all.js --json` once, keeps the report and its SHA-256, and returns exit code, Node version and git head | interpret the report, retry to make it pass, change tracked files |
| **Validation** | reads the raw report itself; checks that every job is there and has its expected count; re-runs one job of its own choosing and compares; reads DRIVERS.md and ROADMAP.md against the evidence; says what is not covered | trust the runner's summary (it is not given one) |
| **Security** | looks for secret values in the reports; checks that no real provider was called and nothing of the run is still alive (processes, ports, work directories); reads `scripts/drive-all.js` and the recent diff for wider environments, writes outside a temporary folder, followed paths | modify anything |
| **Adversarial tester** | breaks a copy of the server in 3 different places, one at a time, and runs the gate on the copy: every breakage must turn it red | touch the repository |
| **Orchestrator** (the script) | decides from the evidence (below) | approve on its own say-so: it has no opinion, only rules |

The verdict, by the script's rules and in this order: **FAIL** if any run did not exit 0, if a run changed a tracked file, or if a critic says FAIL or reports a blocker;
**REVIEW_REQUIRED** if a critic asks for a human, reports a major finding, or **gave no answer** (a missing review is never a clean one); otherwise **PASS**. The result lists the reasons, the evidence
(report paths and hashes), each critic's verdict and what it checked, the findings, the next actions, and what is not covered. It ends with `deploy: not performed`.

## 5. `engineer-loop`: build with independent criticism, up to 7 rounds

```
Prepare:  Research -> Planning
Round n:  Engineering (own git worktree)  ->  Testing | Security | Validation (three agents, in parallel, none of which wrote the code)
          -> Orchestrator: approve, or recycle with the findings, or stop
```

| Arguments | Meaning |
|---|---|
| `task`, `run_id` | **required**: what to build or fix; a unique short name (3 to 40 letters, digits, `.`, `_`, `-`) for the work area `/tmp/engineer-loop-<run_id>` and the local branch `wf/engineer-loop/<run_id>` |
| `max_iterations` | 1 to 7, default 3 |
| `sprint` | 0 to 5: tells the agents what is in scope (section 7) |
| `verify` | the commands the Testing agent runs in a fresh checkout of each round (default: type-check, lint, `npm test`, build, `node scripts/drive-all.js`) |
| `research` | `false` to skip the Research agent |

The loop is the one the project asks for: **Creation, Comparison, Criticism and Discrimination, Re-creation.** The Engineering agent creates; the Testing, Security and Validation agents compare the result with the plan,
the tests and the rules, and criticise it independently; the Orchestrator discriminates (approve or recycle); the next round re-creates from the previous commit with the findings in hand.

| Role | Responsibility and permission | Communication contract (what it returns) |
|---|---|---|
| **Research** | collects facts with sources (file:line, a command, a URL read); a claim of "trending" or "best practice" without a citation goes to *unknowns* and may not influence the design. Read-only | `facts[{claim, source, verified}]`, `unknowns[]` |
| **Planning** | turns the task into 2 to 8 testable acceptance criteria, files, risks, out of scope; records the base commit. Writes no code | `criteria[]`, `files_likely`, `risks`, `out_of_scope`, `base_sha` |
| **Engineering** | the only role that writes code. Works in its own worktree from the previous round's commit; commits; sets the local branch. Never pushes. Does not decide whether its work is good | `commit`, `worktree`, `summary`, `files`, `deviations`, `not_done` |
| **Testing** | in its own checkout of the commit, runs the verify commands once each; a missing command is "not available", never a pass; never fixes anything | `passed`, `commands[{command, exit_code, summary}]`, `failures`, `not_available` |
| **Security** | reads the diff as an attacker and an operator; **may reject**: a blocker stops approval. A new major dependency is a blocker until a human approves it | `findings[{key, severity, title, evidence, fix}]` |
| **Validation** | checks each acceptance criterion with its own evidence, and the repository's rules on the diff (documents and records move with the code; no invented number or claim) | `criteria[{id, met, evidence}]`, `findings` |
| **Orchestrator** | this script. Approves only if the tests passed, no blocker or major finding stands, every criterion is `yes`, and all three critics answered | the deliverables (section 9) |

**Independence.** The agent that produced something never judges it: the critics receive the commit, the plan and the rules, not the Engineering agent's summary; they do not see each other's answers. If a critic gives no answer the round is not approved.

**Stopping.** The loop stops (1) when a round is approved, status `APPROVED_FOR_HUMAN_REVIEW`; (2) after `max_iterations` rounds without approval, `NOT_APPROVED_MAX_ROUNDS`; (3) when a round finds exactly
what the round before it found, `STALLED_SAME_FINDINGS_TWICE`: no better proven alternative is being reached, and more rounds would only spend tokens; (4) when the Engineering agent gives nothing,
`STOPPED_NO_ENGINEERING_RESULT`. Never more than 7 rounds, whatever is asked.

## 6. Evidence thresholds

| Rule | Where it is enforced |
|---|---|
| A claim needs a source: file:line, a command and its output, or a URL read | Research must give one or file it under *unknowns*; Validation flags a claim in the diff that nothing proves |
| "Trending", "viral" or "best practice" may not influence the architecture without citations to live implementations, benchmarks or official documentation | Research; Validation |
| A check that cannot fail proves nothing | the adversarial tester of `drive-gate`; the project's rule to break every new guard on purpose; the test suite `tests/workflows.test.ts` |
| A missing answer is not a clean answer | the Orchestrator of both workflows |
| NOT VERIFIED, NOT AVAILABLE, BLOCKED instead of "works" | in the rules every agent is given |

## 7. Sprint states

`sprint` (0 to 5) only tells the agents what is in scope. It changes no rule.

| Sprint | Scope |
|---|---|
| 0 | Discovery and audit: read, measure and report; change nothing but documents |
| 1 | Critical fixes: security, data loss and correctness only; no new features |
| 2 | Architecture and scalability: structure and limits; behaviour stays the same |
| 3 | UX and UI: how it is used and read; accessibility |
| 4 | Feature additions: new capability, each with tests and documents |
| 5 | Optimisation and SEO/conversion: measured improvements only |

## 8. Quality gates, rollback, and who may deploy

| Gate | Where | Fails when |
|---|---|---|
| Automated tests, type-check, lint, build | `engineer-loop` Testing (`verify`) | any command exits non-zero |
| The request drivers | `drive:all` (inside `verify`, and in `drive-gate`) | any job is not PASS, or has the wrong number of steps, or leaves a work directory behind |
| Security review | `engineer-loop` Security; `drive-gate` Security | a blocker, or a major finding |
| Acceptance criteria and rules | `engineer-loop` Validation; `drive-gate` Validation | a criterion is `no` or `unknown` |
| UI/UX audit, accessibility checks, SOC 2 / GDPR compliance scans | **NOT AVAILABLE**: this repository has no UI and no scanner for either; the Security critic reads the diff and does not claim a compliance result | |

**Rollback** is deleting what the run made; nothing of the repository's own branches is touched:

```
git worktree list                                   # the run's worktrees are under /tmp/engineer-loop-<run_id>/
git worktree remove --force /tmp/engineer-loop-<run_id>/round-1     # and round-2, test-1, ...
git branch -D wf/engineer-loop/<run_id>             # the local branch of the run
rm -rf /tmp/engineer-loop-<run_id> /tmp/drive-gate-evidence
```

**Production authority.** Agents here may research, read and run code, change code in their own worktree, test, and leave a branch for a human. **They do not push, open or merge pull
requests, build or push images, or deploy anything, and the workflows do not ask them to.** Merging is the owner's decision; deploying to production needs the owner's explicit approval. A pull request made from an
`engineer-loop` branch is made by a person (or by a session the person tells to), after reading `how_to_take_it`.

## 9. The deliverables

`engineer-loop` returns one object. The deliverables of the plan are fields of it (`drive-gate` returns the verdict object of section 4):

| Deliverable | Field |
|---|---|
| Audit report / facts | `facts`, `plan.risks`, `plan.out_of_scope` |
| Backlog / not done | `implementation_log[].not_done`, the findings still standing in the last round |
| Architecture plan | `plan` (criteria, files, risks) |
| Staging-ready code | `local_branch` and `final_commit` (a local branch; nothing pushed); `how_to_take_it` says how to read the diff |
| Automated tests report | `test_report[]` (per round: commands, exit codes, failures, what is not available) |
| Security report | `security_report[]` |
| UI/UX specification | not produced (no UI in this repository) |
| Deployment plan | not produced: a deployment needs a human (section 8) |
| Implementation log | `implementation_log[]` (per round: commit, summary, files, deviations, approved) |
| Verdict | `status`, `approved`, `rounds_run` |

## 10. Cost, limits and good habits

- Count the agents before you start: `drive-gate` 4; `engineer-loop` 2 + 4 per round, so 14 for the default 3 rounds and up to 30 for 7. Each reads files and runs commands. A usage limit that stops a workflow in the middle loses
  the agents in flight (it happened to the first review of Stage 1); finished agents are kept and a resume does not run them again.
- Start with `max_iterations: 2` for a first try, and with `breakages: 2`.
- The agents run in this checkout: do not edit tracked files while a workflow runs, and do not start two `engineer-loop` runs with one `run_id`.
- `engineer-loop` needs `git worktree`; it uses `/tmp/engineer-loop-<run_id>/` and a local branch `wf/engineer-loop/<run_id>`.
- The scripts are plain JavaScript run by the tool, not by Node: they cannot read files or start processes themselves, and may not use the clock or randomness (so a resume is exact). Everything they do, an agent does.

## 11. How this was tested, and what is not verified

| Check | Result |
|---|---|
| `scripts/drive-all.js` | `tests/drive-all.test.ts`: planning, expected counts, judging (every status), the verdict, concurrency, the table, and the whole as a process against the server compiled from these sources: pass; a server broken in one place (only the driver that looks at it goes red); wrong expected count; a driver that leaves a directory behind; no build; no package; bad options |
| Workflow scripts as files | `tests/workflows.test.ts`: the meta is a pure literal and matches the file name; the body compiles as plain JavaScript; phase titles match the meta; no clock or randomness; no push, merge or deploy in the instructions |
| The rules of the orchestration | `tests/workflows.test.ts` runs both scripts with stand-ins for the agents: who may approve (all three critics, tests passed, no blocking finding, every criterion `yes`); a missing answer; the limit of 7 rounds; the stall rule; the order of the agents; what each prompt must contain; the verdict of `drive-gate` in each case |
| Breaking the scripts on purpose | `docs/DRIVERS.md` section 9, rounds 7 and 8: `drive-all.js` 30 breakages, the two workflow scripts 40 |
| A real run of `drive-gate` and of `engineer-loop` | **NOT VERIFIED.** The session that built them could not start the Workflow tool (it was no longer offered to it), so both scripts were run only with stand-ins for the agents. Run `drive-gate` once on a clean checkout (section 3 says how) and write what it returned (the verdict, the reasons, where the evidence files are, what it cost) into `docs/BUILD-HISTORY.md` and here before relying on it; a small `engineer-loop` after that |
| Windows; a real provider; the quality of an LLM's judgement | **NOT VERIFIED / NOT AVAILABLE**. A critic is a model: it can be wrong in both directions. The gates of section 8 that are deterministic (tests, drivers, exit codes) do not depend on one; the critics add judgement and are not a proof |
