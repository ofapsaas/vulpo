#!/usr/bin/env bash
# build-frame.sh — empaqueta el frame (serializer + resolver + act) como
# archivo autocontenido (D7, D1). Genera ../frame-serializer.js (IIFE,
# isolated-world safe) con el global VulpoFrame (serializeFrame /
# resolveRef / performAction) desde el entry index.js + dom-accessibility-api
# (bundle esbuild). Lo invoca build-xpi.sh.
set -euo pipefail
cd "$(dirname "$0")"
npx esbuild index.js --bundle --format=iife --global-name=VulpoFrame --outfile=../frame-serializer.js
echo "frame-serializer.js generado"
