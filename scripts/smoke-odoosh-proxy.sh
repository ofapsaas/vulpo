#!/usr/bin/env bash
# smoke-odoosh-proxy.sh — fb-025-004-kit-empaquetado-docs (tier T-script: T-build + T-install + T-smoke + unidad + regresión T-go).
#
# Verifica P1/P2/P3/P7/P8 de docs/specs/fb-025-004-kit-empaquetado-docs/spec.md §3.7
# y las condiciones C-4..C-9 del test-audit.md aprobado. Runner manual/de etapa
# (no hay CI; §3.8.1). No forma parte de `npm test` ni de `go test`.
#
# Escrito SOLO contra el contrato del spec. Esta sesión (rol test-writer,
# aislamiento de fase, ADR-011) NO leyó la implementación Go del proxy; los
# scripts de harness (`build-agent-kit.sh`, `install.sh`) se leyeron para cablear
# la invocación (límite honesto PD-15, declarado como en el AUDIT).
#
# ── Naturaleza RED esperada (spec §3.3 / audit §4.3) ────────────────────────
#  · FALLAN: P1 (el tarball no trae bin/vlp-odoosh-proxy), P2 (install.sh no lo
#    instala), P3 (no hay binario que arrancar), P7 (la unidad no existe).
#  · PASA: P8 (regresión `go test ./...` = 101/101).
#
# ── Condiciones clave ───────────────────────────────────────────────────────
#  · C-4: `set -euo pipefail` NO debe abortar antes del resumen ⇒ cada paso
#    corre en contexto guardado (subshell con su propio `set -e`) y se acumula
#    PASS/FAIL; exit 0 sólo si todo pasó.
#  · C-5: todo temporal vive bajo `$HOME/tmp` (NUNCA `/tmp`); `trap` mata el
#    proxy y limpia `$WORK`.
#  · C-9: P7 acopla al repo padre; si la unidad no está ⇒ fail-loud con mensaje
#    claro (paso FAIL, no abort).
set -euo pipefail

# ── Rutas derivadas de BASH_SOURCE ──────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"   # src/
REPO_ROOT="$(cd "$SRC_ROOT/.." && pwd)"    # repo padre del workspace

# ── Requisitos ──────────────────────────────────────────────────────────────
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "smoke-odoosh-proxy.sh: '$1' es requerido" >&2; exit 1; }
}
need go
need file
need tar
need curl

[[ -f "$SRC_ROOT/extension/manifest.json" ]] || {
  echo "smoke-odoosh-proxy.sh: no parece el árbol de Vulpo ($SRC_ROOT/extension/manifest.json ausente)" >&2
  exit 1
}

# ── Área de trabajo temporal: SIEMPRE bajo $HOME/tmp (C-5, I-8) ─────────────
mkdir -p "$HOME/tmp"
WORK="$(mktemp -d "$HOME/tmp/smoke-odoosh-proxy.XXXXXX")"

cleanup() {
  if [[ -f "$WORK/proxy.pid" ]]; then
    local p=""
    p="$(cat "$WORK/proxy.pid" 2>/dev/null || true)"
    if [[ -n "$p" ]]; then
      kill "$p" 2>/dev/null || true
      wait "$p" 2>/dev/null || true
    fi
  fi
  rm -rf "${WORK:-}"
}
trap cleanup EXIT INT TERM

# ── Runner de pasos (C-4): no aborta; acumula PASS/FAIL ─────────────────────
PASS=()
FAIL=()

af() { printf '  ASSERT-FAIL: %s\n' "$*" >&2; }

run_step() {
  local name="$1"; shift
  printf '\n──── %s\n' "$name"
  local rc=0
  set +e
  ( set -euo pipefail; "$@" )
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    printf 'PASS  %s\n' "$name"
    PASS+=("$name")
  else
    printf 'FAIL  %s (rc=%s)\n' "$name" "$rc"
    FAIL+=("$name")
  fi
}

