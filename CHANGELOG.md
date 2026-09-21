# Changelog

All notable changes to Vulpo are documented here. Format: Keep a Changelog.

## [0.5.2] — 2026-09-21

### Removed

- `vlp_togglePlanMode` — plan/build mode is now user-only (extension popup).
  Agents cannot change it.

## [0.5.0] — 2026-09-21

First release of Vulpo.

### Added

- Firefox extension (MV3): WebSocket bridge, accessible frame driver (DOM→LLM
  map with stable refs), nav-guard, site profiles (Odoo) and Odoo session probe.
- Go server (`vlpsrv`): WS `/extension` + MCP Streamable HTTP at `/mcp` with
  34 tools — 22 `vlp_*` browser tools and 12 Odoo tools with mcp.odoo surface
  parity (pagination envelope, formats, write gates).
- Agent kit: `vlpmcp` CLI (tools/call/ping/doctor + `mcp-stdio` bridge),
  English skills (`vulpo`, `vulpo-web-navigation`, `vulpo-odoo-web`), installer and
  runtime registration integrations.
- User documentation: getting started, agents, security, troubleshooting,
  generated tools reference (`cmd/gen-docs`) and this changelog.
- Permanent in-suite guards: brand guard (`internal/brandguard`) and docs
  guard (`internal/docsguard`).
