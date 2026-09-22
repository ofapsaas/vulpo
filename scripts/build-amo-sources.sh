#!/usr/bin/env bash
# build-amo-sources.sh — arma el paquete de fuentes para la submission de AMO
# (source code submission, extensionworkshop.com/documentation/publish/source-code-submission).
# El paquete = árbol trackeado del repo (git archive) + archivos fuente sin
# trackear que el reviewer necesita. Excluye dist/, logs/, findings/, node_modules.
#
# Uso: build-amo-sources.sh            → dist/vulpo-<version>-source.zip
#      build-amo-sources.sh --check    → verifica contenido mínimo del zip
#
# Exit codes: 0 OK · 1 uso/fallo · 3 check fallido

set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(cd "$SRC_ROOT" && python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")"
OUT="dist/vulpo-${VERSION}-source.zip"

cd "$SRC_ROOT"
if ! git diff --quiet HEAD || [ -n "$(git status --porcelain)" ]; then
    echo "build-amo-sources.sh: el working tree tiene cambios sin commitear; commiteá primero (el paquete = árbol trackeado en HEAD)." >&2
    exit 1
fi

mkdir -p dist
rm -f "dist/vulpo-${VERSION}-source.zip"
git archive --format=zip -o "dist/vulpo-${VERSION}-source.zip" HEAD  # manifest.json en la raíz del zip (lo exige el validador de AMO)
echo "source package: dist/vulpo-${VERSION}-source.zip ($(stat -c%s "dist/vulpo-${VERSION}-source.zip") bytes)"

if [[ "${1:-}" == "--check" ]]; then
    REQUIRED=(
        "SOURCE-SUBMISSION.md"
        "extension/manifest.json"
        "extension/background.js"
        "extension/frame/package-lock.json"
        "extension/odoo/package-lock.json"
        "extension/frame/build-frame.sh"
        "extension/odoo/build-probe.sh"
        "scripts/build-xpi.sh"
    )
    missing=0
    listing="$(unzip -Z1 "dist/vulpo-${VERSION}-source.zip")"
    for f in "${REQUIRED[@]}"; do
        if ! grep -qF "$f" <<<"$listing"; then
            echo "❌ falta en el paquete: $f" >&2
            missing=1
        fi
    done
    # nada de node_modules / artefactos
    if grep -qE 'node_modules/|/dist/|amo-upload-uuid' <<<"$listing"; then
        echo "❌ el paquete incluye node_modules/artefactos" >&2
        missing=1
    fi
    [[ $missing -eq 0 ]] && echo "✅ source package check OK" || { exit 3; }
fi
