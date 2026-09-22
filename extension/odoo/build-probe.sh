#!/usr/bin/env bash
# build-probe.sh — empaqueta session-probe.js (fb-019-001) como archivo
# autocontenido para el event page (restricción MV3, spec §9): genera
# ../session-probe-bundle.js (IIFE) con el global VulpoSessionProbe
# (probeRequest / rpcRequest / classifyProbeResponse / aggregateDetection /
# versionResult / unwrapRpcResult). Lo invoca build-xpi.sh.
set -euo pipefail
cd "$(dirname "$0")"
npx esbuild session-probe.js --bundle --format=iife --global-name=VulpoSessionProbe --outfile=../session-probe-bundle.js
echo "session-probe-bundle.js generado"
# fb-020-007 (I-6): núcleo genérico de navegación (../nav-guard.js), IIFE con el
# global VulpoNav; y su capa ORM (nav-guard.js), IIFE con el global
# VulpoNavGuard. Ambos se cargan antes que background.js.
npx esbuild ../nav-guard.js --bundle --format=iife --global-name=VulpoNav --outfile=../nav-guard-bundle.js
echo "nav-guard-bundle.js generado"
npx esbuild nav-guard.js --bundle --format=iife --global-name=VulpoNavGuard --outfile=../odoo-nav-guard-bundle.js
echo "odoo-nav-guard-bundle.js generado"
# fb-020-008 (frame fold): mapeo inyectado del pliegue de lectura en las acciones
# del navegador (../frame-fold.js), IIFE con global VulpoFrameFold.
npx esbuild ../frame-fold.js --bundle --format=iife --global-name=VulpoFrameFold --outfile=../frame-fold-bundle.js
echo "frame-fold-bundle.js generado"
