## Summary

What changed and why, in a few lines. Link the `ROADMAP.md` item or audit finding it belongs to.

## Evidence

| Check | Result |
|---|---|
| Tests (`npm test`) | suites / passed / todo |
| Type-check and lint | clean? |
| Clean room (`bash scripts/cleanroom.sh`) | Node 22 and 24, or `NOT AVAILABLE` |
| New guard broken on purpose | what was broken, that it failed, that it was restored |
| CI on the exact head (logs read, not just the tick) | run id; Tests summary; `probe: OK`; `prometheus: OK` |

## Record updated (docs move with code)

- [ ] The documents this change touches (`docs/README.md` lists them)
- [ ] A row in `docs/BUILD-HISTORY.md`
- [ ] `ROADMAP.md` (status with evidence) and `CHANGELOG.md` (behaviour changes flagged)
- [ ] The global skill: `node scripts/skill.js sync`, then `node scripts/skill.js check` passes

## Not verified

Everything this change claims but did not run (`NOT VERIFIED`, `NOT AVAILABLE`, `BLOCKED`).

## Needs the owner

New dependencies or tools, production or cluster actions, license, secrets, anything in `ROADMAP.md` "Open decisions".
