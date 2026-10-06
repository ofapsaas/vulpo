#!/usr/bin/env bash
# build-rules.sh — empaqueta el motor de reglas host+path (fb-026-001) como
# archivo autocontenido para el event page (restricción MV3, spec §2.1):
# genera ../rules-bundle.js (IIFE) con el global VulpoRules
# (parseRules / matchDomain / resolveProfile) desde rules.js. Lo invoca build-xpi.sh.
# Fail-loud: si esbuild no está disponible, falla acá y no shipea un bundle stale.
set -euo pipefail
cd "$(dirname "$0")"
if ! npx --no-install esbuild --version >/dev/null 2>&1; then
  echo "❌ esbuild not found (run npm install in src/extension/rules) — cannot build rules-bundle.js" >&2
  exit 1
fi
npx --no-install esbuild rules.js --bundle --format=iife --global-name=VulpoRules --outfile=../rules-bundle.js
echo "rules-bundle.js generado"
