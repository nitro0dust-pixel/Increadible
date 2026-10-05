# Feature #4: gstack

Vendored third-party project (git submodule `gstack/`, upstream https://github.com/garrytan/gstack).
It is **not** wired into this repo's server or tests.

Per upstream's README, gstack installs as Claude Code skills: clone it to `~/.claude/skills/gstack` and run its
`./setup` (requires Claude Code, Git and Bun >= 1.0). Skills, flags and team setup are documented in `gstack/README.md`.
