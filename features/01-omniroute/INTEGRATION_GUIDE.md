# Feature #1: OmniRoute

Vendored third-party project (git submodule `OmniRoute/`, upstream https://github.com/diegosouzapw/OmniRoute).
It is **not** wired into this repo's server or tests; run it as its own service.

Per upstream's README:

- Install: `npm install -g omniroute`; the server listens on `localhost:20128`.
- Point OpenAI-compatible tools at `http://localhost:20128/v1`.

Everything else (providers, combos, configuration) is documented in `OmniRoute/README.md`.
Use the Routing Plugins tool (#7) to decide *which* provider you want, then express that choice in OmniRoute's own configuration.
