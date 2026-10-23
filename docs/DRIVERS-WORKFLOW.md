# Driving the drivers with agents: `drive:all` and the two workflows

[DRIVERS.md](DRIVERS.md) describes the four request drivers and what they check. This document is Stage 3 of the plan for drivers: running **all** of them
at once (`npm run drive:all`, no agents, no model), and two **multi-agent workflows** in `workflows/` that put separate agents around that run so that nobody
judges their own work. The workflows are an option: everything they rely on works without them.

| | |
|---|---|
| Status | `drive:all` and both workflow scripts are built and tested (section 11). The decision rules of the workflows are tested with stand-ins for the agents. **The two workflows have not been run with real agents: NOT VERIFIED** (section 11) |
| Cost | `drive:all` costs seconds and no tokens. `drive-gate` is 4 agents with the defaults (1 Testing runner, 3 critics). `engineer-loop` is 2 agents to prepare and 4 per round (default 3 rounds, at most 7): up to 30 agents. Read section 10 before starting one |
| Nothing here deploys | No workflow is told to push, merge, open a pull request, publish an image or touch production or another repository. A deployment to production needs a human's explicit approval (section 8). What stops an agent that disobeys is **not** a technical barrier: see "The rules are prose" in section 8 |
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
npm run mcpb                          # only for the bundle jobs (and after every npm run build: the build removes dist/mcpb)
npm run drive:all
npm run drive:all -- --only stdio,http --scenario basic,gateway --concurrency 2
npm run drive:all -- --list           # the jobs it would run
npm run --silent drive:all -- --json > drive-all.json    # --silent: without it npm writes its own two banner lines first and the file is not JSON
node scripts/drive-all.js --json > drive-all.json        # the same, without npm
```

`scripts/drive-all.js` runs the jobs side by side: **stdio, http and bundle once per shipped scenario** (all of `scripts/drive-scenarios/`) **and the probe once**: 13
jobs today. Each job is one driver process, started with `--json`, with its own port and work directory; the drivers share nothing (DRIVERS.md section 10 records twelve at
once and sixteen http runs at once). The default concurrency is the number of CPUs, at most four; the default deadline per job is 180 s.

| Option | Meaning |
|---|---|
| `--only a,b` | the drivers to run: `stdio`, `http`, `probe`, `bundle` |
| `--scenario a,b` | the scenarios for stdio, http and bundle (default: all that ship) |
| `--root DIR`, `--bundle FILE` | a checkout other than this one (stdio, http, probe), a package other than `dist/mcpb/<name>-<version>.mcpb` (bundle) |
| `--concurrency N`, `--timeout-s N` | at most N jobs at once; a job that has no verdict after N seconds is stopped (TIMEOUT), at most 86400 |
| `--expect FILE`, `--no-expect` | the file of expected step counts (default `scripts/drive-expected.json`), or none; the two exclude each other |
| `--json`, `--list` | one JSON report instead of the table; list the jobs and stop |

A real run (this checkout, 2026-10-23; the times are one machine on one day and mean nothing else):

```
job                   result  steps  time     note
stdio:ab-statistics   PASS    29/29  313 ms
stdio:basic           PASS    19/19  189 ms
stdio:gateway         PASS    39/39  192 ms
stdio:routing-rules   PASS    31/31  147 ms
http:ab-statistics    PASS    32/32  701 ms
http:basic            PASS    22/22  261 ms
http:gateway          PASS    42/42  269 ms
http:routing-rules    PASS    34/34  280 ms
probe                 PASS    27/27  1874 ms
bundle:ab-statistics  PASS    32/32  538 ms
bundle:basic          PASS    22/22  231 ms
bundle:gateway        PASS    42/42  245 ms
bundle:routing-rules  PASS    34/34  213 ms

