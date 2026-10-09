# Troubleshooting

Messages in the "Message" column are the server's own words (they are in the code and in the tests). Claude Desktop behaviours are
marked **NOT VERIFIED** where they come from third-party guides or memory rather than from a run on your machine. When in doubt, run the
server by hand with the same environment (section 1): if it works there, the problem is in the Claude Desktop configuration.

## 1. First, run it by hand

```bash
RULES_FILE=/tmp/rules.yaml AB_DATA_FILE=/tmp/ab.jsonl node dist/src/index.js
# type, then press Enter:
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

You should see one JSON line listing 13 tools. Logs appear on stderr. Press Ctrl-C to stop; the lock file is released.

## 2. Claude Desktop does not show the server

| Symptom | Likely cause | Fix |
|---|---|---|
| The server is not listed at all | the config file is not valid JSON (a trailing comma, a missing quote), or Claude Desktop was only closed, not quit | validate the JSON; quit from the menu and start again |
| Listed but failed, log says `spawn node ENOENT` (**NOT VERIFIED wording**) | a desktop app does not see your shell's PATH (nvm, Homebrew paths) | put the full path of `node` in `command` (`which node`, `where node`) |
| Failed immediately, log shows a syntax error or `Cannot find module` | wrong path to `dist/src/index.js`, a relative path, or `npm run build` was not run | use an absolute path; run `npm ci` and `npm run build` |
| Works in a terminal, not in Claude Desktop | the working directory differs; relative file paths resolve somewhere else | set `RULES_FILE` and `AB_DATA_FILE` to absolute paths |
| On Windows the path looks right but fails | single backslashes in JSON (`\U` is an escape) | use forward slashes or double the backslashes |
| Node prints syntax errors from `dist/` | Node older than 22 | install Node 22 or 24 |

### If you use the `.mcpb` package (Path A)

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run mcpb` says `typescript is not installed` | `npm ci` has not been run in this checkout | run `npm ci`, then again |
| `npm run mcpb` fails inside `npm ci --omit=dev` | no network and a cold npm cache (the build prefers the cache) | connect once and run `npm ci`; the next build works offline |
| `mcpb: mcpb/manifest.json has problems:` | the manifest and `package.json` or the server drifted (a version, a tool, a setting); the message names which | fix the manifest (`tests/mcpb.test.ts` shows the same message) |
| `node scripts/mcpb.js inspect` reports `checksum mismatch`, `unsafe name`, a missing manifest or entry point | the file was damaged in transfer, or was not made by `scripts/mcpb.js` | download or build it again and compare the SHA-256 |
| Claude Desktop refuses the file, or says the runtime is too old (**NOT VERIFIED wording**) | its built-in Node is older than the manifest's `>=22.0.0`, or it does not accept an unsigned extension | use Path B with your own Node 22 or newer |
| The tools are listed but my experiments are gone after I changed the data folder | the data stays in the old folder; a new folder is an empty store | switch the setting back, or, with Claude Desktop quit, move `ab-data.jsonl` and `rules.yaml` into the new folder |
| I want live API calls or API keys | the package does not offer those settings yet | use Path B (`GATEWAY_LIVE_APIS`, `GATEWAY_KEY_<API>`); live mode has never run against a real provider |

## 3. Start-up messages from the server

| Message (stderr) | Meaning | What to do |
|---|---|---|
| `Rules file not found: <path>` | no rules file there; the built-in rules are used | harmless; create one with `update_rules` or by hand |
| `Rules file <path> is not usable (<reason>); using the built-in rules` | the file parsed but a rule is malformed | fix the named reason (the same checks apply to `update_rules`) |
| `Loaded N routing rules` / `Loaded N experiments` / `Restored N experiments and M measurements from <file>` | normal start-up | none |
| `Restored ... (skipped S unreadable lines, dropped D orphaned measurements)` | a torn last line or a measurement for something that no longer exists | normal after a crash; the file is not rewritten |
| `Cannot use A/B data file <file>: it is already open in this process (close the other instance first)` | two servers in one process | not expected with Claude Desktop |
| `Cannot use A/B data file <file>: it is in use by pid N on <host>. Only one server process may write it: stop the other one or point AB_DATA_FILE at a different path` | another program is using the same data file (another Claude client, a leftover process) | stop it, or give each client its own file |
| `... its lock (<file>.lock) is held by ... and was refreshed in the last 15s, but that process could not be checked from here. If it is really gone, delete the lock file` | a lock from another machine or an unreadable lock, still fresh | wait 15 s; if you are sure nothing runs, delete the `.lock` file |
| `Cannot use A/B data file <file>: EACCES ...` or `EISDIR ...` | no permission, or the path is a folder | fix the permission or the path |
| `A/B data file <file> is N MB. It is never compacted: plan a rollup or rotation ...` | the file passed `AB_DATA_WARN_BYTES` (default 100 MB) | plan to archive it (`DEPLOYMENT.md`); nothing is lost |
| `A/B data file lock was lost to another process: refusing to write` | the lock was taken over (this process stalled for over 15 s, or the lock file was removed) | restart the server |
| `GATEWAY_LIVE_APIS names an unknown API: <id>` | a typo in the list | use ids from `discover_apis` |
| `GATEWAY_TIMEOUT_MS must be an integer from 100 to 120000; using 10000` (and the other bounds) | a setting out of range | correct it |

## 4. Tool errors (inside a chat)

| Error | Meaning |
|---|---|
| `Experiment not found: <id>` | wrong id, or the data file is not the one you used before (check `AB_DATA_FILE`) |
| `Variant <v> is not part of experiment <id>` / `Unknown metric <m> for experiment <id>: its metrics are ...` | a misspelt id; the message lists the valid metrics |
| `Metric <m> must be a finite number` / `... must be between -1e15 and 1e15` | one huge value would spoil an experiment for good, so it is refused |
| `Experiment already exists: <id>` | ids are unique |
| `rules must be an array` / `duplicate rule id: <id>` / `each rule needs string id, string provider, number priority, boolean enabled and object match` | `update_rules` validation; nothing was changed |
| `<api>: this API needs a credential: set GATEWAY_KEY_<API>` | live mode for a key-based API without its key |
| `<api>: network error (<code>)`, `timed out after N ms`, `the response is not JSON (content-type: ...)`, `HTTP 429 (retry after N)` | live mode failures; messages never contain the credential |
| `all N calls failed` | every call in an `aggregate_apis` request failed; the per-call errors are in `data` |

## 5. Data questions

| Question | Answer |
|---|---|
| Everything is gone after I restart Claude Desktop | `AB_DATA_FILE` is not set in the config: A/B data lives in memory only |
| `get_experiment_results` says it needs more samples | at least 100 measurements in total and 30 per variant before a result is given |
| No winner although one variant looks better | a winner must be significantly better (p < 0.05, Holm-corrected) than every other variant, and no guardrail may be significantly worse or have no data |
| Prices or weather look fake | the gateway answers **mock data** unless you set `GATEWAY_LIVE_APIS`; every result says `source: "mock"` or `"live"` |
| Where is my rules file? | the path in `RULES_FILE`; if unset, built-in rules only |

## 6. Still stuck

Collect: the server's stderr (Claude Desktop's MCP log), the exact config block with secrets removed, `node -v`, and the output of the
section 1 test. Then open an issue in the repository (it is private: only the owner and collaborators see it).
