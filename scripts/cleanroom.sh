#!/usr/bin/env bash
# Verifies exactly what git has committed, and nothing else.
#
# Exports a commit (default HEAD; any commit-ish as the first argument) into an empty temporary directory, installs from the
# lockfile and runs scripts/verify.sh there. Untracked files, ignored files, node_modules and leftover build output in your working
# copy cannot influence the result, and the first line says which commit was tested. Needs git, tar, node and npm (and network for
# `npm ci`). The directory is removed afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
commit=$(git rev-parse --verify "${1:-HEAD}^{commit}")
dir=$(mktemp -d "${TMPDIR:-/tmp}/increadible-cleanroom.XXXXXX")
trap 'rm -rf "$dir"' EXIT
git archive "$commit" | tar -x -C "$dir"
cd "$dir"
echo "cleanroom: $commit exported to $dir ($(find . -type f | wc -l | tr -d ' ') files), node $(node -v)"
npm ci --no-audit --no-fund
VERIFY_COMMIT=$commit bash scripts/verify.sh
