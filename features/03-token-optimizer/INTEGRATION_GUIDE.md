# Feature #3: Token Optimizer MCP

Vendored third-party project (git submodule `token-optimizer-mcp/`, upstream https://github.com/ooples/token-optimizer-mcp).
npm package: `@ooples/token-optimizer-mcp`. It is **not** wired into this repo's server or tests.

Per upstream's README: the `optimize_text` tool stores bulky text outside the model context and returns
measurements with each call, and `TOKEN_OPTIMIZER_COMPRESSION` selects `balanced` (default), `aggressive`,
`conservative` or `lossless`. Upstream states its own example payload is "not a benchmark"; any
reduction percentage you see quoted elsewhere is workload-dependent and has **not** been measured in this repo.

See `token-optimizer-mcp/README.md` for installation and the full tool list.