PASS: 13 of 13 jobs passed
```

How a job is judged, beyond what its driver says:

| Result | When |
|---|---|
| `PASS` | the driver exited 0, its report says ok, every step of **every** result in the report is ok (not only the first), and the number of steps is the one in `scripts/drive-expected.json` |
| `FAIL` | a step failed (which one and why are printed), or the driver's exit code or report says not ok, or the report holds **no step at all** (nothing was checked), or **the number of steps differs from the expected one even though all passed** (a driver or scenario that quietly lost steps) |
| `TIMEOUT` | no verdict within the deadline; the driver and everything it started are stopped (below) |
| `CANNOT RUN` | the driver exited 2 or printed no report; the first line of what it said is shown (a line of stdout that is not a report is shown too) |

| Exit code | Meaning |
|---|---|
| 0 | every job passed, and no job left a work directory behind |
| 1 | a job is `FAIL` or `TIMEOUT`, **or a driver left one of its work directories (`increadible-drive-*`) behind**, or some (not all) jobs are `CANNOT RUN` |
| 2 | nothing could be judged: every job is `CANNOT RUN`, or there was no job, or before starting anything the build or the package is missing (the message names `npm run build` or `npm run mcpb`), or the options are wrong |

**The private temporary folder.** `drive-all` makes one temporary folder of its own for the run and gives it to every driver as `TMPDIR`, `TEMP` and `TMP`; the drivers make their work directories
in it. So what is "left behind" is exactly what *these* drivers left, and another run, a reviewer's run or an earlier crash cannot make this run fail (or hide a leak). The folder is removed at the end.
Each driver also runs in a **process group of its own** (not on Windows: NOT VERIFIED there): a timeout or an interruption of `drive-all` ends the driver and the server it started, and a driver
that ignores SIGTERM cannot leave its server running.

`scripts/drive-expected.json` is changed together with the scenario or driver that changes it, in the same pull request; a test checks that it covers exactly the jobs of the default plan and equals each
scenario's steps plus the steps its driver adds.

## 3. The workflows: how to start one

**Prerequisite: Claude Code's `Workflow` tool.** The workflows are scripts for it. It is offered only in some sessions and builds; if your session does not list it, none of this section can be done there.
(The session that built these scripts was not offered the tool: **a real run is NOT VERIFIED**, section 11.) A workflow starts many agents, so Claude Code runs one only when you ask for
multi-agent orchestration in your own words. Say, in a session in this repository:

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
These names (`Workflow`, `scriptPath`, `args`, `/workflows`, `resumeFromRunId`, `.claude/workflows/`) come from the tool's description as the author of the scripts knew it; they were **not tried** (section 11).

The scripts refuse arguments that do not fit before any agent starts: what you give ends up inside shell commands the agents are told to run, so paths are letters, digits and `/ . _ -` only.

## 4. `drive-gate`: run, then criticise, then decide

```
Run (Testing, one runner after the other)  ->  Critique (Validation, Security, Adversarial tester, in parallel)  ->  Verdict (Orchestrator)
```

| Arguments | Meaning |
|---|---|
| `repo` | absolute path of the checkout to judge (default: the current directory) |
| `evidence_dir` | where the raw reports are kept (default `/tmp/drive-gate-evidence`, outside the repository); an absolute path |
| `runs` | 1 to 4 entries `{ label, path_prefix }` with different labels: the same checkout under two Node versions, for example. `path_prefix` goes in front of `PATH`. **The runners go one after the other**: each builds the checkout, and the build removes `dist/` first, so two at once would pull the build from under each other |
| `breakages` | how many deliberate server breakages the adversarial tester tries (default 3, 1 to 6) |

| Role | What it does | What it may not do |
|---|---|---|
| **Testing runner** | notes the git state, runs `npm run build` and `npm run mcpb` (so that what is run is this commit), runs `node scripts/drive-all.js --json` **once** into a file of its own, keeps the SHA-256, and returns exit code, Node version, git head and whether tracked files changed | interpret the report, retry to make it pass, change tracked files |
| **Validation** | reads the raw report itself; checks that every job is there and has its expected count; re-runs one job of its own choosing and compares; reads DRIVERS.md and ROADMAP.md against the evidence; says what is not covered; **reports for every report file the `verdict` it read and the SHA-256 it computed** | trust the runner's summary (it is not given one) |
| **Security** | looks for secret values in the reports; checks that no real provider was called and nothing of the run is still alive (processes, ports, work directories), waiting until the other critics' drivers are gone; reads `scripts/drive-all.js` and the recent diff for wider environments, writes outside a temporary folder, followed paths | modify anything |
| **Adversarial tester** | breaks a copy of the server's `dist/` in 3 different places, one at a time, and runs the gate (`--only stdio,http --root <copy>`) on the copy: every breakage must turn it red | touch the repository |
| **Orchestrator** (the script) | decides from the evidence (below) | approve on its own say-so: it has no opinion, only rules |

**The rules of the verdict.** Every answer is checked for its shape before it counts; **an answer of the wrong shape is a missing answer**, and nothing an agent says is taken at its word.

| Verdict | When (in this order) |
|---|---|
| **FAIL** | a run's answer is unusable (not an object, wrong label, no integer exit code, no report path or hash) or its agent failed; or a run's exit code is not 0; or a run did not say that no tracked file changed (`false` is the only passing answer); or **the Validation critic's own reading disagrees with the runner's**: a different SHA-256 for a report, or a report verdict that does not match the exit code; or a critic says FAIL (any spelling that starts with FAIL) or lists a **blocker**; |
| **REVIEW_REQUIRED** | otherwise: a critic gave no usable answer (a missing review is never a clean one, including a malformed one), or a critic asks for a human, or lists a finding that is not minor (**an unknown severity counts as blocking**, a spelling must not make a finding harmless), or the Validation critic did not report what a report file says |
| **PASS** | every run exited 0, the Validation critic confirmed each report's hash and verdict, and every critic said PASS with minor findings at most |

The result lists the reasons, the evidence (report paths, hashes, Node versions, git heads), each critic's verdict and what it checked (a critic with no usable answer is shown as `NO ANSWER`), the findings, the
next actions, and what is not covered. It ends with `deploy: not performed`.

## 5. `engineer-loop`: build with independent criticism, up to 7 rounds

```
Prepare:  Research -> Planning
Round n:  Engineering (own git worktree)  ->  Testing | Security | Validation (three agents, in parallel, none of which wrote the code)
          -> Orchestrator: approve, or recycle with the findings, or stop
