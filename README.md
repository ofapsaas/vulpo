# Vulpo

**Vulpo** is a browser-navigation product for AI agents: a Firefox extension
connected over WebSocket to a Go server, with MCP tools (Streamable HTTP)
for tabs, DOM, safe actions and Odoo sessions.

https://addons.mozilla.org/firefox/addon/vulpo-mcp-browser-bridge/

## Problems Vulpo solves

1. **Real, logged-in sessions.** Agents drive your actual Firefox and its
   already-open sessions — no API, no separate headless browser, no
   credentials handed over.
2. **The raw DOM does not fit an LLM.** Vulpo serializes a compact, paginated
   *frame* of stable, re-queryable refs (invalidated only when the DOM
   changes) instead of dumping HTML.
3. **Agents act blind.** `vlp_act` reports honestly whether an action took
   effect (detects disabled controls), observes the value written, waits for
   the page to settle, and surfaces native dialogs — no false "ok".
4. **Odoo without API keys.** 12 Odoo tools (models, fields, search/export,
   create/write/unlink) run on the browser session; they work on Odoo Online,
   where no key or network access is available.
5. **Browser control without giving away the keys.** The server is local by
   default, one token = one tenant = one browser, tenants are isolated, and
   the token is handled by `vlpmcp`/onboarding — never passed as an argument
   to the agent nor printed.

**Local or remote, either way.** The server can run on your own machine or on
a server. Hosted remotely, your local Firefox extension points its `bridgeUrl`
at it and remote agents reach the same MCP endpoint — so a remote agent can
drive your local browser. Run it locally and the same endpoint serves local
agents (and remote ones too, if you expose it over VPN/LAN). See
[Security](docs/security.md) before binding beyond loopback.

## Components

| Component | What it is |
|---|---|
| `extension/` | Firefox extension (MV3): WebSocket bridge, frame driver, nav-guard, Odoo session probe. |
| `server/` | Go server (`vlpsrv`): WS `/extension` + MCP Streamable HTTP at `/mcp`, 33 tools (21 `vlp_*` + 12 Odoo). |
| `agent-kit/` | Agent kit: CLI `vlpmcp` (MCP stdio ↔ Streamable HTTP), skills and integrations. |
| `agent-kit/odoosh-proxy/` | Pass-through proxy `vlp-odoosh-proxy` that connects `odoosh-mcp` to an authenticated `odoo.sh` tab through Vulpo. |
| `scripts/` | Builds: `build-server.sh`, `build-xpi.sh`, `build-agent-kit.sh`, `onboard-agent.sh`. |
| `docs/` | Getting started, agents, security, troubleshooting, `odoosh-proxy.md`. |

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
cd agent-kit/odoosh-proxy && go test ./...
cd extension/frame && npm ci && node --test *.test.js
cd extension/odoo && node --test *.test.js
```

## License

GPL-3.0-or-later. Copyright 2026 Vulpo contributors.
