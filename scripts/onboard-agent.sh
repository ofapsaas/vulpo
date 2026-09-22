#!/usr/bin/env bash
# onboard-agent.sh — onboard a local agent account onto Vulpo (fb-021 K6).
#
# Usage:
#   onboard-agent.sh <account> --token-mode tenant --token-file <file> [--kit <tarball>] [--yes]
#   onboard-agent.sh <account> --token-mode own [--kit <tarball>] [--yes]
#
# Run by the operator (the account that owns the server's tokens file).
#   tenant  hands over the token stored in --token-file.
#   own     generates a new token, backs up the tokens file, appends a line
#           containing ONLY the token (one token per line; the server reads
#           each non-blank, non-comment line as one token) and replaces the
#           file atomically (0600). The server must then be restarted by
#           hand; this script never restarts it.
# Both modes, as the account (sudo -u <account> -H): extract the kit into
# ~/tmp, run install.sh, write ~/.config/vulpo/token (0600, token through
# stdin) and run vlpmcp doctor. The token is never printed.
#
# Environment: VLP_TOKENS_FILE (default ~/.vulpo/tokens.txt).
# The kit defaults to the newest dist/vulpo-agent-kit-*.tar.gz.

set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKENS_FILE="${VLP_TOKENS_FILE:-$HOME/.vulpo/tokens.txt}"

die() { echo "onboard-agent.sh: $*" >&2; exit 1; }
usage() { sed -n '2,/^# The kit defaults/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

ACCOUNT=""
TOKEN_MODE=""
TOKEN_FILE=""
KIT=""
YES=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --token-mode) [[ $# -ge 2 ]] || die "--token-mode needs a value"; TOKEN_MODE="$2"; shift 2 ;;
        --token-file) [[ $# -ge 2 ]] || die "--token-file needs a value"; TOKEN_FILE="$2"; shift 2 ;;
        --kit)        [[ $# -ge 2 ]] || die "--kit needs a value"; KIT="$2"; shift 2 ;;
        --yes)        YES=1; shift ;;
        -h|--help)    usage 0 ;;
        -*)           die "unknown option: $1 (see --help)" ;;
        *)
            [[ -z "$ACCOUNT" ]] || die "unexpected argument: $1"
            ACCOUNT="$1"; shift ;;
    esac
done

[[ -n "$ACCOUNT" ]] || die "missing <account> (see --help)"
[[ "$ACCOUNT" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid account name: $ACCOUNT"
id "$ACCOUNT" >/dev/null 2>&1 || die "account does not exist: $ACCOUNT"

case "$TOKEN_MODE" in
    tenant)
        [[ -n "$TOKEN_FILE" ]] || die "--token-mode tenant requires --token-file <file>"
        [[ -r "$TOKEN_FILE" ]] || die "cannot read token file: $TOKEN_FILE"
        ;;
    own)
        [[ -z "$TOKEN_FILE" ]] || die "--token-file is only for --token-mode tenant"
        [[ -f "$TOKENS_FILE" ]] || die "tokens file not found: $TOKENS_FILE"
        ;;
    *) die "--token-mode must be tenant or own" ;;
esac

if [[ -z "$KIT" ]]; then
    KIT="$(ls -1t "$SRC_ROOT"/dist/vulpo-agent-kit-*.tar.gz 2>/dev/null | head -n 1 || true)"
    [[ -n "$KIT" ]] || die "no kit tarball in $SRC_ROOT/dist; run scripts/build-agent-kit.sh or pass --kit"
fi
[[ -f "$KIT" ]] || die "kit tarball not found: $KIT"

command -v sudo >/dev/null 2>&1 || die "sudo is required"

echo "Onboarding plan:"
echo "  account:     $ACCOUNT"
echo "  token mode:  $TOKEN_MODE"
echo "  kit:         $KIT"
if [[ "$TOKEN_MODE" == "own" ]]; then
    echo "  tokens file: $TOKENS_FILE (backup + append of a one-token line)"
    echo "               a server restart will be needed afterwards (not done here)"
else
    echo "  token from:  $TOKEN_FILE"
fi
echo "  as $ACCOUNT: extract kit into ~/tmp, run install.sh, write ~/.config/vulpo/token (0600), run vlpmcp doctor"

