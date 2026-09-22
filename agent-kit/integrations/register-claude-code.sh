#!/usr/bin/env bash
# register-claude-code.sh — register vlpmcp as the local MCP server "vulpo" in
# the Claude Code user config (fb-022-006).
#
# Usage:
#   register-claude-code.sh [--bin <path>] [--config <path>]
#                           [--dry-run | --remove] [--help]
#
# Default config: ~/.claude.json (top-level "mcpServers", user scope). If the
# `claude` CLI is available it is used when no --config override is given
# (the official CLI handles its own minified config); with a --config override
# the script edits the file directly (testability). Idempotent. The token is
# never written to the config: vlpmcp mcp-stdio reads it from its token file
# at runtime.

set -euo pipefail

die() { echo "register-claude-code.sh: $*" >&2; exit 1; }

MODE="add"
DRY_RUN=0
VLPMCP="${VLP_BIN:-$HOME/.local/bin/vlpmcp}"
CONFIG=""
CONFIG_EXPLICIT=0
[[ -n "${VULPO_REGISTER_CONFIG:-}" ]] && { CONFIG="${VULPO_REGISTER_CONFIG}"; CONFIG_EXPLICIT=1; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --bin)     [[ $# -ge 2 ]] || die "--bin needs a value"; VLPMCP="$2"; shift 2 ;;
        --config)  [[ $# -ge 2 ]] || die "--config needs a value"; CONFIG="$2"; CONFIG_EXPLICIT=1; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --remove)  MODE="remove"; shift ;;
        -h|--help) sed -n '2,/^# the config/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done
[[ -n "$CONFIG" ]] || { CONFIG="$HOME/.claude.json"; CONFIG_EXPLICIT=0; }

print_snippet() {
    if [[ "$MODE" == "remove" ]]; then
        echo "Remove the \"vulpo\" entry from the top-level \"mcpServers\" key of $CONFIG by hand."
        return
    fi
    cat <<EOF
Register with the Claude Code CLI:
  claude mcp add --scope user --transport stdio vulpo -- "$VLPMCP" mcp-stdio
Or add manually under the top-level "mcpServers" key of $CONFIG:

  "vulpo": { "type": "stdio", "command": "$VLPMCP", "args": ["mcp-stdio"] }
EOF
}

if [[ "$MODE" == "add" && ! -x "$VLPMCP" ]]; then
    die "$VLPMCP not found; run the kit's install.sh first (or pass --bin)"
fi

# Official CLI path (only when no explicit config override): let Claude Code
# manage its own (minified) config. With --config/--config-env, edit directly
# (testability — never touch the host config from tests).
if [[ "$CONFIG_EXPLICIT" -eq 0 ]] && command -v claude >/dev/null 2>&1; then
    if [[ "$MODE" == "remove" ]]; then
        if [[ $DRY_RUN -eq 1 ]]; then
            echo "dry-run: claude mcp remove --scope user vulpo"
            exit 0
        fi
        claude mcp remove --scope user vulpo || true
        echo "removed: mcp.vulpo (user scope)"
        exit 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "dry-run: claude mcp add --scope user --transport stdio vulpo -- \"$VLPMCP\" mcp-stdio"
        exit 0
    fi
    claude mcp remove --scope user vulpo >/dev/null 2>&1 || true
    claude mcp add --scope user --transport stdio vulpo -- "$VLPMCP" mcp-stdio
    echo "verify with: claude mcp list"
    exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "register-claude-code.sh: python3 not found; edit the config by hand." >&2
    print_snippet
    exit 1
fi

rc=0
python3 - "$CONFIG" "$MODE" "$DRY_RUN" "$VLPMCP" <<'PY' || rc=$?
import json
import os
import shutil
import sys

path, mode, dry_run, vlpmcp = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]

data = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if text.strip():
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            print(f"register-claude-code.sh: cannot parse {path} as JSON ({exc}).", file=sys.stderr)
            sys.exit(3)
if not isinstance(data, dict):
    print(f"register-claude-code.sh: {path} is not a JSON object", file=sys.stderr)
    sys.exit(3)
servers = data.get("mcpServers", {})
if not isinstance(servers, dict):
    print(f"register-claude-code.sh: \"mcpServers\" in {path} is not an object", file=sys.stderr)
    sys.exit(3)

entry = {"command": vlpmcp, "args": ["mcp-stdio"], "type": "stdio"}
if mode == "add":
    changed = servers.get("vulpo") != entry
    servers["vulpo"] = entry
    data["mcpServers"] = servers
else:
    changed = "vulpo" in servers
    servers.pop("vulpo", None)

rendered = json.dumps(data, indent=2) + "\n"
if dry_run:
    sys.stdout.write(rendered)
    sys.exit(0)
if not changed:
    print(f"unchanged: {path} (vulpo already {'registered' if mode == 'add' else 'absent'})")
    sys.exit(0)

os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(rendered)
if os.path.exists(path):
    shutil.copy2(path, path + ".bak")
    shutil.copymode(path, tmp)
    print(f"backup:    {path}.bak")
os.replace(tmp, path)
print(f"{'registered' if mode == 'add' else 'removed'}: mcp.vulpo in {path}")
PY

if [[ $rc -eq 3 ]]; then
    print_snippet
    exit 1
fi
[[ $rc -eq 0 ]] || exit "$rc"
if [[ $DRY_RUN -eq 0 && "$MODE" == "add" ]]; then
    echo "verify with: claude mcp list"
fi