# ── P1 (T-build): el tarball incluye bin/vlp-odoosh-proxy ESTÁTICO ───────────
p1_build_tarball() {
  set -euo pipefail
  local log="$WORK/build.log"
  if ! bash "$SRC_ROOT/scripts/build-agent-kit.sh" >"$log" 2>&1; then
    echo "  build-agent-kit.sh falló; últimas líneas:"
    tail -n 15 "$log"
    return 1
  fi

  local tarball=""
  tarball="$(ls -1t "$SRC_ROOT"/dist/vulpo-agent-kit-*.tar.gz 2>/dev/null | head -n 1 || true)"
  [[ -n "$tarball" ]] || { af "no se generó ningún tarball vulpo-agent-kit-*.tar.gz en $SRC_ROOT/dist"; return 1; }

  local name
  name="$(basename "$tarball" .tar.gz)"
  mkdir -p "$WORK/extract"
  tar -xzf "$tarball" -C "$WORK/extract" || { af "no se pudo extraer $tarball"; return 1; }

  local bin="$WORK/extract/$name/bin/vlp-odoosh-proxy"
  [[ -f "$bin" ]] || { af "el tarball NO incluye $name/bin/vlp-odoosh-proxy (P1: el proxy falta del agent-kit)"; return 1; }
  [[ -x "$bin" ]] || { af "$name/bin/vlp-odoosh-proxy no es ejecutable"; return 1; }

  local ftype
  ftype="$(file -b "$bin")"
  [[ "$ftype" == *"statically linked"* ]] || { af "file -b dice '$ftype' (esperado 'statically linked')"; return 1; }
  [[ "$ftype" != *"dynamically linked"* ]] || { af "file -b dice '$ftype' (NO debe ser 'dynamically linked')"; return 1; }

  echo "  tarball: $tarball"
  echo "  binario: $name/bin/vlp-odoosh-proxy → $ftype"
}

# ── P2 (T-install): install.sh deja ~/.local/bin/vlp-odoosh-proxy (0755) ────
p2_install() {
  set -euo pipefail
  local kitdir=""
  kitdir="$(ls -1d "$WORK"/extract/*/ 2>/dev/null | head -n 1 || true)"
  [[ -n "$kitdir" ]] || { af "no hay kit extraído en $WORK/extract (P1 no produjo tarball)"; return 1; }
  [[ -f "$kitdir/install.sh" ]] || { af "no existe $kitdir/install.sh"; return 1; }

  local h="$WORK/home"
  mkdir -p "$h"

  local out=""
  if ! out="$(HOME="$h" bash "$kitdir/install.sh" 2>&1)"; then
    printf '%s\n' "$out"
    af "install.sh falló"
    return 1
  fi
  printf '%s\n' "$out" | sed 's/^/  | /'

  local proxy="$h/.local/bin/vlp-odoosh-proxy"
  [[ -f "$proxy" ]] || { af "install.sh NO instaló $proxy (P2)"; return 1; }
  local mode
  mode="$(stat -c '%a' "$proxy")"
  [[ "$mode" == "755" ]] || { af "modo de $proxy = $mode (esperado 755)"; return 1; }

  [[ -f "$h/.local/bin/vlpmcp" ]] || { af "install.sh NO instaló vlpmcp (regresión P2)"; return 1; }

  # C-7 / D-3: install.sh NO debe imprimir una línea de versión del proxy.
  if printf '%s\n' "$out" | grep -Eq 'vlp-odoosh-proxy[^[:space:]]*[[:space:]]*\('; then
    af "install.sh imprimió una línea de versión del proxy (D-3 lo prohíbe)"
    return 1
  fi
}

