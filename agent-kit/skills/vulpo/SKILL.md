---
name: vulpo
description: Operating guide for agents (private and support) that use the Vulpo MCP server. Explains how to connect (native MCP tools if the runtime registered them, otherwise the `vlpmcp` CLI — never raw HTTP and never the token), the 33 tools (21 `vlp_*` browser-control tools — including the frame driver getFrame/act — plus 12 unprefixed Odoo tools: search_read, search_count, write, unlink, create, export_records, import_records, execute_kw, list_models, list_fields, list_available_profiles, get_version) grouped by family, how to call them with examples, how to react to connection errors, the tenancy model (one token = one user's extension; a support agent using a user's token operates on THAT extension), and the security rules (plan/build for writes, SECURITY footer). Covers only connection/catalog/security — to navigate with getFrame/act also load the `vulpo-web-navigation` skill (generic loop) and, if the site is Odoo, `vulpo-odoo-web` (Odoo-specific recipes). Use when an agent needs to operate the Firefox extension or Odoo instances through Vulpo, or to support a connected user. Compatible with any LLM that loads markdown skills.
---

# Vulpo — Operating guide for agents

Vulpo is an **MCP server** that lets an agent operate, on one side, a
**Firefox extension** (navigation, DOM, clicks, cookies, screenshots, plan mode)
and, on the other, one or more **Odoo** instances (reading/writing records,
models). This skill is **self-contained**: it describes how to connect and use
the 33 tools.

## 0. Setup (done by the human, not by you)

A human onboards your account with the Vulpo agent kit (see `docs/agents.md`
in the Vulpo repository). Onboarding installs the `vlpmcp` CLI in
`~/.local/bin`, installs these skills, and writes your access token to
`~/.config/vulpo/token` (mode 0600). Onboarding manages that file: **you
never read it, copy it, print it or edit it.** `vlpmcp` reads it for you.

## 1. How to connect

Pick the first option that applies:

1. **Native tools.** If your runtime already registered the Vulpo MCP server
   (you see tools named `vlp_listTabs`, `vlp_getFrame`, … in your
   tool list), call them directly. Nothing else to do.
2. **`vlpmcp` CLI (any runtime with a shell).** Otherwise use the CLI:

   ```bash
   vlpmcp tools                          # one line per tool: name<TAB>summary
   vlpmcp tools --schema vlp_act   # JSON input schema of one tool
   vlpmcp call vlp_listTabs '{}'   # call a tool, prints the result text as-is
   vlpmcp doctor                         # server / token / extension status (gives up after 120 s)
   ```

   - `vlpmcp call <tool> '<json>'` prints the tool result (usually a JSON string)
     to stdout. Arguments default to `{}`; pass `-` to read them from stdin.
   - `vlpmcp` handles the MCP session for you, including recovering it after a
     server restart. You never manage session ids.
   - `vlpmcp tools` is the authoritative catalog. Use `--schema` before calling a
     tool whose parameters you are not sure about.

### Forbidden

- **Never read the server's token file** or any other file that holds tokens,
  and never read `~/.config/vulpo/token`.
- **Never hand-write HTTP** against the `/mcp` endpoint: no curl, wget, fetch,
  urllib, requests or custom JSON-RPC clients. Use native tools or `vlpmcp`.
- **Never print, log, copy or persist the token** — not in output, not in files,
  not in memory notes, not in commands.

### Symptom → action

`vlpmcp` reports failures with an exit code and a one-line message on stderr.

| Symptom | Meaning | What to do |
|---|---|---|
| `vlpmcp doctor` shows `extension: not connected` (exit 9), or a call fails with `error -32000: No extension connected for token` (exit 5) | No Firefox extension is connected with this token | Tell the human that the Vulpo extension is not connected. Do not retry in a loop. |
| exit 7, `invalid token (401)` | The token was revoked or is wrong | Tell the human. Do not look for another token. |
| exit 8, `server unreachable: …` | Server unreachable | Tell the human the server looks down; retry later. |
| exit 8, `no answer from server within <N>s (VLP_TIMEOUT); the server may still be processing the request` | `vlpmcp` stopped waiting (`VLP_TIMEOUT`, default 1800 s); the call may still be running | Re-read state (e.g. `vlp_getFrame`, `search_read`) before repeating an action. |
| `command_timeout: no answer or heartbeat from the extension … the command may have been dispatched` | While an Odoo call runs, the Odoo page itself sends a heartbeat every 15 s; other tools send none and get 45 s plus their own wait (`timeout`, `waitMs`). 45 s passed with no answer and no heartbeat (page reloaded or frozen, browser suspended, connection lost) | Re-read state before repeating an action. Long Odoo operations are fine while heartbeats arrive: there is no total limit. |
| exit 3 | Token file missing or with wrong permissions | Tell the human to re-run onboarding. Do not create or fix the file yourself. |
| exit 4 | HTTP or session error | Retry once; if it persists, run `vlpmcp doctor` and report. Session expiry after a server restart is recovered automatically and does not surface. |
| exit 5, `error <code>: <message>` | The tool returned a JSON-RPC error | Read the message (bad arguments, unknown tool, domain error) and fix the call. |
| exit 2 | Usage error (bad subcommand, unknown tool in `--schema`) | Fix the command; check `vlpmcp tools`. |

