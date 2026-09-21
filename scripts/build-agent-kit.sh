#!/usr/bin/env bash
# build-agent-kit.sh — build the Vulpo agent kit tarball (fb-021 K5).
#
# Usage:
#   build-agent-kit.sh [--version X]           build dist/vulpo-agent-kit-<v>.tar.gz
#   build-agent-kit.sh [--version X] --check   list the contents of that tarball
#   build-agent-kit.sh -h|--help               this help
#
# The version defaults to 0.1.0+<git short sha>. The tarball holds a top-level
# vulpo-agent-kit-<v>/ with bin/vlpmcp (static linux/amd64), skills/,
# integrations/, install.sh, VERSION and README.md. Staging happens in $HOME/tmp.
#
# Exit codes: 0 OK · 1 usage/missing tool · 2 build failed · 3 tarball not found

set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT_SRC="$SRC_ROOT/agent-kit"
DIST_DIR="$SRC_ROOT/dist"

usage() {
    sed -n '2,/^# Exit codes:/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

die() { local code="$1"; shift; echo "build-agent-kit.sh: $*" >&2; exit "$code"; }

VERSION=""
CHECK=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            [[ $# -ge 2 ]] || die 1 "--version needs a value"
            VERSION="$2"; shift 2 ;;
        --check)   CHECK=1; shift ;;
        -h|--help) usage ;;
        *) die 1 "unknown option: $1 (see --help)" ;;
    esac
done

need() { command -v "$1" >/dev/null 2>&1 || die 1 "'$1' is required"; }
need tar

if [[ -z "$VERSION" ]]; then
    need git
    VERSION="0.1.0+$(git -C "$SRC_ROOT" rev-parse --short HEAD)"
fi
[[ "$VERSION" =~ ^[A-Za-z0-9._+-]+$ ]] || die 1 "invalid version: $VERSION"

NAME="vulpo-agent-kit-$VERSION"
TARBALL="$DIST_DIR/$NAME.tar.gz"

if [[ $CHECK -eq 1 ]]; then
    [[ -f "$TARBALL" ]] || die 3 "tarball not found: $TARBALL (build it first)"
    echo "tarball: $TARBALL ($(du -h "$TARBALL" | cut -f1))"
    tar -tzvf "$TARBALL"
    exit 0
fi

need go
for required in cli/main.go skills install.sh integrations/register-opencode.sh; do
    [[ -e "$KIT_SRC/$required" ]] || die 2 "missing $KIT_SRC/$required"
done

mkdir -p "$HOME/tmp" "$DIST_DIR"
STAGE_ROOT="$(mktemp -d "$HOME/tmp/build-agent-kit.XXXXXX")"
trap 'rm -rf "$STAGE_ROOT"' EXIT
STAGE="$STAGE_ROOT/$NAME"
mkdir -p "$STAGE/bin"

# fb-020-006 §2.6: same formula as build-server.sh. Without git (or history)
# the kit builds without a revision, which vlpmcp treats as unknown.
KIT_REVISION=""
if command -v git >/dev/null 2>&1; then
    KIT_REVISION="$(git -C "$SRC_ROOT" log -1 --format=%h --abbrev=12 -- agent-kit 2>/dev/null)" || KIT_REVISION=""
fi
LDFLAGS="-s -w -X main.version=$VERSION"
if [[ -n "$KIT_REVISION" ]]; then
    LDFLAGS="$LDFLAGS -X main.kitRevision=$KIT_REVISION"
else
    echo "build-agent-kit.sh: warning: cannot compute the agent kit revision (git log -- agent-kit); building without it" >&2
fi

( cd "$KIT_SRC/cli" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 TMPDIR="$STAGE_ROOT" \
    go build -ldflags "$LDFLAGS" -o "$STAGE/bin/vlpmcp" . ) \
    || die 2 "go build of vlpmcp failed"

cp -R "$KIT_SRC/skills" "$STAGE/skills"
cp -R "$KIT_SRC/integrations" "$STAGE/integrations"
install -m 0755 "$KIT_SRC/install.sh" "$STAGE/install.sh"
chmod 0755 "$STAGE"/integrations/*.sh
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

cat > "$STAGE/README.md" <<EOF
# Vulpo agent kit $VERSION

Everything an agent account needs to use Vulpo (drive a Firefox browser
through MCP) without ever handling the token:

- \`bin/vlpmcp\`: the CLI and MCP stdio bridge (static linux/amd64 binary).
- \`skills/\`: the \`vulpo\`, \`vulpo-web-navigation\` and \`vulpo-odoo-web\` skills.
- \`integrations/register-opencode.sh\`: registers \`vlpmcp mcp-stdio\` in OpenCode.
- \`install.sh\`: installs the kit for the current user.

## Install

Run as the account that will use the kit:

\`\`\`bash
tar -xzf $NAME.tar.gz
./$NAME/install.sh
\`\`\`

Then the operator provides the token file \`~/.config/vulpo/token\` (mode
0600), and you check the setup with \`~/.local/bin/vlpmcp doctor\`. For OpenCode
native tools, run
\`~/.local/share/vulpo-agent-kit/$VERSION/integrations/register-opencode.sh\`.

Operators usually do all of this with \`scripts/onboard-agent.sh\` from the
Vulpo repository. See \`docs/agents.md\` there for token modes, runtime
registration and the \`vlpmcp\` reference, and \`docs/troubleshooting.md\` for
\`doctor\` output and exit codes.
EOF

tar -C "$STAGE_ROOT" --owner=0 --group=0 --numeric-owner -czf "$TARBALL.tmp" "$NAME"
mv -f "$TARBALL.tmp" "$TARBALL"
echo "agent kit built: $TARBALL ($(du -h "$TARBALL" | cut -f1))"
