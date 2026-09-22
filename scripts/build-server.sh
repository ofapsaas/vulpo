#!/usr/bin/env bash
# build-server.sh — Compila vlpsrv (server Go estatico, CGO_ENABLED=0) (fb-007-001)
#
# Copyright 2026 Vulpo contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Compila el server Go v0.5.0 (src/server/, cmd/vlpsrv/main.go) a un
# binario estatico en src/server/bin/vlpsrv. Scaffold minimo en
# fb-007-001 (sin logica de negocio: WS/MCP/agentes llegan en fb-007-002..006).
#
# Uso:
#   build-server.sh            -> go build estatico -> src/server/bin/vlpsrv
#   build-server.sh --check    -> imprime tamano/tipo/version del binario compilado
#   build-server.sh -h|--help  -> ayuda
#
# Exit codes: 0 OK · 1 uso · 2 fallo de build · 3 check fallido

set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$SRC_ROOT/server"
OUT_BIN="${VLP_SERVER_BIN:-$SRC_DIR/bin/vlpsrv}"

usage() {
    sed -n '2,/^# Exit codes:/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

MODE="build"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --check)   MODE="check"; shift ;;
        --help|-h) usage ;;
        *) echo "opcion desconocida: $1 (usa --help)" >&2; exit 1 ;;
    esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "falta '$1' en el host" >&2; exit 1; }; }
need go

if [[ "$MODE" == "check" ]]; then
    if [[ -x "$OUT_BIN" ]]; then
        size=$(stat -c %s "$OUT_BIN")
        version=$("$OUT_BIN" --version 2>/dev/null | head -1) || version="n/a"
        echo "vlpsrv:  $OUT_BIN"
        echo "size:    $size bytes ($(du -h "$OUT_BIN" | cut -f1))"
        echo "type:    $(file -b "$OUT_BIN")"
        echo "version: $version"
        exit 0
    fi
    echo "vlpsrv no compilado: $OUT_BIN (corre build-server.sh)" >&2
    exit 3
fi

if [[ ! -f "$SRC_DIR/cmd/vlpsrv/main.go" ]]; then
    echo "falta $SRC_DIR/cmd/vlpsrv/main.go: el CLI de vlpsrv (--version --check) no existe; nada que compilar" >&2
    exit 2
fi

# fb-020-006 §2.6: revisión del agent kit, misma fórmula que build-agent-kit.sh.
# Sin git (o sin historia) se compila con revisión vacía: initialize omite la clave.
KIT_REVISION=""
if command -v git >/dev/null 2>&1; then
    KIT_REVISION="$(git -C "$SRC_ROOT" log -1 --format=%h --abbrev=12 -- agent-kit 2>/dev/null)" || KIT_REVISION=""
fi
LDFLAGS=""
if [[ -n "$KIT_REVISION" ]]; then
    LDFLAGS="-X main.agentKitRevision=$KIT_REVISION"
else
    echo "aviso: no se pudo calcular la revisión del agent kit (git log -- agent-kit); se compila sin revisión" >&2
fi

mkdir -p "$(dirname "$OUT_BIN")"
( cd "$SRC_DIR" && CGO_ENABLED=0 go build -ldflags "$LDFLAGS" -o "$OUT_BIN" ./cmd/vlpsrv )
echo "agent kit revision: ${KIT_REVISION:-(none)}"
echo "vlpsrv compilado: $OUT_BIN ($(du -h "$OUT_BIN" | cut -f1))"
