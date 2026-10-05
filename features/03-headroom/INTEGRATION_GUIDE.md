# Feature #3b: Headroom (mini token optimizer)

Vendored third-party project (git submodule `headroom/`, upstream https://github.com/lea-blum/headroom-mini-token-optimizer).
It is **not** wired into this repo's server or tests, and it overlaps with Token Optimizer MCP (#3);
use one or both deliberately.

Per upstream's README (written in Hebrew) it exposes these tools: `compress_code`, `compress_json`,
`optimize_prompt`, `redact_content` (reversible placeholders) and `hydrate` (restore redacted content).
Compression percentages seen in older notes for this stack are not produced by this project and are unverified.
