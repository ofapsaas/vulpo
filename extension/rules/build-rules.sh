#!/usr/bin/env bash
# build-rules.sh — empaqueta el motor de reglas host+path (fb-026-001) como
# archivo autocontenido para el event page (restricción MV3, spec §2.1):
# genera ../rules-bundle.js (IIFE) con el global VulpoRules
# (parseRules / matchDomain / resolveProfile) desde rules.js. Lo invoca build-xpi.sh.
# Fail-loud: `set -euo pipefail` aborta acá si esbuild no está disponible y no
# shipea un bundle stale. Misma invocación que frame/build-frame.sh y
# odoo/build-probe.sh (`npx esbuild` resuelve local o descarga on-demand; NO
# `--no-install`, que dependía de la caché de npx y rompía un checkout limpio).
set -euo pipefail
cd "$(dirname "$0")"
npx esbuild rules.js --bundle --format=iife --global-name=VulpoRules --outfile=../rules-bundle.js
echo "rules-bundle.js generado"
