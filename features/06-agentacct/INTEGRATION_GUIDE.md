# Feature #6: agentacct

Vendored third-party project (git submodule `agentacct/`, upstream https://github.com/mikehasa/agentacct).
It is **not** wired into this repo's server or tests.

Per upstream's README: install with `pipx install agentacct`; it runs a local JSON API at `http://127.0.0.1:8765`.
Use it to measure your real usage and cost. That measurement is the only valid source for any "cost savings"
figure about this stack; none has been measured here. See `agentacct/README.md` for commands and integrations.