if [[ $YES -eq 0 ]]; then
    answer=""
    read -r -p "Proceed? [y/N] " answer || true
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || die "aborted"
fi

# ---- token -------------------------------------------------------------------

# token_line_ok: the server's contract is one token per line — a token line is
# non-empty, not a comment, and contains no whitespace (the line IS the token).
token_line_ok() {
    local line="$1"
    [[ -n "$line" && "$line" != \#* && "$line" != *" "* && "$line" != *$'\t'* ]]
}

# validate_tokens_file fails if any line of <file> is neither blank, a comment,
# nor a plausible single-token line; it prints that line's number, never its
# content (it may hold a token).
validate_tokens_file() {
    awk '
        /^[[:space:]]*(#|$)/ { next }
        /[[:space:]]/ { print NR; invalid = 1; exit }
        END { exit invalid }
    ' "$1"
}

# append_tokens_line prints <file> with <line> appended: the new line travels
# through the environment, not argv, so the token never shows up in the
# process list.
append_tokens_line() {
    NEW_TOKENS_LINE="$2" awk '{ print } END { print ENVIRON["NEW_TOKENS_LINE"] }' "$1"
}

TOKEN=""
if [[ "$TOKEN_MODE" == "tenant" ]]; then
    TOKEN="$(<"$TOKEN_FILE")"
    TOKEN="${TOKEN//[[:space:]]/}"
    [[ -n "$TOKEN" ]] || die "token file is empty: $TOKEN_FILE"
else
    TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]] || die "could not generate a 64-hex-digit token"
    token_line_ok "$TOKEN" || die "generated token is invalid; tokens file untouched"

    backup="$TOKENS_FILE.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$TOKENS_FILE" "$backup"
    chmod 600 "$backup"
    tmp="$(mktemp "$TOKENS_FILE.tmp.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    append_tokens_line "$TOKENS_FILE" "$TOKEN" > "$tmp"
    chmod 600 "$tmp"
    bad_line="$(validate_tokens_file "$tmp")" \
        || die "the resulting tokens file would have an invalid token line (line $bad_line is not a single-token line); tokens file untouched"
    mv -f "$tmp" "$TOKENS_FILE"
    trap - EXIT
    echo "tokens file updated: $TOKENS_FILE (backup: $backup)"
fi

# ---- install as the account ----------------------------------------------------

as_account() { sudo -u "$ACCOUNT" -H bash -c "$1"; }

echo "installing the kit as $ACCOUNT..."
# The operator's home is not readable by other accounts: the tarball goes through stdin.
as_account '
    set -euo pipefail
    dest="$HOME/tmp/vulpo-agent-kit-install"
    rm -rf "$dest"
    mkdir -p "$dest"
    tar -xzf - -C "$dest"
    kit="$(find "$dest" -mindepth 1 -maxdepth 1 -type d -name "vulpo-agent-kit-*" | head -n 1)"
    [[ -n "$kit" ]] || { echo "the tarball has no vulpo-agent-kit-* directory" >&2; exit 1; }
    bash "$kit/install.sh"
' < "$KIT"

echo "writing ~/.config/vulpo/token for $ACCOUNT..."
printf '%s\n' "$TOKEN" | as_account '
    set -euo pipefail
    umask 077
    dir="$HOME/.config/vulpo"
    mkdir -p "$dir"
    chmod 700 "$dir"
    cat > "$dir/token.tmp"
    chmod 600 "$dir/token.tmp"
    mv -f "$dir/token.tmp" "$dir/token"
'
TOKEN=""

echo "running vlpmcp doctor as $ACCOUNT:"
doctor_exit=0
as_account '"$HOME/.local/bin/vlpmcp" doctor' || doctor_exit=$?

echo
if [[ "$TOKEN_MODE" == "own" ]]; then
    cat <<'EOF'
A server restart is required for the new token to be accepted. It drops every
MCP session and reconnects every extension. When convenient, run:
  systemctl --user restart vlpsrv
The token has no browser behind it until a Firefox with the Vulpo extension
is configured with it (doctor reports "extension: not connected" until then).
EOF
fi
if [[ $doctor_exit -eq 0 ]]; then
    echo "onboarding of $ACCOUNT complete: doctor is all ok"
else
    echo "onboarding of $ACCOUNT installed; vlpmcp doctor exited $doctor_exit (see docs/troubleshooting.md)"
fi
