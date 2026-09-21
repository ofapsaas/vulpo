#!/usr/bin/env bash
# install.sh — install the Vulpo agent kit for the current user (fb-021 K3).
#
# Run it as the account that will use the kit, from inside the extracted kit
# directory (vulpo-agent-kit-<version>/). It never reads or writes the token.
#
# Installs:
#   ~/.local/bin/vlpmcp                                (0755)
#   ~/.local/share/vulpo-agent-kit/<version>/     (skills, integrations, VERSION)
#   ~/.config/opencode/skills/<skill>/                (only if ~/.config/opencode exists)

set -euo pipefail

die() { echo "install.sh: $*" >&2; exit 1; }

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$KIT_DIR/VERSION" ]] || die "VERSION not found in $KIT_DIR (run install.sh from an extracted kit)"
[[ -f "$KIT_DIR/bin/vlpmcp" ]] || die "bin/vlpmcp not found in $KIT_DIR"
[[ -d "$KIT_DIR/skills" ]] || die "skills/ not found in $KIT_DIR"

VERSION="$(tr -d '[:space:]' < "$KIT_DIR/VERSION")"
[[ -n "$VERSION" ]] || die "VERSION is empty in $KIT_DIR"

BIN_DIR="$HOME/.local/bin"
SHARE_DIR="$HOME/.local/share/vulpo-agent-kit/$VERSION"
OPENCODE_DIR="$HOME/.config/opencode"

mkdir -p "$BIN_DIR"
install -m 0755 "$KIT_DIR/bin/vlpmcp" "$BIN_DIR/vlpmcp"
echo "installed: $BIN_DIR/vlpmcp ($("$BIN_DIR/vlpmcp" version))"

if [[ "$(realpath "$KIT_DIR")" != "$(realpath -m "$SHARE_DIR")" ]]; then
    rm -rf "$SHARE_DIR"
    mkdir -p "$SHARE_DIR"
    cp -R "$KIT_DIR/." "$SHARE_DIR/"
fi
echo "kit:       $SHARE_DIR"

if [[ -d "$OPENCODE_DIR" ]]; then
    mkdir -p "$OPENCODE_DIR/skills"
    for skill in "$SHARE_DIR"/skills/*/; do
        name="$(basename "$skill")"
        rm -rf "$OPENCODE_DIR/skills/$name"
        cp -R "$skill" "$OPENCODE_DIR/skills/$name"
        echo "skill:     $OPENCODE_DIR/skills/$name"
    done
else
    echo "skills:    $SHARE_DIR/skills/ (OpenCode not found; point your runtime to this directory)"
fi

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not in PATH; add it to use 'vlpmcp' by name" ;;
esac

cat <<EOF

Next steps:
  1. The operator provides the token file: ~/.config/vulpo/token (mode 0600).
     install.sh never writes it.
  2. Check the chain server -> token -> extension:
       $BIN_DIR/vlpmcp doctor
  3. Optional, OpenCode native tools:
       $SHARE_DIR/integrations/register-opencode.sh
EOF
