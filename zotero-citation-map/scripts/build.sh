#!/usr/bin/env bash
#
# build.sh — package the plugin into an installable .xpi
#
# Usage:  ./scripts/build.sh
# Output: build/citation-map-<version>.xpi
#
# An .xpi is just a ZIP with all plugin files at its ROOT (manifest.json
# must not be inside a subdirectory), so we zip the *contents* of addon/.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('addon/manifest.json'))['version'])")
OUT="build/citation-map-${VERSION}.xpi"

mkdir -p build
rm -f "$OUT"

(cd addon && zip -r -q "../$OUT" . -x "*.DS_Store")

echo "Built $OUT"
echo "SHA-256 (for update.json): $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
