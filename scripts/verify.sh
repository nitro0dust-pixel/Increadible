#!/usr/bin/env bash
# Runs every check this repository actually supports and prints an honest summary.
cd "$(dirname "$0")/.."
declare -a RESULTS
run() {
  local name=$1; shift
  if "$@" >/tmp/verify-step.log 2>&1; then RESULTS+=("PASS            $name"); else RESULTS+=("FAIL            $name"); tail -15 /tmp/verify-step.log; fi
}
run "type-check"  npm run -s type-check
run "lint"        npm run -s lint
run "unit/integration tests" npm test --silent
run "build"       npm run -s build
run "smoke (stdio + HTTP)" bash scripts/smoke.sh
if docker info >/dev/null 2>&1; then
  run "docker image build" docker build -q -t increadible:verify .
else
  RESULTS+=("NOT AVAILABLE  docker image build (no Docker daemon)")
fi
RESULTS+=("NOT AVAILABLE  k8s apply / cluster checks (no cluster; manifests are only unit-tested)")
printf '\n%s\n' "${RESULTS[@]}"
printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL' && exit 1 || exit 0
