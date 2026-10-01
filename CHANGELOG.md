# Changelog

All notable changes to Vulpo are documented here. Format: Keep a Changelog.

## [Unreleased]

### Changed

- Tokens file parsing is now strict: a line with inner whitespace (for example,
  the old `token label` shape) makes `vlpsrv` exit with code 1 and report the
  offending line number — never the line's content. Files with one token per
  line (the canonical format) are unaffected.

### Removed

- Debug configuration hooks removed from the shipped extension. The extension
  takes its configuration only from the Options page; the E2E harness
  configures its own private copy and no longer relies on those hooks.

### Fixed

- The extension's internal control messages are now accepted only from the
  extension's own pages (popup/options). A message sent from a page context is
  rejected without changing any state. Existing page heartbeats are unaffected.

- `dev-harness` (`VLP_FRAME_E2E`) writes the canonical tokens file, probes the
  build/plan state with the real tab id, and loads the extension from a
  temporary copy with a harness-only background script, so the profile starts
  in Build without changing the product. The script is never committed and is
  not present in `src/extension/` or in the XPI.

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
