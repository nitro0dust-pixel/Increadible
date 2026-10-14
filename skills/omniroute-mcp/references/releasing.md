<!-- Copy of docs/RELEASING.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Releasing

How a version of Increadible becomes a release: who does what, on which commit, and how the package is checked. It is written
from the one release so far, `v1.0.2` (2026-10-09), and marks which steps that release actually went through.

A release is three things that must agree: **a version** (`package.json`, `package-lock.json`, `mcpb/manifest.json`), **a commit
on `main`**, and **one package file** with a known SHA-256 that was installed and answered in Claude Desktop. The tag names the
commit; the SHA-256 names the file. The file name alone does not: see section 4.

## 1. Who does what

| Step | Who | Why |
|---|---|---|
| Version bump, CHANGELOG, records | a pull request, like any other change (a Claude session may prepare it) | it goes through CI and review |
| Merge | the owner, or a session with the owner's approval, after CI is green on the exact head and the logs are read | `CLAUDE.md`, branch workflow |
| Install and check in Claude Desktop | the owner | only the owner's machine has the app |
| Push the tag | **the owner** | a Claude session's git access pushes branches only: its tag push for `v1.0.2` was refused (HTTP 403) |
| Check the tag | anyone (a session can, through the GitHub API) | the tag must point at the commit that was built |

## 2. When

Owner decision of 2026-10-09: **tag only after the version was verified in Claude Desktop** (installed, and a tool answered in a
chat). A green CI run is not enough: version 1.0.0 passed CI, installed, and never answered.

## 3. Steps

1. **Bump the version** in one pull request:
   ```sh
   npm version X.Y.Z --no-git-tag-version   # package.json and package-lock.json only
   ```
   then set the same version by hand in two more places: `"version"` in `mcpb/manifest.json`, and `VERSION` in `src/version.ts`
   (from 1.0.4; before, `SERVER_INFO` in `src/server.ts`): the version the server reports to Claude Desktop, in its `ready on stdio`
   line, and in the gateway's User-Agent (`increadible-gateway/<version>`). Run `node scripts/mcpb.js problems` (it must
   print `mcpb: manifest is consistent with package.json`) and the **whole** `npm test`. Leaving either place behind is caught: a manifest
   left behind makes `problems` exit 1 and 14 tests fail; `VERSION` left behind fails a test in `tests/mcpb.test.ts` (checked again for 1.0.4: 1.0.3 left in `src/version.ts` failed it) and, after a
   build, the banner test in `tests/entry-point.test.ts`. (The first rehearsal, on 2026-10-09, ran only `tests/config.test.ts` and
   `tests/mcpb.test.ts` and missed `SERVER_INFO`; it was found when 1.0.3 was made, and the direct test was added then.)