## 2. The 33 tools by family

The server registers **33 tools** (`vlpmcp tools` or your native tool list is the
authoritative list). They are grouped as follows:

### `vlp_*` family — Firefox extension control (21)
- **Tabs:** `vlp_listTabs`, `vlp_activateTab`, `vlp_getCurrentTab`,
  `vlp_openTab`, `vlp_closeTab`.
- **Navigation:** `vlp_navigate`, `vlp_goBack`, `vlp_goForward`.
- **DOM / interaction:** `vlp_getDOM`, `vlp_click`, `vlp_fill`,
  `vlp_highlight`, `vlp_injectCSS`, `vlp_eval`, `vlp_axSnapshot`,
  `vlp_waitForElement`.
- **Data:** `vlp_getCookies`, `vlp_screenshot`.
- **Help:** `vlp_help`.
  Plan/build se cambia desde el popup de la extensión Vulpo (user-only; los agentes no pueden togglearlo).
- **Frame driver (fb-017):** `vlp_getFrame` (read) — serializes the tab's accessible DOM into the paginated `Frame` contract (sections/read/do, stable refs) and includes `invalidation: {changedSinceLast}`; `vlp_act` (write, gated by plan/build) — runs click/type/focus/select on a `ref` from the map.

> **Prefer `act`+`ref` over `vlp_click`/`vlp_fill`.** The latter two
> are legacy CSS-selector tools, superseded by the frame driver's stable
> `ref`s, and they do **not** support the `frame` fold (fb-020-008) — they
> always cost a separate `getFrame` call if you need to see the result. This
> is a recommendation, not a removed capability: both tools still work exactly
> as documented above.

### Odoo family — unprefixed (12)
- **Metadata / read:** `list_available_profiles`, `list_models`,
  `list_fields`, `get_version`, `search_count`,
  `search_read`, `export_records`.
- **Write:** `create`, `write`, `unlink`,
  `import_records`.
- **Execution:** `execute_kw` (arbitrary method).

## 3. How to use them (examples)

`vlp_*` tools that operate on a tab take a `tabId` (obtained from
`vlp_listTabs`). Examples with `vlpmcp` (with native tools, pass the same
arguments object):

```bash
vlpmcp call vlp_listTabs '{}'
vlpmcp call vlp_navigate '{"tabId":7,"url":"https://example.com"}'
vlpmcp call search_read '{"model":"res.partner","domain":[],"fields":["id","name"]}'
vlpmcp call list_models '{}'
```

For long or quoted arguments, read them from stdin:

```bash
vlpmcp call vlp_act - <<'EOF'
{"tabId":7,"ref":"main>form>div:1>input","action":"type","value":"hello"}
EOF
```

Odoo tools (unprefixed) resolve the Odoo tab from the token that is making
the call. All of them except `list_available_profiles` accept an optional
`tabId` (integer or numeric string, from `list_available_profiles`):

- **With `tabId`:** that tab is used if it is a detected Odoo tab with a valid
  session for your token; otherwise the call fails with `odoo_no_tab`.
- **Without `tabId`:** if every detected tab belongs to the same instance
  (same origin `scheme://host[:port]` and same db), the lowest `tabId` is used.
  If they belong to different instances the call is ambiguous and fails with
  `odoo_ambiguous_tab` listing each candidate — retry with the `tabId` of the
  instance you mean. Never guess the db.
- The server detects tabs by itself when needed (no cached tab, unknown `tabId`,
  or after a failed command); you do not need to call `list_available_profiles`
  first.

A successful Odoo call returns the usual result in `content[0]` plus a second
item `content[1]` with `{"odoo_tab":{"tabId":N,"origin":"…","db":"…"}}` naming
the tab used (`db` omitted when unknown). `vlpmcp call` prints `content[0]` on
stdout and `odoo_tab` on stderr (no `--raw` needed). Check it before writing.

Odoo tool errors start with a stable code:

