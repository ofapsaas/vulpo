#!/usr/bin/env bash
# register-opencode.sh — register vlpmcp as the local MCP server "vulpo" in
# the OpenCode user config (fb-021 K4).
#
# Usage:
#   register-opencode.sh             add or update mcp.vulpo (backup to <config>.bak)
#   register-opencode.sh --dry-run   print the resulting config without writing
#   register-opencode.sh --remove    remove mcp.vulpo (backup to <config>.bak)
#
# Edits ~/.config/opencode/opencode.json (or opencode.jsonc if it exists) with
# python3, keeping every other key. Idempotent. The token is never written to
# the config: vlpmcp mcp-stdio reads it from its token file at runtime.

set -euo pipefail

die() { echo "register-opencode.sh: $*" >&2; exit 1; }

MODE="add"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --remove)  MODE="remove"; shift ;;
        -h|--help) sed -n '2,/^# the config/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

VLPMCP="$HOME/.local/bin/vlpmcp"
CONFIG_DIR="$HOME/.config/opencode"
CONFIG="$CONFIG_DIR/opencode.json"
[[ -f "$CONFIG_DIR/opencode.jsonc" ]] && CONFIG="$CONFIG_DIR/opencode.jsonc"

print_snippet() {
    if [[ "$MODE" == "remove" ]]; then
        echo "Remove the \"vulpo\" entry under the top-level \"mcp\" key of $CONFIG by hand."
        return
    fi
    cat <<EOF
Add this under the top-level "mcp" key of $CONFIG:

  "vulpo": {
    "type": "local",
    "command": ["$VLPMCP", "mcp-stdio"],
    "enabled": true
  }
EOF
}

if [[ "$MODE" == "add" && ! -x "$VLPMCP" ]]; then
    die "$VLPMCP not found; run the kit's install.sh first"
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "register-opencode.sh: python3 not found; edit the config by hand." >&2
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
            print(f"register-opencode.sh: cannot parse {path} as plain JSON ({exc}); "
                  "comments are not supported.", file=sys.stderr)
            sys.exit(3)
if not isinstance(data, dict):
    print(f"register-opencode.sh: {path} is not a JSON object", file=sys.stderr)
    sys.exit(3)
mcp = data.get("mcp", {})
if not isinstance(mcp, dict):
    print(f"register-opencode.sh: \"mcp\" in {path} is not an object", file=sys.stderr)
    sys.exit(3)

entry = {"type": "local", "command": [vlpmcp, "mcp-stdio"], "enabled": True}
if mode == "add":
    changed = mcp.get("vulpo") != entry
    mcp["vulpo"] = entry
    data["mcp"] = mcp
else:
    changed = "vulpo" in mcp
    mcp.pop("vulpo", None)

rendered = json.dumps(data, indent=2) + "\n"
if dry_run:
    sys.stdout.write(rendered)
    sys.exit(0)
if not changed:
    print(f"unchanged: {path} (vulpo already {'registered' if mode == 'add' else 'absent'})")
    sys.exit(0)

os.makedirs(os.path.dirname(path), exist_ok=True)
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
    echo "verify with: opencode mcp list"
fi