2. **CHANGELOG:** say under `## [Unreleased]` that the version is X.Y.Z. The entries move to `## [X.Y.Z] - YYYY-MM-DD` (the tag's date) in the pull request that records the tag, so that no release date is written before the version answered in Claude Desktop (as for `v1.0.2`, whose section was written after its tag).
3. **Merge** after CI is green on the exact head, logs read. Note the merge commit `C` on `main`.
4. **Read the package's SHA-256 from two independent builds of `C`:**
   - CI: the `main` run for `C`, job *Type-check, lint, build, smoke*, step `npm run mcpb`, line `mcpb: N files, B bytes, sha256 H`
     (the same file is kept as the run's artifact `increadible-mcpb`);
   - a local build of exactly that commit, nothing from the working copy:
     `git worktree add ../rel C && cd ../rel && npm ci && npm run mcpb` prints the same line
     (`scripts/cleanroom.sh` does not build the package: `verify` stops at build and smoke).

   The two must be equal. The build is reproducible: Linux, the owner's Windows machine and CI gave the same SHA-256 for 1.0.2
   (`docs/INSTALL-CLAUDE-DESKTOP.md`, section 5.4).
5. **Install that file in Claude Desktop** and check it (`docs/INSTALL-CLAUDE-DESKTOP.md`, sections 4 and 5): a tool answers in a
   new chat. Record the SHA-256 of the installed file.
6. **Tag** (owner, from a clone with push rights):
   ```sh
   git fetch origin main
   git tag -a vX.Y.Z C -m "vX.Y.Z: <one line>"
   git push origin vX.Y.Z
   ```
7. **Check the tag:** `git ls-remote --tags origin vX.Y.Z` and `git rev-parse vX.Y.Z^{commit}` must give `C` (for `v1.0.2` this was
   checked through the GitHub API: tag object `f6f62c46`, commit `64cdefb`).
8. **Record it:** the CHANGELOG header, the release row in `ROADMAP.md` ("Open decisions"), a row in `docs/BUILD-HISTORY.md`, the
   skill's status table, then `node scripts/skill.js sync` and `npm test`.

What `v1.0.2` went through: steps 1, 3, 4 (CI and local builds, same SHA-256 `3594d5fd...`), 5, 6, 7 and 8. Its CHANGELOG section was
written after the tag (PR #41), which is now step 2. `v1.0.3` went through all eight steps, in order: version bump
and CHANGELOG note (PR #47), merge (`916206f`, its tree equal to the CI-verified head `af43e10`), the package SHA-256 from CI and from
a local build (`1fd5ac75...`, equal), the owner's install and live calls in Claude Desktop, the owner's annotated tag (object
`5dd6620d`, 2026-10-10 00:34 UTC, unsigned), its check through the GitHub API (it points at `916206f`), and the records (the PR that
moved the CHANGELOG to `[1.0.3]`). `v1.0.4` went through all eight steps: version bump
and CHANGELOG note (PR #64), merge (`73c5f4d`, 2026-10-14, its tree equal to the CI-verified head `e3a9bcb`), the package SHA-256
`24ee7a6f...` from CI (`main` run 38506367869), from a local build in the authoring sandbox and from the owner's own build on Windows
(all three equal; the owner built it because the file sent from the session was not found on their PC), the owner's install in
Claude Desktop where `get_api_stats` answered with the fields that exist only from 1.0.4 (`default_rate_limit` 5, `retries`), the
owner's annotated tag (object `aeba41b2`, 2026-10-14 03:56 UTC, unsigned), its check through the GitHub API (it points at
`73c5f4d`), and the records. **Not verified before the tag:** the setting Contact for providers reaching the server. Both
`get_api_stats` answers in Claude Desktop said `user_agent_has_contact: false`; the same built server, started the way the manifest
starts it, says `true` with an email address in `GATEWAY_CONTACT` and `false` with a plain name, so the setting was either not saved
or not an email address or URL. The owner tagged with that check open. The owner installed the final 1.0.3 file (`1fd5ac75...`); the first test build (`c9eef367...`, same server code) was also downloaded, which is why the file name alone cannot tell them apart.

## 4. A version number names one file only once it is released

After a tag, any change that reaches the package changes its bytes, so the next release needs a new version, even if the server
code did not change. This has already happened: **`main` still says 1.0.2, but builds a different file from the tagged `v1.0.2`.**

| Build of | Version | SHA-256 | Why it differs |
|---|---|---|---|
| `64cdefb` (tag `v1.0.2`) | 1.0.2 | `3594d5fd878053f0c53a38b1a9850d440a65df9f4cb036e663c895f12e103aee` | the released, installed file |
| `main` at `fa9fa6b` (PR #42) | 1.0.2 | `2cdbf12ffa080df256fba3574f36369e6e91842f6c102b492f8295cd0ccd5dcc` | PR #39 made the license proprietary: the package carries the new `LICENSE` and the manifest's `license` field |
| `main` at `e1263f1` (PR #43) | 1.0.2 | `e02337fbbceba6b21377d71a8e8f7afcb49f65f70b023b65890daf0d32d205c1` | PR #43 changed the server code (the unknown-variant error); from the CI log of `main` run 38002470893 |

The first two were built in the authoring sandbox on 2026-10-09 with `npm ci && npm run mcpb` (the second also by CI, run
38001341055, with the same SHA-256); the third is CI's build. All three files are called `increadible-1.0.2.mcpb`. So: **the next release is 1.0.3 or later**, never a second 1.0.2, and a file is identified by its SHA-256,
not its name.

## 5. Not done

- **No GitHub Release page.** The `.mcpb` is not attached to `v1.0.2` anywhere on GitHub; it is downloadable only as the CI
  artifact of a run (kept for the repository's artifact retention period) or by building the tagged commit. Creating a Release is
  an owner action (the session has no tool for it). **NOT DONE.**
- **No signature** on the tag (annotated, unsigned) or on the package (the vendor's tool reports "Not signed"); code signing is an
  open owner decision in `ROADMAP.md`.
- **No automation:** nothing in CI builds, tags or publishes on a tag push. This document is the procedure; it is not enforced
  beyond the version-consistency checks in step 1.
