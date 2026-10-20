<!-- Copy of CONTRIBUTING.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Contributing

This file is for anyone who changes the code or the documents: the owner, a collaborator, or a Claude session. The stable facts and
the working rules for Claude sessions are in [CLAUDE.md](CLAUDE.md); the status and the open decisions are in [ROADMAP.md](ROADMAP.md).

## Set up

```bash
git clone https://github.com/nitro0dust-pixel/Increadible.git && cd Increadible
npm ci
npm run verify          # type-check, lint, tests, build, smoke (+ Docker and promtool when present)
```

Node 22 or newer (24 recommended). On Windows the `*.sh` scripts need Git Bash or WSL, and 8 tests in four suites (`ab-boundaries`, `entry-point`, `mcpb`, `scripts`: signals, file modes, directory fsync, promtool) fail on Windows, on unchanged `main` too (reported from the owner's machine on 2026-10-09 by the session that made PR #43; not reproduced here, no Windows): CI on Linux is the test run that counts. `features/01` to `06` are git submodules that the build does not need.

## Branches and pull requests

| Rule | Why |
|---|---|
| Work on a branch, one pull request at a time, squash-merge into `main` | the history stays readable |
| After a squash merge, bring `main` into the work branch with `git fetch origin main && git merge origin/main` and push as a fast-forward | the branch and `main` have the same content but different commits |
| **Never force-push or rewrite history** | recoverability |
| Merge only when CI is green **on the exact head** and the real logs were read (Tests summary, `probe: OK`, `prometheus: OK`), not just the green tick | the first CI run of a probe change failed in the probe script itself |
| Nothing is deployed to production without the owner's explicit approval | `ROADMAP.md`, "Open decisions" |

## The checks

| Command | Checks |
|---|---|
| `npm run type-check`, `npm run lint` | `tsc --noEmit`; ESLint 10 over `src`, features 07 to 09 and `tests` |
| `npm test` | Jest (`-- --coverage` for coverage); fails if a document drifts from the code (`tests/config.test.ts`) |
| `npm run build`, `npm run smoke` | compile to `dist/`; real processes over stdio and HTTP |
| `bash scripts/cleanroom.sh [commit]` | `verify` on exactly what is committed, after `npm ci`; use it for any claim of the form "it passes on commit X" |
| `npm run drive:stdio`, `drive:http`, `drive:probe`, `drive:bundle` | the request drivers ([docs/DRIVERS.md](docs/DRIVERS.md)): real calls to the built server over stdio and HTTP, a protocol probe, and the Desktop package. Run them after a change to a transport, to the server's answers or to the package; the probe's records fail on purpose when a recorded behaviour changes, and the same pull request updates them |
| `node scripts/skill.js check` | the global skill carries the same text as the documents |
| `npm run mcpb`, `node scripts/mcpb.js problems` | build the Claude Desktop package; check `mcpb/manifest.json` against `package.json` (change the manifest whenever a tool, a setting or the version changes: the tests fail otherwise) |

## Rules that have paid for themselves

1. **Evidence over assumption.** Write `NOT VERIFIED`, `NOT AVAILABLE` or `BLOCKED`; never write "works" without a run behind it. No invented numbers.
2. **Break it on purpose.** For every guard or test you add, break exactly the thing it protects, confirm it fails, then restore.
3. **Read the real logs**, not the green tick.
4. **Shell scripts under `pipefail`:** never `cmd | grep -q`; capture into a variable, then match.
5. **Tests that open sockets** read the response (`resume()`) and have a failsafe timer.
6. **Docs move with code.** Every environment variable the code reads is documented and tested.
7. **Secrets:** names only, never values, in code, documents, logs and pull requests.
8. **After every step, update the record:** the documents the step changed ([docs/README.md](docs/README.md) lists them), a row in [docs/BUILD-HISTORY.md](docs/BUILD-HISTORY.md), the status in `ROADMAP.md`, an entry in `CHANGELOG.md`, and the global skill (`node scripts/skill.js sync`). The tests fail if the skill and the documents differ.

When a tool schema changes (`tools/list` is the interface a client builds its calls from): edit its row in `tests/tool-contract.test.ts` on purpose, keep every example running (`tests/schema-examples.test.ts` executes them), put a limit in a schema keyword (`maxItems`, `maxLength`, `minimum`, ...) and never as a number in a description (a test fails on one), and add a row to `tests/schema-no-narrowing.test.ts` for any place where the schema could refuse what the handler accepts.

## A new dependency, tool or service

Do not add a framework, runtime, database, scanner or other major dependency without first writing down why it is needed, what the
existing stack cannot do, the alternatives, the security, maintenance and operational impact, and getting the owner's approval.
Tools run in a scratch copy (as StrykerJS did for the mutation-testing pass) do not touch the repository's dependencies.

## Commit messages and pull request bodies

A short imperative subject, then why. State what was verified and how, and what was not. Do not put a model name in a commit or a pull request.
