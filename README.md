# Vulpo

**Vulpo** is a browser-navigation product for AI agents: a Firefox extension
connected over WebSocket to a Go server, with MCP tools (Streamable HTTP)
for tabs, DOM, safe actions and Odoo sessions.

## Components

| Component | What it is |
|---|---|
| `extension/` | Firefox extension (MV3): WebSocket bridge, frame driver, nav-guard, Odoo session probe. |
| `server/` | Go server (`vlpsrv`): WS `/extension` + MCP Streamable HTTP at `/mcp`, 33 tools (21 `vlp_*` + 12 Odoo). |
| `agent-kit/` | Agent kit: CLI `vlpmcp` (MCP stdio ↔ Streamable HTTP), skills and integrations. |
| `scripts/` | Builds: `build-server.sh`, `build-xpi.sh`, `build-agent-kit.sh`, `onboard-agent.sh`. |
| `docs/` | Getting started, agents, security, troubleshooting. |

## Getting started

### 1. Server

```bash
./scripts/build-server.sh            # → server/bin/vlpsrv (static, CGO off)
./server/bin/vlpsrv --check
```

Tokens: one per line (comments with `#`), file `~/.vulpo/tokens.txt` by
default (configurable with `VLP_TOKENS_FILE`), mode 0600. See
`tokens.txt.example`. The server starts with `VLP_*` env vars (`VLP_PORT`,
`VLP_BIND_ADDR`, …) and fails loud if the tokens file is unreadable or empty.

```bash
./server/bin/vlpsrv
# → SYSTEM VLP_READY {bind:127.0.0.1 port:8765 profiles:N}
```

### 2. Firefox extension

```bash
./scripts/build-xpi.sh               # → dist/vulpo-<version>.xpi
```

In the extension's Options, set the token (the same one from the server).
The extension connects to `ws://127.0.0.1:8765/extension`.

### 3. Agent

Agents use the `vlpmcp` CLI (or native MCP tools registered through it)
against `http://127.0.0.1:8765/mcp` with the `x-vlp-token` header. The token
is read from `~/.config/vulpo/token` (0600); the CLI never accepts it as an
argument.

```bash
vlpmcp doctor
vlpmcp tools
vlpmcp call vlp_listTabs '{}'
```

See `docs/getting-started.md` and `docs/agents.md`.

## Development

```bash
cd server && go test ./...            # Go suite (includes the brand and docs guards)
cd agent-kit/cli && go test ./...
cd extension/frame && npm ci && node --test *.test.js
cd extension/odoo && node --test *.test.js
```

## License

GPL-3.0-or-later. Copyright 2026 Vulpo contributors.
