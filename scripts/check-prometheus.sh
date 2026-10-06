#!/usr/bin/env bash
# Validates the PrometheusRule in k8s/monitoring.yaml with promtool: a syntax check, then the unit tests in
# monitoring/alerts.test.yaml (every alert has a case that must fire and one that must stay quiet).
# Needs promtool (PROMTOOL=/path/to/promtool, or on PATH; scripts/install-promtool.sh builds the pinned one),
# Node and `npm ci` (the rules are extracted from the Kubernetes object with the `yaml` package).
set -euo pipefail
cd "$(dirname "$0")/.."
PROMTOOL=${PROMTOOL:-promtool}
command -v "$PROMTOOL" >/dev/null 2>&1 || { echo "promtool not found: set PROMTOOL or run scripts/install-promtool.sh <dir>" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

node -e '
  const yaml = require("yaml");
  const docs = yaml.parseAllDocuments(require("fs").readFileSync("k8s/monitoring.yaml", "utf8")).map((d) => d.toJS());
  const rule = docs.find((d) => d && d.kind === "PrometheusRule");
  if (!rule) { console.error("no PrometheusRule in k8s/monitoring.yaml"); process.exit(1); }
  process.stdout.write(yaml.stringify({ groups: rule.spec.groups }));
' >"$TMP/rules.yaml"
cp monitoring/alerts.test.yaml "$TMP/alerts.test.yaml"

echo "[promtool] $PROMTOOL"
echo "[check rules]"
"$PROMTOOL" check rules "$TMP/rules.yaml"
echo "[test rules]"
"$PROMTOOL" test rules "$TMP/alerts.test.yaml"
echo "prometheus: OK"
