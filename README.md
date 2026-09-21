# Vulpo

**Vulpo** es un producto de navegación de browser para agentes AI: una
extensión de Firefox conectada por WebSocket a un server Go, con herramientas
MCP (Streamable HTTP) para tabs, DOM, acciones seguras y sesiones Odoo.

## Componentes

| Componente | Qué es |
|---|---|
| `extension/` | Extensión Firefox (MV3): bridge WebSocket, frame driver, nav-guard, sonda de sesión Odoo. |
| `server/` | Server Go (`vlpsrv`): WS `/extension` + MCP Streamable HTTP en `/mcp`, 34 tools (22 `vlp_*` + 12 odoo). |
| `agent-kit/` | Kit para agentes: CLI `vlpmcp` (MCP stdio ↔ Streamable HTTP), skills e integraciones. |
| `scripts/` | Builds: `build-server.sh`, `build-xpi.sh`, `build-agent-kit.sh`, `onboard-agent.sh`. |
| `docs/` | Getting started, agents, security, troubleshooting. |

## Getting started

### 1. Server

```bash
./scripts/build-server.sh            # → server/bin/vlpsrv (estático, CGO off)
./server/bin/vlpsrv --check
```

Tokens: un token por línea (comentarios con `#`), archivo `~/.vulpo/tokens.txt`
por defecto (configurable con `VLP_TOKENS_FILE`), modo 0600. Ver
`tokens.txt.example`. El server arranca con env `VLP_*` (`VLP_PORT`,
`VLP_BIND_ADDR`, …) y falla loud si el tokens file es ilegible o vacío.

```bash
./server/bin/vlpsrv
# → SYSTEM VLP_READY {bind:127.0.0.1 port:8765 profiles:N}
```

### 2. Extensión Firefox

```bash
./scripts/build-xpi.sh               # → dist/vulpo-<version>.xpi
```

En las Options de la extensión, configurar el token (el mismo del server). La
extensión conecta a `ws://127.0.0.1:8765/extension`.

### 3. Agente

Los agentes usan el CLI `vlpmcp` (o tools MCP nativas registradas a través de
él) contra `http://127.0.0.1:8765/mcp` con header `x-vlp-token`. El token se
lee de `~/.config/vulpo/token` (0600); el CLI nunca lo acepta como argumento.

```bash
vlpmcp doctor
vlpmcp tools
vlpmcp call vlp_listTabs '{}'
```

Ver `docs/getting-started.md` y `docs/agents.md`.

## Desarrollo

```bash
cd server && go test ./...            # suite Go (incluye el guardián de marca)
cd agent-kit/cli && go test ./...
cd extension/frame && npm ci && node --test *.test.js
cd extension/odoo && node --test *.test.js
```

## Licencia

GPL-3.0-or-later. Copyright 2026 Vulpo contributors.
