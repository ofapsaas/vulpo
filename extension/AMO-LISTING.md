# AMO listing copy (single source of truth for the add-on store listing)

> Paste these fields when submitting or editing the add-on on
> <https://addons.mozilla.org/developers>. Keep them in sync with the
> manifest `name`/`description` (the summary below must stay consistent
> with the manifest `description`, which is what Firefox shows).

## Summary (store one-liner, ≤ 250 chars)

```
Let AI agents operate your real Firefox — pages, forms, clicks and Odoo —
through MCP. Companion server required.
```

## Description (store long text)

```
Vulpo is a browser bridge for AI agents. It exposes your real Firefox session
(not a headless emulator) to any MCP-compatible agent, over an HTTP server
running on your own machine.

Where to get the server (required):
Download the Vulpo server and agent kit from https://github.com/ofapsaas/vulpo
— see docs/getting-started.md. Build the server (scripts/build-server.sh),
set your token in the extension Options, and connect.

What the extension does:
- Bridges your open tabs and logins to a local MCP server (Streamable HTTP).
- Gives agents an agent-friendly map of every page (accessibility frame driver
  with stable refs) instead of raw HTML dumps, plus safe, validated actions
  (click, type, select) and native-dialog handling.
- Adds Odoo-specific superpowers: Odoo session detection per tab and direct
  ORM tools (search_read, write, create, execute_kw, financial reports…) that
  ride your existing login session — no credentials stored, no API keys.

Your data never leaves your machine: the agent talks only to your own server,
which talks to your browser.
```

## Listing metadata (fixed fields)

- **License (custom):** the text in `~/tmp/amo-listed-metadata.json`
  (GPL-3.0-or-later notice, `{lang-code}` dict with `name` + `text`).
- **Category:** Other.
- **Support URL:** https://github.com/ofapsaas/vulpo/issues
- **Homepage:** https://github.com/ofapsaas/vulpo
