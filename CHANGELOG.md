# Changelog

All notable changes to Vulpo are documented here. Format: Keep a Changelog.

## [0.5.6] — 2026-10-07

### Security

- **The agent can no longer shed its own scope.** Navigating a tab out of the
  agent's assigned domains does not release the pin, and while a pin is set
  the agent cannot close it — nor any other tab — so the pinned window or tab
  can no longer be emptied to drop the anchor. The pin is released only by the
  operator's action or by the anchor's own disappearance (its tab or window
  closing).

- **The Odoo tab registry no longer exposes tabs outside the agent's scope.**
  `list_available_profiles` reports only the tabs inside the active scope, and
  every Odoo call re-resolves its tab with a scope-aware detection, so a stale
  registry entry can never be used to reach a tab the agent does not own.

### Fixed

- **A response that omits `result` is malformed, not empty.** The relay now
  tells the presence of `result` apart from its value: a frame carrying
  `result: null` is a valid result (the agent receives `null`) and a frame
  without the key is rejected with an error, instead of both collapsing into a
  silent `null`. The extension normalizes a handler's `undefined` return into
  an explicit `null`, so the two cases can no longer be confused.

- **The pin control can no longer get stuck.** A failure while reading the pin
  state clears the pin and refreshes, so the operator can always return to "no
  pin"; the popup shows the pin state unambiguously.

### Added

- **Host + path scope rules, with wildcards.** An agent's scope is now defined
  by host and path patterns (`*` matches inside both), with an explicit
  fail-closed direction: an unreadable rule is discarded, never widened. The
  Options page reports the rule warnings and never clears them on its own.

### Changed

- **Tab handlers no longer steal focus.** Opening or activating a tab on the
  agent's behalf works in the background and does not move the user's focus;
  under a pin, `getCurrentTab` answers with the pinned tab and the Odoo
  detection is tab-aware.

## [0.5.5] — 2026-10-05

### Added

- **`vlp-odoosh-proxy`**, a new component of the agent kit: an HTTP proxy that
  connects [`odoosh-mcp`](https://pypi.org/project/odoosh-mcp-server/) — an
  independent, MIT-licensed upstream project by Hugo Adan Oliva — to an
  authenticated `odoo.sh` tab through Vulpo. It replaces the direct egress from
  `odoosh-mcp` to `odoo.sh` and runs each control-plane request as a synchronous
  `vlp_eval` inside the tab, so the browser attaches the session cookie and no
  file holds it. The kit ships the static binary, the systemd user unit and the
  documentation (`docs/odoosh-proxy.md`). The proxy is a transparent
  pass-through: the write ceiling lives on the `odoosh-mcp` side.

- **`actionable` on table cells** (`vlp_getFrame`): a control inside a table
  cell now inherits its row, and a simple table resolves the column header, so
  an agent can tell which row a control belongs to before acting on it.

### Changed

- The Odoo web skill (`vulpo-odoo-web`) line-loading recipe was rewritten with
  a closed set of steps, the real role, and modal handling.

## [0.5.4] — 2026-10-01

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

- `vlp_eval` now runs the agent's JavaScript in the page's own (MAIN) world
  instead of the content-script world: it works on pages whose CSP permits
  `eval`, and on a page with a strict CSP it fails honestly with the page's
  `call to eval() blocked by CSP` error without running anything. The executed
  code no longer has access to extension APIs (`browser.runtime`,
  `browser.storage`). Its tool description now states all of this.

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