# ── P3 (T-smoke): arranca sin navegador/vlpsrv; /healthz → 200 {"status":"ok"} ─
p3_smoke() {
  set -euo pipefail
  local h="$WORK/home"
  local port="${VLP_SMOKE_PORT:-18899}"

  # C-8: fail-loud si el puerto está ocupado.
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    af "puerto $port ocupado (fail-loud; override con VLP_SMOKE_PORT=<puerto libre>)"
    return 1
  fi

  local token_dir="$h/.config/vulpo"
  mkdir -p "$token_dir"
  ( umask 077; printf 'smoke-token-%s\n' "$$" >"$token_dir/token" )
  chmod 600 "$token_dir/token"
  local mode
  mode="$(stat -c '%a' "$token_dir/token")"
  [[ "$mode" == "600" ]] || { af "token mode=$mode (esperado 600)"; return 1; }

  local proxy="$h/.local/bin/vlp-odoosh-proxy"
  [[ -x "$proxy" ]] || { af "falta el binario instalado $proxy (P2)"; return 1; }

  VLP_URL="http://127.0.0.1:9/mcp" \
  VLP_PROXY_BIND="127.0.0.1" \
  VLP_PROXY_PORT="$port" \
  VLP_TOKEN_FILE="$token_dir/token" \
  "$proxy" >"$WORK/proxy.log" 2>&1 &
  local pid=$!
  echo "$pid" >"$WORK/proxy.pid"

  local deadline=$((SECONDS + 5)) code="" body=""
  while (( SECONDS < deadline )); do
    code="$(curl -s -o "$WORK/health.body" -w '%{http_code}' "http://127.0.0.1:$port/healthz" 2>/dev/null || true)"
    [[ "$code" == "200" ]] && break
    sleep 0.2
  done
  body="$(cat "$WORK/health.body" 2>/dev/null || true)"

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$WORK/proxy.pid"

  if [[ "$code" != "200" ]]; then
    echo "  GET /healthz → HTTP '$code' (esperado 200); log del proxy:"
    tail -n 20 "$WORK/proxy.log"
    return 1
  fi
  [[ "$body" == '{"status":"ok"}' ]] || { af "body de /healthz = '$body' (esperado exacto {\"status\":\"ok\"})"; return 1; }
  echo "  /healthz → 200 {\"status\":\"ok\"} (puerto $port, sin navegador ni vlpsrv)"
}

# ── P7 (unidad): portable (%h; Restart=; WantedBy=; sin absolutos/extra) ────
p7_unit() {
  set -euo pipefail
  local unit="$REPO_ROOT/docs/epics/fb-025-odoosh-mcp-proxy/vlp-odoosh-proxy.service"
  [[ -f "$unit" ]] || {
    af "no existe la unidad $unit — coupling cross-repo (§3.8.5): correr el smoke desde el repo padre del workspace"
    return 1
  }
  grep -q '%h' "$unit" || { af "la unidad no contiene %h"; return 1; }
  grep -Eq '^ExecStart=.*%h' "$unit" || { af "ExecStart debe usar %h"; return 1; }
  grep -Eq '^Environment=VLP_TOKEN_FILE=.*%h' "$unit" || { af "VLP_TOKEN_FILE debe usar %h"; return 1; }
  grep -q 'Restart=' "$unit" || { af "la unidad no contiene Restart="; return 1; }
  grep -q 'WantedBy=' "$unit" || { af "la unidad no contiene WantedBy="; return 1; }
  if grep -q '/home/' "$unit"; then af "la unidad contiene un path absoluto /home/ (I-10)"; return 1; fi
  if grep -q 'WatchdogSec' "$unit"; then af "la unidad contiene WatchdogSec (I-10)"; return 1; fi
  if grep -q 'Requires=' "$unit"; then af "la unidad contiene Requires= (I-10)"; return 1; fi
  echo "  unidad portable OK: $unit"
}

# ── P8 (regresión T-go): go test ./... verde ────────────────────────────────
p8_regression() {
  set -euo pipefail
  ( cd "$SRC_ROOT/agent-kit/odoosh-proxy" && go test ./... )
}

# ── Ejecución ───────────────────────────────────────────────────────────────
run_step "P1 T-build (tarball + binario estático)" p1_build_tarball
run_step "P2 T-install (HOME temporal, 0755, vlpmcp, sin versión del proxy)" p2_install
run_step "P3 T-smoke (/healthz 200 {\"status\":\"ok\"})" p3_smoke
run_step "P7 unidad systemd portable" p7_unit
run_step "P8 regresión T-go (go test ./...)" p8_regression

printf '\n============================ RESUMEN ============================\n'
if ((${#PASS[@]})); then printf 'PASS  %s\n' "${PASS[@]}"; fi
if ((${#FAIL[@]})); then printf 'FAIL  %s\n' "${FAIL[@]}"; fi
printf 'Total: %d PASS, %d FAIL\n' "${#PASS[@]}" "${#FAIL[@]}"

if ((${#FAIL[@]})); then
  exit 1
fi
printf 'OK — smoke completo\n'
