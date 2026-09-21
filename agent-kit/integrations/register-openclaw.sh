#!/usr/bin/env bash
# register-openclaw.sh — register vlpmcp as the local MCP server "vulpo" in
# the OpenClaw config (fb-022-006).
#
# Usage:
#   register-openclaw.sh [--bin <path>] [--config <path>] [--dry-run | --remove] [--help]
#
# Default config: ~/.openclaw/openclaw.json (mcp.servers.<name>). Edits with
# python3 (the active config is usually minified), keeping every other key,
# with backup. Prefer `openclaw mcp add` when the CLI is available. Idempotent.
# The token is never written to the config: vlpmcp mcp-stdio reads it from its
# token file at runtime — stdio also bypasses the OpenClaw header-forwarding
# bug (#65590) by design.

set -euo pipefail

die() { echo "register-openclaw.sh: $*" >&2; exit 1; }

MODE="add"
DRY_RUN=0
VLPMCP="${VLP_BIN:-$HOME/.local/bin/vlpmcp}"
CONFIG="${VULPO_REGISTER_CONFIG:-$HOME/.openclaw/openclaw.json}"
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
        echo "Remove the \"vulpo\" entry from \"mcp.servers\" of $CONFIG by hand."
        return
    fi
    cat <<EOF
Add this under "mcp" → "servers" of $CONFIG (or: openclaw mcp add):

  "vulpo": { "command": "$VLPMCP", "args": ["mcp-stdio"], "transport": "stdio", "enabled": true }
EOF
}

if [[ "$MODE" == "add" && ! -x "$VLPMCP" ]]; then
    die "$VLPMCP not found; run the kit's install.sh first (or pass --bin)"
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "register-openclaw.sh: python3 not found; edit the config by hand." >&2
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
            print(f"register-openclaw.sh: cannot parse {path} as JSON ({exc}); "
                  "openclaw.json may contain non-JSON JSONC extensions — edit by hand.", file=sys.stderr)
            sys.exit(3)
if not isinstance(data, dict):
    print(f"register-openclaw.sh: {path} is not a JSON object", file=sys.stderr)
    sys.exit(3)
mcp = data.get("mcp", {})
if not isinstance(mcp, dict):
    mcp = {}
servers = mcp.get("servers", {})
if not isinstance(servers, dict):
    servers = {}

entry = {"command": vlpmcp, "args": ["mcp-stdio"], "transport": "stdio", "enabled": True}
if mode == "add":
    changed = servers.get("vulpo") != entry
    servers["vulpo"] = entry
    mcp["servers"] = servers
    data["mcp"] = mcp
else:
    changed = "vulpo" in servers
    servers.pop("vulpo", None)
    mcp["servers"] = servers
    data["mcp"] = mcp

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
    echo "verify with: openclaw mcp doctor vulpo --probe"
fi