```

| Arguments | Meaning |
|---|---|
| `task`, `run_id` | **required**: what to build or fix; a unique short name (3 to 40 letters, digits, `_`, `-`, starting with a letter or digit) for the work area `/tmp/engineer-loop-<run_id>` and the local branch `wf/engineer-loop/<run_id>` |
| `repo` | absolute path of the checkout (default: the current directory) |
| `max_iterations` | 1 to 7, default 3 (anything else is clamped; never more than 7) |
| `sprint` | 0 to 5: tells the agents what is in scope (section 7) |
| `verify` | the commands the Testing agent runs in a fresh checkout of each round (at most 12 one-line commands; default: `npm run type-check`, `npm run lint`, `npm test`, `npm run build`, `npm run mcpb`, `node scripts/drive-all.js`) |
| `research` | `false` to skip the Research agent |

The loop is the one the project asks for: **Creation, Comparison, Criticism and Discrimination, Re-creation.** The Engineering agent creates; the Testing, Security and Validation agents compare the result with the plan,
the tests and the rules, and criticise it independently; the Orchestrator discriminates (approve or recycle); the next round re-creates from the previous commit with the findings in hand.

| Role | Responsibility and permission | Communication contract (what it returns) |
|---|---|---|
| **Research** | collects facts with sources (file:line, a command, a URL read); a claim of "trending" or "best practice" without a citation goes to *unknowns* and may not influence the design. Read-only | `facts[{claim, source, verified}]`, `unknowns[]` |
| **Planning** | turns the task into acceptance criteria (the prompt asks for 2 to 8; the script requires at least one, each with its own id), files, risks, out of scope; records the base commit (a hash, or the script stops before any code is written). Writes no code | `criteria[{id, statement, how_to_check}]`, `files_likely`, `risks`, `out_of_scope`, `base_sha` |
| **Engineering** | the only role that writes code. Works in its own worktree from the previous round's commit; stages files by name; commits; sets the local branch. Never pushes. Does not decide whether its work is good | `commit`, `worktree`, `summary`, `files`, `deviations`, `not_done` |
| **Testing** | in its own checkout of the commit, runs the verify commands once each; a missing command is "not available", never a pass; never fixes anything | `commit`, `branch_commit`, `passed`, `commands[{command, exit_code, summary}]`, `failures`, `not_available` |
| **Security** | reads the diff as an attacker and an operator; **may reject**: a blocker stops approval. A new major dependency is a blocker until a human approves it | `findings[{key, severity, title, evidence, fix}]` |
| **Validation** | checks each acceptance criterion with its own evidence, and the repository's rules on the diff (documents and records move with the code; no invented number or claim; no node_modules or dist in the diff) | `criteria[{id, met, evidence}]`, `findings` |
| **Orchestrator** | this script. Approves only on the conditions below | the deliverables (section 9) |

**Independence.** The agent that produced something never judges it: the critics receive the commit, the plan and the rules, not the Engineering agent's summary; they do not see each other's answers.

**What approval needs.** A round is approved only if **all** of these hold, checked by the script on the shapes of the answers, not on anyone's say-so:

| Condition | Where it comes from |
|---|---|
| all three critics answered, with the lists asked for | a missing or malformed answer is a *gap* and blocks approval |
| the Testing agent says `passed: true`, lists no failure, ran at least one command, **and every command it lists exited 0** | the whole Testing answer is checked, not only `passed` |
| the Testing agent judged **the commit to judge** and found **the local branch at that commit** | `commit` and `branch_commit` against the Engineering agent's commit (hash prefixes count as equal) |
| no Security or Validation finding is standing, **except minor ones**: a severity that is missing or spelled oddly counts as blocking | `severity`, lower-cased |
| **every** criterion of the plan is judged `yes` by the Validation agent | criteria are matched **by id**; one that is not mentioned, or judged `no`, `unknown` or anything but exactly `yes`, is not met |

**Stopping.** The loop stops (1) when a round is approved, status `APPROVED_FOR_HUMAN_REVIEW`; (2) after `max_iterations` rounds without approval, `NOT_APPROVED_MAX_ROUNDS`; (3) when a round finds exactly
what the round before it found (the same finding keys, unmet criteria, gaps and test problems), `STALLED_SAME_FINDINGS_TWICE`: no better proven alternative is being reached, and more rounds would only spend tokens;
(4) when the Engineering agent gives nothing usable (no result, no commit hash, or the commit it started from), `STOPPED_NO_ENGINEERING_RESULT`. Never more than 7 rounds, whatever is asked.
The stall rule compares keys: a critic that renames a standing finding between two rounds hides the repetition, and the loop then runs to `max_iterations`, which is the cap on the cost (known limit, section 11).

## 6. Evidence thresholds

| Rule | Where it is asked for and where it is checked |
|---|---|
| A claim needs a source: file:line, a command and its output, or a URL read | **asked** of Research (a claim without a source goes under *unknowns*) and of Validation (flags a claim in the diff that nothing proves). Nothing in the script can check a source: that is a judgement the critics make |
| "Trending", "viral" or "best practice" may not influence the architecture without citations to live implementations, benchmarks or official documentation | **asked** of Research and Validation, in their prompts; not checked by the script |
| A check that cannot fail proves nothing | the adversarial tester of `drive-gate` (it breaks a copy of the server and the gate must go red); the project's rule to break every new guard on purpose; the mutation rounds of DRIVERS.md section 9 |
| A missing answer is not a clean answer | **checked** by the script in both workflows (sections 4 and 5), and tested |
| NOT VERIFIED, NOT AVAILABLE, BLOCKED instead of "works" | in the rules every agent is given; a test checks that every prompt carries them |

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
| Automated tests, type-check, lint, build | `engineer-loop` Testing (`verify`) | any command exits non-zero, or the Testing answer is missing or not for this commit |
| The request drivers | `drive:all` (inside `verify`, and in `drive-gate`) | any job is not PASS, or has the wrong number of steps, or leaves a work directory behind |
| Security review | `engineer-loop` Security; `drive-gate` Security | a blocker, or any finding that is not minor |
| Acceptance criteria and rules | `engineer-loop` Validation; `drive-gate` Validation | a criterion is not exactly `yes` |
| UI/UX audit, accessibility checks, SOC 2 / GDPR compliance scans | **NOT AVAILABLE**: this repository has no UI and no scanner for either; the Security critic reads the diff and does not claim a compliance result | |

**What a gate is.** The deterministic gates (exit codes, step counts, hashes, the shape of the answers) do not depend on a model. The critics are models: they add judgement, they can be wrong in both directions, and a
critic's PASS is not a proof. A green workflow means that nothing it looked at was red, no more.

**Rollback** is deleting what the run made; nothing of the repository's own branches is touched. `engineer-loop` makes git worktrees whose `node_modules` is a **link** to the repository's own: delete the link
(or the worktree) as shown, never `rm -r` through it.

```
git worktree list                                   # the run's worktrees are under /tmp/engineer-loop-<run_id>/
git worktree remove --force /tmp/engineer-loop-<run_id>/round-1     # and round-2, test-1, ...
git branch -D wf/engineer-loop/<run_id>             # the local branch of the run
rm -rf /tmp/engineer-loop-<run_id> /tmp/drive-gate-evidence /tmp/drive-gate-breaker   # only after the worktrees are removed
```

`git worktree remove --force` deletes the link and not what it points to, and `rm -rf` removes a link as a link (both tried on a scratch repository on 2026-10-23: the target's file was still there afterwards). If a work area is deleted with `rm -rf` while its worktree is still registered, `git worktree list` shows the entry as `prunable` until `git worktree prune`.

**The rules are prose.** "Never push", "never touch production", "leave no process running" are instructions in the agents' prompts. The scripts cannot enforce them: an agent that disobeys, or that runs code
written by the Engineering agent (the Testing agent runs `npm test` on it, in the caller's environment, with the caller's credentials), is stopped by nothing technical. Run a workflow where the environment holds
no credential you would not hand to the code under test (a session without push access to the remote is the strongest rule you can give it). What the scripts do enforce is the *decision*: an approval or a PASS
needs the evidence of section 4 or 5, and a branch that reaches a human is a local branch.

**Production authority.** Agents here may research, read and run code, change code in their own worktree, test, and leave a branch for a human. **They are not asked to push, open or merge pull
requests, build or push images, or deploy anything.** Merging is the owner's decision; deploying to production needs the owner's explicit approval. A pull request made from an
`engineer-loop` branch is made by a person (or by a session the person tells to), after reading `how_to_take_it`.

## 9. The deliverables

`engineer-loop` returns one object. The deliverables of the plan are fields of it (`drive-gate` returns the verdict object of section 4):

| Deliverable | Field |
|---|---|
| Audit report / facts | `facts`, `plan.risks`, `plan.out_of_scope` |
| Backlog / not done | `implementation_log[].not_done`, and in `test_report`, `security_report` and `validation_report` the findings and gaps still standing in the last round (a round also lists its `blocking`, `unmet_criteria`, `gaps` and `problems` in the script's own record) |
| Architecture plan | `plan` (criteria, files, risks) |
| Staging-ready code | `local_branch`, `final_commit` and `base` (a local branch; nothing pushed); `how_to_take_it` says how to read the diff. Not "staging-ready" in any deployed sense: there is no staging here, and nothing says the patch is good until a human reads it |
| Automated tests report | `test_report[]` (per round: commands, exit codes, failures, what is not available) |
| Security report | `security_report[]` |
| Validation report | `validation_report[]` (per round: each criterion with its evidence, and the findings) |
| UI/UX specification | not produced (no UI in this repository) |
| Deployment plan | not produced: a deployment needs a human (section 8) |
| Implementation log | `implementation_log[]` (per round: commit, summary, files, deviations, not_done, approved, and `error` when the round stopped the loop) |
| Verdict | `status`, `approved`, `rounds_run`, `max_rounds`, `work_area`, `production` |

## 10. Cost, limits and good habits

- Count the agents before you start: `drive-gate` 4; `engineer-loop` 2 + 4 per round, so 14 for the default 3 rounds and up to 30 for 7. Each reads files and runs commands. A usage limit that stops a workflow in the middle loses
  the agents in flight (it happened to the first review of Stage 1); finished agents are kept and a resume does not run them again.
- Start with `max_iterations: 2` for a first try, and with `breakages: 2`.
- The agents run in this checkout: do not edit tracked files while a workflow runs, and do not start two `engineer-loop` runs with one `run_id`. `drive-gate` builds the checkout (`dist/` is rewritten; git ignores it).
- `engineer-loop` needs `git worktree`; it uses `/tmp/engineer-loop-<run_id>/` and a local branch `wf/engineer-loop/<run_id>`. A branch of that name that already exists belongs to an earlier run and is left alone
  (the round then ends in `STOPPED_NO_ENGINEERING_RESULT`).
- The scripts are plain JavaScript run by the tool, not by Node: they cannot read files or start processes themselves, and may not use the clock or randomness (so a resume is exact). Everything they do, an agent does.
- Do not run `drive:all` by hand while `drive-gate` runs on the same machine unless you accept noise: `drive-all` is safe to run twice (each run has its own temporary folder), but a Security critic that looks at the
  processes of the machine waits for quiet before it judges.

## 11. How this was tested, and what is not verified

| Check | Result |
|---|---|
| `scripts/drive-all.js` | `tests/drive-all.test.ts`: planning, expected counts, judging (every status, every result of a report, an empty report), the verdict (including nothing to judge), concurrency, the table, the private temporary folder (a leak is found even when another run's directories are around, and none of these drivers' directories reaches the shared folder), the process group of a driver and its server, and the whole as a process against the server compiled from these sources: pass; a server broken in one place (only the driver that looks at it goes red); wrong expected count; a driver that leaves a directory behind; no build; no package; bad options |
| Workflow scripts as files | `tests/workflows.test.ts`: the meta is a pure literal and matches the file name; the body compiles as plain JavaScript; phase titles match the meta; no clock or randomness; the instructions never ask for a push, a merge or a deploy; the node_modules ignore rule matches a link |
| The decision rules | `tests/workflows.test.ts` runs both scripts with stand-ins for the agents: **drive-gate** — the verdict for each case (a run that failed, a malformed run, a run that changed a tracked file or did not say, a critic that failed or is malformed, a blocker, an unknown severity, a hash that differs from the Validation critic's, a verdict that does not match the exit code), the runners in order, the critics after both. **engineer-loop** — who may approve (all three critics, every command exit 0, the right commit and branch, no standing finding, every criterion `yes` matched by id), a missing or malformed answer, the limit of 7 rounds, the stall rule, argument checks, what each prompt must contain |
| Breaking the scripts on purpose | DRIVERS.md section 9 (rounds 7 to 10 for Stage 3): every guard of `drive-all.js` and of the two scripts was broken in a throwaway copy and the tests had to go red; survivors were closed with a test or recorded there |
| Two independent reviews of Stage 3 | DRIVERS.md section 9: a documentation review and a code and security review by agents that had not written it; the findings that were real were fixed (the private temporary folder, the process groups, the fail-closed rules above, this document) and the ones that were not are listed there with the reason |
| A real run of `drive-gate` and of `engineer-loop` | **NOT VERIFIED.** The session that built them could not start the Workflow tool (it was no longer offered to it), so both scripts were run only with stand-ins for the agents. The prompts have therefore never been read by a model that acted on them, and the tool's names and options in section 3 are from its description. Run `drive-gate` once on a clean checkout (section 3 says how) and write what it returned (the verdict, the reasons, where the evidence files are, what it cost) into `docs/BUILD-HISTORY.md` and here before relying on it; a small `engineer-loop` after that |
| Windows; a real provider; the quality of an LLM's judgement | **NOT VERIFIED / NOT AVAILABLE**. A critic is a model: it can be wrong in both directions. The gates of section 8 that are deterministic (tests, drivers, exit codes, hashes) do not depend on one; the critics add judgement and are not a proof |

**Known limits** (kept because they were found and left, not fixed): the drivers do not check the value of `protocolVersion` in the initialize answer, only that it is a string (the adversarial tester is told not to
spend a breakage there); the stall rule compares keys, so a renamed finding hides a repetition (the cap on rounds is the bound); the scenarios hold no experiment whose p-value lies between about 1.9e-16 and 0.96, and
the branch of the A/B statistics for 30 samples per variant is not reached by any scenario; the prose rules of section 8.
