#!/usr/bin/env bash
# Builds promtool from a pinned Prometheus release and puts it in <dest-dir>. Needs Go and jq.
# Usage: scripts/install-promtool.sh <dest-dir>
#
# Why a source build: no prebuilt promtool is reachable from every environment this repository is checked in
# (release pages and Docker Hub are not), and a container image would have to be pinned by a digest that has to be
# looked up. The Go module proxy is reachable, and the module is verified twice: `go mod download` checks it against the
# Go checksum database, and the h1: hash below pins the exact content, so a different tree under the same version fails.
# `go install pkg@version` cannot be used: Prometheus's go.mod has replace directives. The go.work file refers to
# nested modules that are not in the module zip, hence GOWORK=off. Go fetches the toolchain this version requires.
#
# To move to a newer release: pick the version, run `go mod download -json github.com/prometheus/prometheus@<version>`,
# read .Sum, update both values here, and run scripts/check-prometheus.sh.
set -euo pipefail
VERSION=v0.315.0                                          # Prometheus release 3.15.0 (module versions are 0.<major><minor>)
SUM='h1:sFGZWmC2Hk9N1NBJGCnXYZb5hyLCq8yuAMoEjLAg6ac='     # source commit 5241a27fe3c6983549fccc32f6e65917408c63cd
DEST=${1:?usage: install-promtool.sh <dest-dir>}
export GOFLAGS=-buildvcs=false GOWORK=off

info=$(go mod download -json "github.com/prometheus/prometheus@$VERSION")
got=$(jq -r .Sum <<<"$info")
[ "$got" = "$SUM" ] || { echo "checksum mismatch for prometheus $VERSION: expected $SUM, got $got" >&2; exit 1; }
dir=$(jq -r .Dir <<<"$info")

mkdir -p "$DEST"
# remove_all_sd leaves out the cloud service-discovery code, which `check rules` and `test rules` do not use: the build takes
# about 70 s from a cold cache on four cores instead of about 160 s, and the binary is a third smaller.
( cd "$dir" && go build -trimpath -tags remove_all_sd -o "$DEST/promtool" ./cmd/promtool )
echo "promtool built from github.com/prometheus/prometheus@$VERSION ($SUM) in $DEST"