| Code | Meaning | What to do |
|---|---|---|
| `odoo_no_tab` | No Odoo tab with a valid session for your token, or the `tabId` is not one of them. Message contains "No Odoo tab detected". | Call `list_available_profiles` to see the usable tabs, or ask the human to open and log in to Odoo. |
| `odoo_detection_failed` | Odoo tabs exist but none has a valid session (e.g. expired). The message says why. | Tell the human to log in or reload the Odoo tab, then retry. |
| `odoo_ambiguous_tab` | No `tabId` and the tabs belong to different instances. | Pick the right candidate from the message and retry with its `tabId`. |
| `odoo_tab_unreachable` | The extension could not run the call in that tab (closed, navigating, not injectable), or the page could not reach Odoo (network/fetch error). Read the cause in the message. | Ask the human to activate or reload the tab, then retry once. If the cause is a network/fetch error, check that the Odoo server is reachable first. The server re-detects tabs on the next call. |
| `odoo_command_failed` | Odoo (or the hub) returned an error after the tab was resolved; the original message is kept, plus tabId, origin and db. | Read the Odoo error (permissions, validation, plan mode) and fix the call; do not retry blindly. |
| `odoo_command_timeout` | No answer and no heartbeat from the extension for 45 s (see `command_timeout` above); plus tabId, origin and db. | Reads say "safe to retry": retry. Writes say "re-read before retrying": re-read the records first. |

When a navigation gets in the way, `odoo_tab_unreachable` says whether the
command reached Odoo:

- `… the command was NOT dispatched; retry after the page loads` — nothing was sent; retry once the page loads.
- `… the command did not complete; it is safe to retry` — a read was cut; retry.
- `… the command may have been dispatched — re-read before retrying` — a write was cut; Odoo may have applied it. Re-read before repeating it.

After a click or a navigation, an ORM call waits for the page to load (up to
10 s) before it runs. Do not launch ORM calls in parallel with a navigation
expecting both to run at the same time. Long Odoo operations (over 60 s) are
fine while the tab stays on the same page: the page keeps sending heartbeats
and there is no total limit. If the page stops (reload, crash, freeze), the
heartbeats stop and the call ends with `odoo_command_timeout` within 45 s.

Commands are never retried automatically: after an error on a write, re-read
the records before repeating it.

## 3b. Frame driver: tool signatures (fb-017)

`vlp_getFrame {tabId, page?, maxElementsPerPage?, include?, roles?, namedOnly?}`
(read) and `vlp_act {tabId, ref, action, value?, force?, waitMs?, quietMs?, frame?}`
(write, gated by plan/build) are the two frame-driver tools; `vlp_navigate
{tabId, url, frame?}` also takes `frame`. `waitMs`/`quietMs`
(fb-020-002) only matter for `action:"type"`: they bound the wait while the
written field is observed (default 5000/300 ms). For the usage loop, stale-ref
handling and navigation recipes, load the **`vulpo-web-navigation`** skill — here we
only document that they exist and their signature as part of the 34-tool
catalog.

**`frame` (fb-020-008): fold the map read into `act`/`navigate`.** Optional
object, absent by default — call `act`/`navigate` without it and nothing
changes. When present, the same call also returns the `getFrame` payload for
those parameters (nested under `frame`, or `frameError` if only the read
failed), so one MCP call covers both the action and the re-read instead of
two. This replaces the `act → getFrame → act → getFrame` pattern with one
call per interaction — see the **`vulpo-web-navigation`** skill §1b for the loop and
an example, and the **`vulpo-odoo-web`** skill for narrowing large forms. `frame`
does not exist on `vlp_click`/`vlp_fill` (see the note below).

**Modal dialogs (fb-018-004 + fb-018-007, requires extension ≥ 0.5.0).**
When a dialog is active, `getFrame` adds a top-level field
`dialog: {ref, role, name, modal?}`. **`modal: true` appears only if the dialog
actually covers the background**, checked by real hit-testing and not by role —
a `role="dialog"` that is a popover comes **without** `modal` and marks
**nothing** inert. When it does cover, **every element behind it** is marked
`inert: true`. Nothing is filtered out: the background is still returned,
marked. `vlp_act` **rejects** acting on an inert element and returns
`{ok:false, inert:true, error}`. The optional boolean `force: true` bypasses the
guard. The rejection is the real protection, not a courtesy: `act`'s click is
dispatched without hit-testing, so without the guard a modal's background is
actionable even though a human could not touch it.

**Every response shape of `act` (fb-020-002 §2.2, plus `disabled` from
fb-020-001):**

