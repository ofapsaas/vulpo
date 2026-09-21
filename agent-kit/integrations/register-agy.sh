#!/usr/bin/env bash
# register-agy.sh — register vlpmcp as the local MCP server "vulpo" in the
# Gemini CLI (agy) config (fb-022-006).
#
# Usage:
#   register-agy.sh [--bin <path>] [--config <path>] [--dry-run | --remove] [--help]
#
# Default config: ~/.gemini/config/mcp_config.json (key "mcpServers"). Edits
# with python3, keeping every other key. Idempotent. The token is never
# written to the config: vlpmcp mcp-stdio reads it from its token file at
# runtime.

set -euo pipefail

die() { echo "register-agy.sh: $*" >&2; exit 1; }

MODE="add"
DRY_RUN=0
VLPMCP="${VLP_BIN:-$HOME/.local/bin/vlpmcp}"
CONFIG="${VULPO_REGISTER_CONFIG:-$HOME/.gemini/config/mcp_config.json}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --bin)     [[ $# -ge 2 ]] || die "--bin needs a value"; VLPMCP="$2"; shift 2 ;;
        --config)  [[ $# -ge 2 ]] || die "--config needs a value"; CONFIG="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --remove)  MODE="remove"; shift ;;
        -h|--help) sed -n '2,/^# the config/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

print_snippet() {
    if [[ "$MODE" == "remove" ]]; then
        echo "Remove the \"vulpo\" entry from \"mcpServers\" of $CONFIG by hand."
        return
    fi
    cat <<EOF
Add this under "mcpServers" of $CONFIG (or: agy mcp add):

  "vulpo": { "command": "$VLPMCP", "args": ["mcp-stdio"] }
EOF
}

if [[ "$MODE" == "add" && ! -x "$VLPMCP" ]]; then
    die "$VLPMCP not found; run the kit's install.sh first (or pass --bin)"
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "register-agy.sh: python3 not found; edit the config by hand." >&2
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
            print(f"register-agy.sh: cannot parse {path} as JSON ({exc}).", file=sys.stderr)
            sys.exit(3)
if not isinstance(data, dict):
    print(f"register-agy.sh: {path} is not a JSON object", file=sys.stderr)
    sys.exit(3)
servers = data.get("mcpServers", {})
if not isinstance(servers, dict):
    servers = {}

entry = {"command": vlpmcp, "args": ["mcp-stdio"]}
if mode == "add":
    changed = servers.get("vulpo") != entry
    servers["vulpo"] = entry
    data["mcpServers"] = servers
else:
    changed = "vulpo" in servers
    servers.pop("vulpo", None)
    data["mcpServers"] = servers

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
    echo "verify with: agy mcp list"
fi
