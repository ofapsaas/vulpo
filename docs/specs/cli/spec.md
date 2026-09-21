# Vulpo CLI (`vlpmcp`) — specification

> In-repo contract for the agent-kit CLI. Feature `fb-022-004` (epic
> `fb-022-vulpo-extract`) verified it against the test suite C1..C13 /
> P14..P25 in `agent-kit/cli/`.

## Purpose

`vlpmcp` is a static Go CLI that lets any agent operate Vulpo's MCP surface
without hand-writing HTTP clients: token handling stays out of agent sight,
the MCP session survives server restarts, and native MCP registration is
possible through a stdio bridge.

## Subcommands

| Command | What it does |
|---|---|
| `tools` | List tools from the server; `--json` for raw output, `--schema <tool>` for one schema. |
| `call <tool> [args\|-]` | Invoke a tool; args as inline JSON or `-` (stdin). `--raw` prints the full JSON-RPC envelope. |
| `ping` | JSON-RPC ping round-trip. |
| `doctor` | One line + exit code per aspect: server, token, extension connected. |
| `mcp-stdio` | MCP stdio server that proxies to the HTTP transport, injecting auth. |
| `version` | Print semver. |

Unknown or missing subcommand → exit 2 with usage on stderr.

## Token contract

- Read ONLY from `VLP_TOKEN_FILE` or, by default, `~/.config/vulpo/token`
  (mode 0600 enforced). Never via argv or flags; never printed to stdout,
  stderr or the JSONL log, in any subcommand or error path (tests C8).
- Invalid file content/mode → exit 3 with an actionable message. Exit 7 is
  reserved for a token rejected by the server (401).

## Session and retry

- The `Mcp-Session-Id` is captured at `initialize`, stored atomically
  (`~/.cache/vulpo/session`, 0600; `VLP_SESSION_FILE` override) and reused
  on every request.
- On HTTP 404 (session revoked, e.g. server restart): drop session,
  re-`initialize` and retry ONCE. A second 404 → exit 4.

## Timeouts and exit codes

- HTTP client timeout: default 1800s (the server guarantees an outcome via
  its idle budget), `VLP_TIMEOUT` in seconds, invalid value → exit 2.
- Exit codes: 0 OK · 2 usage · 3 token config · 4 HTTP/session-404 · 5 RPC
  error · 7 invalid token · 8 network/timeout (message distinguishes
  "no answer (may still be processing)" from "server unreachable") ·
  9 doctor: extension not connected.

## JSONL log (`VLP_LOG`)

When set, each call appends one JSON line with ONLY: `ts`, `method`, `tool`,
`ms`, `exit`. Arguments, results and the token never reach the log.

## `doctor`

- `server: ok` / `server: unreachable` (exit 8) — a 401 still means the
  server is alive.
- `token: ok` / `token: missing` / `token: invalid file` (exit 3) /
  `token: invalid` (exit 7).
- `extension: connected` / `extension: not connected` (exit 9).
- Warns when the server's `vulpo/agentKitRevision` is older than the kit.

## `mcp-stdio`

Line-delimited JSON-RPC over stdin/stdout: proxies `initialize` → captures
the session → `tools/list`, `tools/call`, notifications. Injects
`x-vlp-token` and `Mcp-Session-Id` on every HTTP request (runtimes that do
not forward custom headers are supported through this bridge); single retry
on 404; errors reach the client as JSON-RPC code -32000 without exposing the
token; diagnostics go to stderr only; EOF → exit 0.

## Development

```bash
cd agent-kit/cli && go test ./...
```

License: GPL-3.0-or-later, Vulpo contributors.
