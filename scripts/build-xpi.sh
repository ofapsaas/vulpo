#!/bin/bash
# build-xpi.sh — Package Vulpo extension as XPI
#
# XPI = ZIP with .xpi extension, signed or unsigned.
# Firefox supports unsigned XPI via about:config (xpinstall.signatures.required=false)
# or in Nightly/Developer editions.
#
# Usage:
#   ./scripts/build-xpi.sh                     # Build unsigned XPI
#   ./scripts/build-xpi.sh --version 0.2.0     # Build with version override
#   ./scripts/build-xpi.sh --output ./dist     # Output directory
#   ./scripts/build-xpi.sh --install           # Build + copy to ~/Desktop for side-load
#   ./scripts/build-xpi.sh --sign              # Sign via web-ext sign (requires AMO API keys)
#   ./scripts/build-xpi.sh --web-ext-run       # Launch via web-ext with NM support
#
# Output: ./dist/vulpo-<version>.xpi
#
# Environment:
#   WEB_EXT_API_KEY     — AMO API key (for --sign)
#   WEB_EXT_API_SECRET  — AMO API secret (for --sign)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION_DIR="$PROJECT_DIR/extension"
DIST_DIR="${DIST_DIR:-$PROJECT_DIR/dist}"
VERSION="${VERSION:-}"

# ---- Parse args ----
INSTALL=false
SIGN=false
WEB_EXT_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"; shift 2 ;;
    --output)
      DIST_DIR="$2"; shift 2 ;;
    --install)
      INSTALL=true; shift ;;
    --sign)
      SIGN=true; shift ;;
    --web-ext-run)
      WEB_EXT_RUN=true; shift ;;
    --help|-h)
      echo "🔌 Vulpo XPI Builder"
      echo ""
      echo "Usage: $0 [options]"
      echo "  --version <ver>    Override version from manifest"
      echo "  --output <dir>     Output directory (default: $DIST_DIR)"
      echo "  --install          Copy XPI to \$HOME for side-load"
      echo "  --sign             Sign via web-ext (needs AMO API keys)"
      echo "  --web-ext-run      Launch via web-ext with NM support"
      exit 0 ;;
    *)
      echo "❌ Unknown option: $1"; exit 1 ;;
  esac
done

# ---- Check deps ----
if ! command -v zip &>/dev/null; then
  echo "❌ 'zip' not found. Install: apt install zip" >&2
  exit 1
fi

# ---- Resolve version ----
if [ -z "$VERSION" ]; then
  VERSION=$(grep '"version"' "$EXTENSION_DIR/manifest.json" | sed 's/.*: *"\(.*\)",*/\1/')
fi

# ---- Ensure extension dir exists ----
if [ ! -d "$EXTENSION_DIR" ]; then
  echo "❌ Extension directory not found: $EXTENSION_DIR" >&2
  exit 1
fi

# ---- Build ----
mkdir -p "$DIST_DIR"
OUTPUT="$DIST_DIR/vulpo-${VERSION}.xpi"

echo "🔌 Vulpo XPI Builder"
echo "========================"
echo "Extension: $EXTENSION_DIR"
echo "Version:   $VERSION"
echo "Output:    $OUTPUT"
echo ""

# Clean previous build
rm -f "$OUTPUT"

# Regenerar el bundle del frame driver (fb-017): serializer + resolver + act.
# Fail-loud: si esbuild no está, el build XPI falla acá y no shipea un bundle stale.
bash "$EXTENSION_DIR/frame/build-frame.sh"

# Regenerar el bundle del módulo session-probe (fb-019-001): wire de la sonda
# + clasificación + agregación de detección, IIFE con el global
# VulpoSessionProbe. Fail-loud igual que el frame.
bash "$EXTENSION_DIR/odoo/build-probe.sh"

# Create XPI (ZIP with .xpi extension)
cd "$EXTENSION_DIR"
zip -r "$OUTPUT" . \
  -x "node_modules/*" \
  -x "*/node_modules/*" \
  -x ".DS_Store" \
  -x "*.swp" \
  -x "*.swo" \
  -x "thumbs.db" \
  > /dev/null

FILESIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || stat -f%z "$OUTPUT" 2>/dev/null)
echo "✅ XPI built: $(basename "$OUTPUT") ($((FILESIZE / 1024)) KB)"

# ---- Verify ----
echo ""
echo "📋 Manifest:"
unzip -p "$OUTPUT" manifest.json 2>/dev/null | grep -E '"name"|"version"|"background"|"permissions"' | head -5

echo ""
echo "📦 Contents:"
unzip -l "$OUTPUT" 2>/dev/null | tail -5

# ---- Install (copy to home) ----
if [ "$INSTALL" = true ]; then
  mkdir -p "$HOME/Desktop"
  cp "$OUTPUT" "$HOME/Desktop/"
  echo ""
  echo "📥 Copied to $HOME/Desktop/"
fi

# ---- web-ext run (with NM support) ----
if [ "$WEB_EXT_RUN" = true ]; then
  if ! command -v web-ext &>/dev/null; then
    echo ""
    echo "⚠️  web-ext not found. Installing..."
    npm install -g web-ext
  fi

  echo ""
  echo "🚀 Starting web-ext run..."
  echo ""

  web-ext run \
    --source-dir "$EXTENSION_DIR" \
    --firefox "${FIREFOX_BIN:-firefox}" \
    --no-reload \
    --keep-profile-changes
fi

# ---- Sign ----
if [ "$SIGN" = true ]; then
  if ! command -v web-ext &>/dev/null; then
    echo "❌ web-ext not found. Install: npm install -g web-ext" >&2
    exit 1
  fi

  if [ -z "${WEB_EXT_API_KEY:-}" ] || [ -z "${WEB_EXT_API_SECRET:-}" ]; then
    echo "❌ WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set for signing" >&2
    exit 1
  fi

  echo ""
  echo "🔏 Signing via AMO..."
  web-ext sign \
    --source-dir "$EXTENSION_DIR" \
    --api-key "$WEB_EXT_API_KEY" \
    --api-secret "$WEB_EXT_API_SECRET" \
    --artifacts-dir "$DIST_DIR"

  echo "✅ Signed XPI in $DIST_DIR"
fi

echo ""
echo "📋 Next steps:"
echo "   Firefox (Developer/Nightly): about:addons → ⚙️ → Install Add-on From File"
echo "   Firefox (stable, unsigned):  about:config → xpinstall.signatures.required = false"
echo "   Or side-load: About:debugging → This Firefox → Load Temporary Add-on"
echo ""
echo "   Then start the server (server/bin/vlpsrv) and set the token in the extension Options."
