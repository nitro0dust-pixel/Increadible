#!/usr/bin/env bash
# Runs every check this repository actually supports and prints an honest summary.
#
# A PASS line means the check ran to completion on the tree named in the first line, not only that a command exited 0:
# the test step also fails when fewer suites ran than there are tests/*.test.ts files (a run from a stale or partial checkout once
# reported 189 of 195 tests, and a check that only looked at the exit code would not have noticed which tree it had tested).
# What cannot run here is reported NOT AVAILABLE, never PASS. To test exactly what is committed, use scripts/cleanroom.sh.
cd "$(dirname "$0")/.." || exit 1
declare -a RESULTS
FAILED=0

# VERIFY_COMMIT is set by scripts/cleanroom.sh, whose tree is a git archive (no .git directory to ask).
if [ -n "${VERIFY_COMMIT:-}" ]; then
  commit=$VERIFY_COMMIT; tree="exported from that commit by scripts/cleanroom.sh"
elif git rev-parse --git-dir >/dev/null 2>&1; then
  commit=$(git rev-parse HEAD)
  if [ -z "$(git status --porcelain)" ]; then tree="clean"; else tree="DIRTY (uncommitted changes are part of what is tested)"; fi
else
  commit=unknown; tree="not a git checkout"
fi
echo "verify: commit $commit, tree: $tree, node $(node -v)"

# After the tree is judged, so the step log can never make a clean tree look dirty when TMPDIR is inside it.
LOG=$(mktemp "${TMPDIR:-/tmp}/verify-step.XXXXXX") || exit 1
trap 'rm -f "$LOG"' EXIT

pass() { RESULTS+=("PASS            $1"); }
fail() { RESULTS+=("FAIL            $1"); FAILED=1; tail -15 "$LOG"; }

run() {
  local name=$1; shift
  if "$@" >"$LOG" 2>&1; then pass "$name"; else fail "$name"; fi
}

run_tests() {
  local name="unit/integration tests" suites expected
  if ! npm test --silent >"$LOG" 2>&1; then fail "$name"; return; fi
  suites=$(sed -n 's/^Test Suites:.*[^0-9]\([0-9][0-9]*\) total.*/\1/p' "$LOG" | tail -1)
  expected=$(find tests -maxdepth 1 -name '*.test.ts' | wc -l | tr -d ' ')
  if [ "$suites" != "$expected" ]; then
    echo "jest ran ${suites:-no} suite(s), tests/ holds $expected *.test.ts file(s): a partial run is not a pass" >>"$LOG"
    fail "$name"
  else
    pass "$name ($(sed -n 's/^Tests: *//p' "$LOG" | tail -1) in $suites suites)"
  fi
}

run "type-check"  npm run -s type-check
run "lint"        npm run -s lint
run_tests
run "build"       npm run -s build
run "smoke (stdio + HTTP)" bash scripts/smoke.sh
if docker info >/dev/null 2>&1; then
  run "docker image build" docker build -q -t increadible:verify .
else
  RESULTS+=("NOT AVAILABLE  docker image build (no Docker daemon)")
fi
promtool=${PROMTOOL:-$(command -v promtool || true)}
if [ -n "$promtool" ]; then
  run "alert rules (promtool check and test)" env PROMTOOL="$promtool" bash scripts/check-prometheus.sh
else
  RESULTS+=("NOT AVAILABLE  alert rules (set PROMTOOL=<binary>; scripts/install-promtool.sh builds the pinned one)")
fi
RESULTS+=("NOT AVAILABLE  k8s apply / cluster checks (no cluster; manifests are only unit-tested)")
echo
printf '%s\n' "${RESULTS[@]}"
exit "$FAILED"
