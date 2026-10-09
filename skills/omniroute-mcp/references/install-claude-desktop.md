<!-- Copy of docs/INSTALL-CLAUDE-DESKTOP.md made by "node scripts/skill.js sync". Do not edit here: edit the source and run sync. Relative links point into the repository. -->

# Install the server in Claude Desktop, from scratch

This guide takes a machine with nothing on it to the `increadible` MCP server running inside Claude Desktop. Claude Desktop runs on
macOS and Windows. Everything here that I could run is marked **Verified**; everything that needs your machine is marked
**NOT VERIFIED** until you have done it (the authoring environment is a Linux container that cannot reach your computer).

| Path | Best for | Needs Node on your PATH | State |
|---|---|---|---|
| **A. One-click `.mcpb` package** | most people; Claude Desktop ships its own Node.js | no (only to build the file yourself) | Installs and enables in Claude Desktop on Windows (**Verified** by the owner's screenshots, 2026-10-09). Version 1.0.0 then **failed to answer** in the app; **version 1.0.2 answers** (verified by the owner on 2026-10-09, section 5.4): it contains the start-up fixes of 1.0.1 and adds item schemas, bounds, examples and a default value to the tool list |
| **B. Edit `claude_desktop_config.json`** | developers; works today | yes | **Verified** up to the stdio handshake; **NOT VERIFIED** inside Claude Desktop |

Remote servers are a different mechanism (Settings, Connectors). This server speaks stdio locally; its HTTP mode is for containers
(`DEPLOYMENT.md`), not for Claude Desktop.

## 0. What you get

Thirteen tools, from three components we wrote:

| Component | Tools | What it does |
|---|---|---|
| Routing Plugins (#7) | `apply_routing_rules`, `get_rule_stats`, `update_rules`, `suggest_rules` | picks a provider for a task from a rules file; counts what it picked |
| A/B Testing (#8) | `create_experiment`, `assign_variant`, `record_metric`, `get_experiment_results`, `recommend_winner` | 2 to 10 variants, sticky assignment, Welch t-test, Holm correction, guardrails; data kept in an append-only file |
| API Gateway (#9) | `discover_apis`, `call_api`, `aggregate_apis`, `get_api_stats` | 9 registered APIs; **mock data by default**, real GET calls only if you switch an API to live |

It does **not** measure savings, route your Claude traffic, or integrate the vendored projects in `features/01` to `06`
(including OmniRoute): nothing here has measured a cost saving (`ROADMAP.md`).

## 1. Prerequisites

| You need | Why | Check |
|---|---|---|
| Claude Desktop, latest version | it starts the server | Settings, About |
| Git | to get the code | `git --version` |
| Node.js 22 or newer (24 recommended) and npm | to build the code (path B also runs it with Node) | `node -v` |

Install Node from nodejs.org or your package manager (the repository's CI and image use Node 24; `engines` is `>=22`).

## 2. Get and build the code

```bash
git clone https://github.com/nitro0dust-pixel/Increadible.git
cd Increadible
git checkout main
npm ci
npm run build          # compiles to dist/
npm run smoke          # starts the built server over stdio and HTTP and checks it (needs bash: Git Bash or WSL on Windows)
```

The repository is private: Git asks you to sign in. The vendored projects under `features/01` to `06` are git submodules and are not
needed to build or run the server; skip `--recurse-submodules`.

**Verified** (Linux, Node 22.22.0 and 24.21.0, clean rooms of commit `5a38263`; and CI on Node 24): `npm ci`, type-check, lint, tests, build, smoke.
**NOT VERIFIED**: Windows (`npm run build`, `type-check`, `lint` and `test` are expected to work in PowerShell; the `.sh` scripts
need Git Bash or WSL, `ROADMAP.md` item 7).

## 3. Choose where your data lives

Claude Desktop starts the server with no meaningful working directory, so **every path must be absolute** and `~` or `%APPDATA%`
are not expanded in the config file. Pick one folder and create it:

| OS | Suggested folder |
|---|---|
| macOS | `/Users/<you>/Library/Application Support/Increadible` |
| Windows | `C:\Users\<you>\AppData\Roaming\Increadible` (in JSON write `C:/Users/<you>/AppData/Roaming/Increadible`) |

The server uses three files in it. It creates the data file when it starts and the rules file the first time `update_rules` is called; for your own rules from the start, write `rules.yaml` yourself (the "Routing rules" example in `README.md` is a valid starting point, checked by a test):

| Variable | File | If unset |
|---|---|---|
| `RULES_FILE` | `rules.yaml` | built-in rules; `update_rules` would write to a path relative to a directory you do not control |
| `EXPERIMENTS_FILE` | `experiments.yaml` (optional, read-only definitions) | no predefined experiments |
| `AB_DATA_FILE` | `ab-data.jsonl` | **experiments and measurements live in memory only and are lost when Claude Desktop quits** |

Set `RULES_FILE` and `AB_DATA_FILE` at least. A lock file `ab-data.jsonl.lock` appears next to the data file while the server runs; it
makes the data file single-writer. Do not point two programs (for example Claude Desktop and Claude Code) at the same data file; the second is refused with
`it is in use by pid ...`. Give each its own file.

## 4. Path B: edit the config file

1. In Claude Desktop open **Settings, Developer, Edit Config**. It opens `claude_desktop_config.json` (and creates it if needed). Third-party guides give the location as
   `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows; the Edit Config button is the safe way to find it.
   (**NOT VERIFIED here**: the official MCP quickstart could not be reached from the authoring environment on 2026-10-09.)
2. Find the absolute path of Node: `which node` (macOS) or `where node` (Windows). A desktop app often does not see the PATH of your shell
   (for example nvm), so use the full path when `node` alone does not work.
3. Add the server under `mcpServers` (keep any servers already there; the JSON must stay valid):

```json
{
  "mcpServers": {
    "increadible": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/you/code/Increadible/dist/src/index.js"],
      "env": {
        "RULES_FILE": "/Users/you/Library/Application Support/Increadible/rules.yaml",
        "AB_DATA_FILE": "/Users/you/Library/Application Support/Increadible/ab-data.jsonl",
        "AB_FSYNC": "1"
      }
    }
  }
}
```

On Windows, use forward slashes (`"C:/Users/you/code/Increadible/dist/src/index.js"`) or double the backslashes.

4. **Quit Claude Desktop completely** (the menu, Quit; closing the window is not enough) and start it again.
5. Verify, see section 6.

`AB_FSYNC=1` flushes every A/B write to disk (about 0.2 ms each, measured on a local disk): a write you were told succeeded survives a power loss. Leave it out for speed.
Every setting the server reads is in `README.md` and `DEPLOYMENT.md`.

## 5. Path A: the one-click package

One file, `increadible-<version>.mcpb`, that Claude Desktop installs for you and runs with its own built-in Node.js. The installer asks
where to keep your data, so section 3 is done in a dialog instead of in a config file. The format and the install flow were checked
against Anthropic's documentation on 2026-10-09 ([Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb)).

### 5.1 Get the file

| Way | Steps | State |
|---|---|---|
| Build it yourself | do section 2 (`git clone`, `npm ci`), then `npm run mcpb`. It compiles the committed sources into a clean staging folder, installs the production dependencies exactly as `package-lock.json` pins them (no install scripts), and writes `dist/mcpb/increadible-<version>.mcpb`, printing its SHA-256. The same commit gives the same bytes | **Verified** on Linux (Node 22 and 24); Windows **NOT VERIFIED** (the script runs `npm.cmd`) |
| From CI | open the run of the latest commit on `main` in the repository's Actions tab, and download the artifact `increadible-mcpb` (made by the job *Type-check, lint, build, smoke*) (a zip that holds the `.mcpb`; you need to be signed in to GitHub because the repository is private) | **Verified**: the runs of PR #32 and of `main` uploaded it, and the file built in CI has the same SHA-256 as the one built in the authoring sandbox |
| From the person who built it | any copy of the file; compare `node scripts/mcpb.js inspect <file>` and the SHA-256 | |

Before you install a file you did not build, check it: `node scripts/mcpb.js inspect increadible-<version>.mcpb` lists the problems it
finds (a damaged entry, an unsafe file name, a missing manifest or entry point) and prints `mcpb: OK` when there are none.

### 5.2 Install it

1. Open Claude Desktop. Double-click the `.mcpb` file, or drag it into the window, or open Settings, Extensions,
   Advanced settings, Install Extension and choose it.
2. Claude Desktop shows the extension and asks for the settings that the manifest declares (the dialog itself was not seen; the extension page that results was: name, description, an Uninstall button, an Enabled switch, a Configure button, and a red notice that an extension gets access to everything on the computer and that the developer information is not verified by Anthropic):

   | Setting | What to enter | Default |
   |---|---|---|
   | **Data folder** (required) | an existing folder that you back up, for example `D:\Increadible-data` (Windows) or `~/Documents/Increadible-data` (Mac). The server keeps `rules.yaml`, `experiments.yaml` (optional) and `ab-data.jsonl` there | none: you must choose |
   | **Flush every A/B measurement to disk** | leave on unless you have measured that you need the speed (about 0.2 ms per write on a local disk) | on |
| **Live APIs (real calls)** (1.0.3 and later) | leave empty for sample data; or lower-case ids separated by commas, for example `coingecko,hackernews,wikipedia,wikidata` (the four that need no key; section 5.3) | empty |
| **Contact for providers (User-Agent)** (1.0.3 and later) | used only with Live APIs: something like `increadible (you@example.com)`, so that a provider can reach you | empty (sends `increadible-gateway`) |

3. Confirm, and make sure the extension is switched on. Then do section 6.

The extension is **unsigned** (the vendor's tool reports "Not signed"); Claude Desktop may say so before installing. Signing needs a
certificate that only the owner can decide on. If Claude Desktop refuses the file, use Path B: nothing else in this guide changes.

### 5.3 What the file contains, and what it cannot do

| Contains | Does not contain |
|---|---|
| `manifest.json`, `LICENSE`, `package.json`; the compiled server (`dist/`); the one production dependency (`yaml`) | source code, tests, development tools, source maps, `.env` files, the lockfile, any key or token |

| Behaviour | State |
|---|---|
| Starts with `node`, with `RULES_FILE`, `EXPERIMENTS_FILE` and `AB_DATA_FILE` inside your data folder and `AB_FSYNC` from the setting | **Verified**: a test unpacks the bundle into a folder whose path contains a space, substitutes the manifest's variables, starts the server from there and checks the handshake, the 13 tools, and that the files land in the chosen folder |
| Keeps its data across a restart | **Verified** by the same test with a second, fresh process |
| The gateway answers mock data; no network | by default: the setting **Live APIs (real calls)** is empty in a fresh install (version 1.0.3 and later). Fill it with ids separated by commas, lower case, for example `coingecko,hackernews,wikipedia,wikidata` (the four that need no key), and set **Contact for providers** to something like `increadible (you@example.com)`; then quit Claude Desktop completely and start it again. **Verified** in tests only: a test installs the package as Claude Desktop does (its defaults first, then your settings) and checks that an empty setting gives `live_apis: []` and sample answers, and that `hackernews, wikipedia` switches exactly those two. A real call from Claude Desktop is **NOT VERIFIED** (the authoring sandbox cannot reach the providers). The package asks for no API key: the four key-based APIs still need Path B (`GATEWAY_KEY_<API>`) |
| Needs Node 22 or newer at run time | the manifest says `>=22.0.0`. Claude Desktop starts it with its **built-in Node.js** (**Verified**: its log says "Using built-in Node.js for MCP server"); that Node's version is not known. If Claude Desktop reports a runtime problem, use Path B with your own Node |
| Starts several copies at once | Claude Desktop starts the server more than once (the chat, and probes for Cowork and Code sessions) and kills copies at will (**Verified** by its log). The server therefore opens the A/B data only on the first A/B tool call (`AB_LAZY_OPEN`, set by the manifest): the handshake and the other tools never depend on the data folder, and a copy that cannot have the data file says so in the one A/B call that needs it |

### 5.4 What was checked, and what was not

| Check | Result |
|---|---|
| The manifest against the vendor's own validator (`@anthropic-ai/mcpb` 2.1.2, `validate`, run in a scratch folder: it is not a dependency of this project) | **Verified**: accepted; three deliberately broken copies were refused |
| The bundle read by the vendor's `info` and `unpack`, by Python's `zipfile` (checksum of every entry) and by `unzip -t` | **Verified**: all accept it |
| Two builds of the same commit | **Verified**: identical SHA-256 |
| The manifest's tool list against what the server lists, and its settings against what the code reads | **Verified** by `tests/mcpb.test.ts` |
| Claude Desktop (Windows) installs the file and lists the extension, with an Enabled switch and a Configure button | **Verified** by the owner's screenshots, 2026-10-09 |
| Claude Desktop substitutes the settings: its Developer page shows `RULES_FILE=D:\Increadible-data\rules.yaml`, `EXPERIMENTS_FILE`, `AB_DATA_FILE` and `AB_FSYNC=true`, and runs `node` on `...\Claude Extensions\local.mcpb.increadible-team.increadible\dist\src\index.js` (a path with a space) | **Verified** (same screenshots): `${user_config...}`, the backslash from `${/}` and the boolean as `true` all came out right |
| Version 1.0.0 answers the app | **FAILED**. The app's log shows `initialize` sent at 02:17:20 UTC and never answered (the app cancelled it 60 s later: "Request timed out", shown to the user as "didn't respond within a minute"); its probe copies gave up after 4 s each, and one closed during a `server/discover` probe. The cause was not proven. Known suspects, all removed in 1.0.1: opening the data file at start-up (a second copy crashes on the lock; a lock left by a killed copy froze start-up for up to 17 s; a retry loop without a deadline), and the entry check `require.main === module` (false if a launcher loads the file) |
| Version 1.0.1 built in CI equals the one built here | **Verified**: SHA-256 `bc24224c6876a7e17377283a10518b1edd30ab4377927e782f4d7387fd13ea81` from the PR run 37878004117 and from a build of the merged tree |
| Version 1.0.1 answers the app | **NOT TESTED in the app**: the owner went straight to 1.0.2, which contains every 1.0.1 fix (next row) |
| Version 1.0.2 answers the app | **Verified by the owner on 2026-10-09** (Windows, Claude Desktop): the extension built on the owner's machine (`npm run mcpb`, SHA-256 `3594d5fd...`, see the Windows-build row) was installed; in a new chat `Use the increadible tool get_api_stats.` returned the statistics of a fresh server (`total_calls` 0, `live_apis` empty). So the server starts, answers the handshake, the app accepts the 1.0.2 tool list with its schema keywords (`items`, `examples`, `default`, `additionalProperties`, nested `required`), and a tool call reaches the server. Further checks the same day are in the next two rows |
| Tools exercised in the app (owner, 2026-10-09) | **Verified**: `get_api_stats`; `discover_apis` (query `weather` returned exactly `openweathermap` and `weatherapi`, with the registry's endpoints and key requirements); `create_experiment` (a duplicate id was refused: `Experiment already exists: test1`, nothing changed); `assign_variant` (returned variant `A`); `get_experiment_results` (an experiment with no samples reported `incomplete`, 0 samples); `record_metric` refused an unknown variant and an unknown metric, the second error listing the experiment's metric ids. **Not exercised in the app:** `apply_routing_rules`, `get_rule_stats`, `update_rules`, `suggest_rules`, `recommend_winner`, `call_api`, `aggregate_apis`, and a successful `record_metric` |
| A/B data survives a restart of Claude Desktop | **PARTLY verified**: after a full restart, `record_metric` still found experiment `test1` (it rejected only the variant), so an experiment's definition persists in the data folder. That a recorded **measurement** survives a restart is **NOT VERIFIED** (the check with a fresh experiment `persist-check` is pending). Found on the way: the unknown-variant error does not list the experiment's variant ids, unlike the unknown-metric error |
| The Windows build (`npm run mcpb` on Windows) | **FAILED** on the owner's machine (2026-10-09, Node in `C:\Program Files\nodejs`): `'C:\Program' is not recognized`, because the build script started every command through `cmd.exe`, which splits an unquoted path at the space. Fixed in PR #38 (a shell only for `npm.cmd`). **Verified** by the owner on the same machine (2026-10-09, branch of PR #38 at `5d091a6`): `mcpb: 243 files, 288720 bytes, sha256 3594d5fd...`, the same SHA-256 as the Linux build and the CI build, so the package is byte-identical on Windows and Linux |
| The 1.0.2 package after PR #39 (license made proprietary) | Its SHA-256 changes (`2cdbf12f...` built here) because the package carries `LICENSE` and the manifest's `license` field; the server code in it is unchanged, so a 1.0.2 file built before PR #39 (`3594d5fd...`) tests the same server. Both say version 1.0.2: compare the SHA-256, not the name, when a byte-for-byte match matters |
| Version 1.0.3: the two live settings (Live APIs, Contact) | **Verified in tests**: `tests/mcpb.test.ts` installs the bundle, applies the manifest's defaults and then the settings (as `@anthropic-ai/mcpb` 2.1.2 does), and checks that empty gives `live_apis: []` and `source: "mock"`, and that `hackernews, wikipedia` switches exactly those two. `mcpb.js problems` refuses an optional setting used without a default (the runtime would pass the literal `${user_config...}` text). **NOT VERIFIED**: the settings dialog in Claude Desktop, and any real call to a provider |

### 5.5 If the app says "didn't respond within a minute" or "Couldn't start for Cowork and Code sessions"

| Message | Meaning |
|---|---|
| "Increadible didn't respond within a minute, so Claude can't use it" (the log: `Request timed out`) | the app sent its first request (`initialize`) and got no answer for 60 s |
| "Couldn't start for Cowork and Code sessions. ... Version negotiation failed: the connection closed during the server/discover probe" | the app starts a second copy to probe it for Cowork and Code sessions; that copy ended before it answered |

Both were seen with version 1.0.0 (section 5.4). Install version 1.0.1 or later (remove the old extension first if the app does not replace it). If it still happens, open Settings, Developer, choose Increadible, **View logs**, and look for the line `increadible <version>: ready on stdio`, where `<version>` is the version you installed (the server writes it to stderr when it starts; whether the app's log shows stderr is not verified): present means our process started and the app is waiting for something else; absent means it never got that far. Send the lines around it.

If the tools are missing, or Increadible shows an error, after you install a new version: remove the extension, install it again (whether the app replaces an installed extension in place is **NOT VERIFIED**, so remove the old one first), and send the log lines around `increadible <version>: ready on stdio`. Version 1.0.2 itself is verified in the app (section 5.4).

## 6. Verify it works

| Check | Expected | Where it was verified |
|---|---|---|
| The server answers the MCP handshake over stdio with the exact command from your config | `initialize` returns `serverInfo.name` `increadible`; `tools/list` returns 13 tools | **Verified** by `npm run smoke` and `tests/entry-point.test.ts` (real processes, Linux) |
| Claude Desktop shows it as running | Settings, Developer lists `increadible` as running; no error | **NOT VERIFIED** (your machine) |
| The tools are available in a chat | the `+` button under the chat box, Connectors, lists the 13 tools | **NOT VERIFIED** (your machine) |
| A real call works | ask: "Use the increadible tool get_api_stats." The answer is JSON with `total_calls: 0` | **NOT VERIFIED** (your machine) |
| Your data persists | create an experiment, quit Claude Desktop, start it, ask for its results; it is still there, and `ab-data.jsonl` has lines | **NOT VERIFIED** (your machine); the replay itself is **Verified** by tests |

To try the four gateway tools from a chat, step by step, and to read what each answer means (the extension as shipped answers sample data, never a real price or headline), see [USING-THE-GATEWAY.md](USING-THE-GATEWAY.md).

You can run the handshake yourself, without Claude Desktop, with the same environment:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | RULES_FILE=/tmp/rules.yaml node dist/src/index.js
```

Two JSON lines come back; stdout carries only JSON, logs go to stderr.

## 7. Operate it

| Task | How |
|---|---|
| See the logs | macOS `~/Library/Logs/Claude/` (files named `mcp*.log`); Windows `%APPDATA%\Claude\logs`; also Settings, Developer. (Locations from the MCP quickstart, **NOT VERIFIED here**) |
| Back up the A/B data | quit Claude Desktop, copy `ab-data.jsonl` (the log is append-only; the lock file is not needed) |
| Start fresh | quit Claude Desktop, move `ab-data.jsonl` and `ab-data.jsonl.lock` away |
| Update the server | Path B: `git pull`, `npm ci`, `npm run build`, quit and restart Claude Desktop. Path A: build or download the newer `.mcpb` and install it the same way (whether Claude Desktop replaces the old copy in place is **NOT VERIFIED**; remove the old one first if it asks). Stored data still loads either way (the golden-master tests keep that true) |
| Roll back | Path B: `git checkout <earlier commit>`, rebuild, restart. Path A: install the earlier `.mcpb` |
| Remove it | delete the `increadible` entry from the config (or uninstall the extension), restart; your data folder stays until you delete it |
| Turn on real API calls | not by default. In the package (1.0.3 and later): the setting **Live APIs (real calls)**, section 5.3. On this path: set `GATEWAY_LIVE_APIS` (for example `coingecko,hackernews`) and, for the four key-based APIs, `GATEWAY_KEY_<API>`. Keys placed in this config file sit there in plain text. The `.mcpb` format can keep a setting in the operating system's keychain (a setting marked sensitive), but this package does not offer key settings yet. Live mode has **never been run against a real provider** (`NOT VERIFIED`); read `DEPLOYMENT.md` first |

## 8. What the server can touch on your machine

| Resource | Access |
|---|---|
| Files | only the paths in `RULES_FILE`, `EXPERIMENTS_FILE`, `AB_DATA_FILE` (and the `.lock` and temporary files next to them) |
| Network | none in the default configuration; with `GATEWAY_LIVE_APIS` set, GET requests to each API's registered host only (no redirects followed, JSON only, size and time capped) |
| Processes | one `node` process, started and stopped by Claude Desktop; no other program is started |
| Secrets | none stored by the server; a key you place in `env` is only read from the environment and never written to a result, error, log line or cache key (tested against a real local server) |

If something does not work, see `TROUBLESHOOTING.md`.