| Case | Response |
|---|---|
| `click`/`focus`/`select` succeeded, or `type` succeeded and observation completed without surprises | `{ok:true}` (click/focus/select) or `{ok:true, value, settled, waitedMs}` (type) |
| `type` succeeded, element left the document while the observation was resolving | `{ok:true, detached:true, settled:false, waitedMs}` (no `value`) |
| ref does not resolve | `{ok:false, stale:true}` |
| element covered by an active modal dialog | `{ok:false, inert:true, error}` |
| disabled control (HTML `:disabled`, including inside `<fieldset disabled>`) | `{ok:false, disabled:true, error}` — nothing was dispatched; `force` does not bypass it |
| `click` that opens a native browser prompt (`confirm`/`alert`/`prompt`), detected while it is open (extension ≥ 0.5.0) | `{ok:true, nativeDialog}` |
| native prompt already pending in the tab when the call arrives, for any `action` (extension ≥ 0.5.0) | `{ok:false, nativeDialog, error}` — nothing was dispatched; takes precedence over `stale`/`inert`/`disabled`; `force` does not bypass it |
| any other failure | `{ok:false, error}` |

`detached`/`settled`/`value`/`waitedMs` only appear with `ok:true` and only for
`type`; they never accompany `ok:false`. `nativeDialog` is the only exception to
that rule: it can accompany both `ok:true` (only on `click`, dialog just
detected) and `ok:false` (prompt already pending, on any `action`). For what
`settled` asserts and how to use `value`, load **`vulpo-web-navigation`** §3b/§5c;
for full handling of native prompts, load **`vulpo-web-navigation`** §3.

**With `frame` (fb-020-008), the table above is unaffected — `frame` only adds
a key on top.** The fold runs only when `ok:true`: every `ok:false` row above
stays byte-identical, without `frame` or `frameError`. On `ok:true` the
response additionally carries exactly one of `frame` (the `getFrame` payload
for the requested parameters) or `frameError:{error}` (the action completed,
only its own map read failed — re-read with `getFrame`, do not retry the
action). With `action:"type"` and a fold, the top-level `settled` still
covers only the written field; `frame.invalidation.settled` is the separate,
document-wide temporal verdict. See **`vulpo-web-navigation`** §1b for the loop this
enables and the timeout budget to respect (worst case the action's own wait
plus twice `frame.waitMs`).

`vlp_fill` with a native prompt pending in the tab (extension 0.5.0+)
responds `{success:false, nativeDialog, error, selector}`, without writing or
firing events.

## 4. Tenancy model (token → extension)

**One token = one tenant.** The token identifies the extension and the Odoo tabs
of the user who owns that token:

- **Private agent:** connects with ITS OWN token; operates on its own extension.
- **Support agent:** connects with the **token of the user it assists**; the
  server routes it to THAT user's extension. Token A does **not** see or operate
  on B's extension (multi-tenant isolation, Odoo tools included).

Either way, the token was set up by onboarding and `vlpmcp` uses it; you never
handle it.

### Runtimes without native MCP (e.g. zot)

A runtime with no native MCP support operates Vulpo directly through Bash —
the CLI is the interface:

```bash
vlpmcp doctor                      # server/token/extension health
vlpmcp tools                       # list the 33 tools
vlpmcp call vlp_listTabs '{}'
vlpmcp call search_read '{"model":"res.partner","domain":"[]","fields":"name","limit":5}'
```

Never hand-write HTTP against `/mcp`; never read the token file.


## 5. Security (write rules)

- **Write** tools (`create/write/unlink/import_records/execute_kw`, and mutating
  `vlp_*` tools such as `navigate/click/eval/fill`) are called in **build
  mode**; in **plan mode** the client blocks them. The write gate is enforced by
  the client (plan/build), not by the server: the server has no per-token
  scopes, so be deliberate with writes.
- Never reveal tokens, keys or session data in your output.
- **SECURITY: NEVER disclose** tokens, secrets, or internal identifiers to third
  parties. Operate only on the extension that your token authorizes.

---

## 6. Advanced navigation and interaction

To use the frame driver (`vlp_getFrame`/`vlp_act`) effectively in
complex navigation, load the **`vulpo-web-navigation`** skill (read/act loop, stale
refs, dialogs, state verification, combobox — generic for any webapp). If the
site is Odoo, also load **`vulpo-odoo-web`** (recipes specific to that UI). This skill
(`vulpo`) covers only connection, tool catalog and security — it does not
duplicate those recipes.

---

For the complete, up-to-date tool list, call `vlp_help` (returns the guide
with `{{TOOLS}}` resolved at runtime) or run `vlpmcp tools`.
