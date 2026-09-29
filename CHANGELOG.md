# Changelog

All notable changes to Vulpo are documented here. Format: Keep a Changelog.

## [0.5.3] — 2026-09-29

### Added

- `settle` site-loading-indicator veto: the §2.2.6 loading-indicator veto now
  also consults the active site profile's `loadingMarkerSelector`
  (`profiles/odoo.js: '.o_loading_indicator'`, measured in field). A page that
  still shows its own "Cargando" marker is never declared `settled:true`.
- `detectActiveProfile` guards `detect` with try/catch: a broken profile
  degrades validity but can never break serialization or the act/navigate
  frame fold (settles the robustness half of fb-020-005 review §5.4).
- Agent-kit SKILLs corrected: `selected` on dropdown options marks the
  highlighted option (the one Enter takes), never the field's current value —
  the current value is read from the field's own `value` key.

## [0.5.2] — 2026-09-21

### Removed

- `vlp_togglePlanMode` — plan/build mode is now user-only (extension popup).
  Agents cannot change it.

### Fixed

- Version negotiation across extension, server and agent kit: the product/
  protocol version (0.5.2) is now a single source (`mcp.ProductVersion`, pinned
  by `TestVersionPin` to `extension/manifest.json`). The kit build no longer
  defaults to a commit-derived version (`0.1.0+<sha>`); `vlpsrv` reports the
  product version everywhere (`--version`, `serverInfo`), the server declares
  it to the extension in the WS `welcome` (`serverVersion`, extension logs a
  warning on mismatch), and `vlpmcp doctor` prints `server version:` and warns
  on kit↔server mismatch. The popup header shows the manifest version
  dynamically instead of a stale hardcoded one.

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
