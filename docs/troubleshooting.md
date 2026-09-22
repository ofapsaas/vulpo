# Troubleshooting

Start with `vlpmcp doctor`, run as the agent account. It checks the three links in
the chain — server, token, extension — and exits with the code of the first
failure.

## `vlpmcp doctor` output

```text
server: ok|unreachable
token: ok|invalid|missing|invalid file
extension: connected|not connected
kit: outdated (installed <r1>, server expects <r2>); update: ...   (warning, only when it applies)
```

| Line | Meaning | Fix |
|---|---|---|
| `server: ok` | The server answered an MCP `initialize`. | — |
| `server: unreachable` (exit 8) | Nothing answers at `VLP_URL` (default `http://127.0.0.1:8765/mcp`), or it timed out. | Check the service: `systemctl --user status vlpsrv.service`. Check `VLP_PORT`/`VLP_BIND_ADDR` on the server and `VLP_URL` on the client. |
| `token: ok` | The server accepted the token. | — |
| `token: missing` (exit 3) | No token file at `VLP_TOKEN_FILE` (default `~/.config/vulpo/token`), or its mode is not 0600. | Re-run onboarding for the account. If the file exists, `chmod 600` it. |
| `token: invalid file` (exit 3) | The token file exists but its content is not a valid token: empty, more than one line, or characters outside printable ASCII (spaces, control bytes, non-ASCII). No request carries it. | Leave a single line with just the token in the file (a trailing newline is fine), keep mode 0600, and re-run `vlpmcp doctor`. If you do not have the token, re-run onboarding. |
| `token: invalid` (exit 7) | The server rejected the token (HTTP 401). | The token is not in the server's tokens file, or it was added without restarting the server. Restart the server if the token is new; otherwise re-onboard with a valid token. |
| `extension: connected` | A Firefox extension is connected with this token. | — |
| `extension: not connected` (exit 9) | The token is valid but no browser uses it. Every browser tool fails. | Open Firefox with the Vulpo extension and set this token in its Options. With `own` token mode this is expected until that account's browser is set up (see [Agents](agents.md)). |
| `kit: outdated (installed <r1>, server expects <r2>)` (warning, exit unchanged) | The installed agent kit (vlpmcp and skills) was built from a different agent-kit revision than the one the server expects. | Extract the current agent kit tarball and run its `install.sh` for the account; `doctor` stops printing the line when both revisions match. |

`doctor` exits 0 only when the server, token and extension lines are ok; the
`kit:` warning never changes the exit code. `doctor` gives up after
`VLP_TIMEOUT` or 120 s, whichever is shorter.

## Exit codes

| Code | Meaning | stderr | What to do |
|---|---|---|---|
| 0 | OK | — | — |
| 2 | Usage error: bad subcommand or arguments, or unknown tool in `tools --schema` | usage message | Fix the command; list tools with `vlpmcp tools`. |
| 3 | Token configuration | `token file not found: <path>`, `token file must be mode 0600: <path>` or `token file invalid: <path>: <empty\|multiple lines\|invalid characters>` | Re-run onboarding, or `chmod 600` the file. For `token file invalid`, leave a single line with just the token (see `token: invalid file` above). |
| 4 | HTTP or session error: 404 even after re-initializing, 400, 406 or any other non-200 status | HTTP status | Retry once. If it persists, run `vlpmcp doctor` and check the server logs. |
| 5 | JSON-RPC error returned by the server | `error <code>: <message>` | Read the message. `-32602`: unknown tool or bad arguments (check `vlpmcp tools --schema <tool>`). `-32000` with `No extension connected for token`: see `extension: not connected` above. Other `-32000`: the tool itself failed. |
| 7 | Invalid token (401) | `invalid token (401)` | See `token: invalid` above. |
| 8 | Server unreachable or timeout | `server unreachable: <network error>`, or `no answer from server within <N>s (VLP_TIMEOUT); the server may still be processing the request` | Unreachable: see `server: unreachable` above. No answer: the call may still be running on the server; re-read before repeating a write, or raise `VLP_TIMEOUT` (seconds, default 1800). |
| 9 | Extension not connected (`doctor` only) | — | See `extension: not connected` above. |

## Common situations

**Calls start failing right after a server restart.** They should not: the server
keeps sessions in memory, so after a restart every client gets a 404 on its next
call, and `vlpmcp` deletes its saved session, re-initializes once and retries.
If you still see exit 4, run `vlpmcp doctor`.

**Sessions keep getting lost with a shared token.** The server keeps at most 5
MCP sessions per token and evicts the oldest. With many clients on one tenant
token (several runtimes and onboarded agents) they evict each other; each one
recovers, but at the cost of extra `initialize` calls. Reduce the number of
clients on that token, or give an agent its own token (with its own browser).

**The extension disconnects when another browser starts.** Only one extension
can be connected per token: a second browser with the same token displaces the
first. Use one token per browser.

**A new token returns 401.** The server loads tokens only at startup. Restart it:
`systemctl --user restart vlpsrv.service` (this drops every
session; clients recover automatically).

**The server does not start after adding a token.** Every line of the tokens file
needs a label (`token label`); a line without one makes the server exit with
code 1. Restore the backup made by `onboard-agent.sh` or fix the line, then
restart.

**A tool hangs.** While an Odoo call (or the Odoo session probe) is running, the
Odoo page itself sends a heartbeat every 15 s; if the page is reloaded, crashes
or freezes, the heartbeats stop. Other tools send no heartbeat: they get the idle
budget plus their own wait (`timeout` of `vlp_waitForElement`, `waitMs` of
`vlp_getFrame`/`vlp_act`). If 45 s pass without an answer or a
heartbeat, the server fails the call with `command_timeout: ... the command may
have been dispatched` (in Odoo tools, `odoo_command_timeout:`; re-read before
retrying a write). The 45 s idle budget is set on the server with
`VLP_IDLE_BUDGET_MS` (milliseconds, default 45000). It has to outlast the
15 s heartbeat plus the worst-case delay a browser adds when it throttles timers
in a background tab, plus the 10 s an ORM call may spend waiting for an in-flight
navigation before it runs (it sends nothing during that wait): **do not set it
below 45 s**, or healthy calls on a backgrounded tab fail with
`command_timeout`. Raising it is safe. There is no total limit
while heartbeats keep arriving. `vlpmcp` gives up after
`VLP_TIMEOUT` seconds (default 1800) with exit 8. Long
operations (heavy Odoo actions, imports, `execute_kw` of processes) are allowed:
they run as long as they need while the tab stays on the same page. A
common cause is a native browser prompt (`confirm`/`alert`/`prompt`) waiting for
a human in that tab: answer it in the browser.

**A call fails because the tab navigated.** After a click or a navigation, an Odoo
ORM call waits for the page to load (up to 10 s) before it runs. Do not launch ORM
calls in parallel with a navigation expecting both to run at the same time. The
error text says whether the command reached Odoo:

| Text | Meaning | What to do |
|---|---|---|
| `odoo_tab_unreachable: tab <T> is still navigating after <N> ms; the command was NOT dispatched; retry after the page loads` | The page did not finish loading within 10 s; nothing was sent. | Wait for the page to load and retry. |
| `odoo_tab_unreachable: tab <T> navigated while the command was running; the command did not complete; it is safe to retry` | A read (or the session probe) was cut by a navigation. | Retry. |
| `odoo_tab_unreachable: tab <T> navigated while the command was running; the command may have been dispatched — re-read before retrying` | A write (`create`, `write`, `unlink`, `import_records`, `execute_kw`) was cut by a navigation; Odoo may have applied it. | Re-read the records before repeating the write. |
| `odoo_tab_unreachable: tab <T>: the command may have been dispatched — re-read before retrying` | A write ran in the page but returned no result (for example, the page was unloaded); Odoo may have applied it. | Re-read the records before repeating the write. |
| `tab <T> navigated while the command was running; retry` | `vlp_waitForElement` or `vlp_getFrame` with `settle` was cut by a navigation. | Retry on the new page. |
| `act: … (tab navigated while the action was running) — the write may or may not have been dispatched …` | `vlp_act` was cut by a navigation. | Re-read the page with `vlp_getFrame` before retrying. |

**Seeing how a call met a navigation.** The extension keeps an in-memory log of
the last 200 navigation events: tab status/URL changes, dispatches (id, kind,
tabId), outcomes (resolve, reject, orphan, not-dispatched, heartbeats received)
and page heartbeats. Open `about:debugging#/runtime/this-firefox`, click
**Inspect** on Vulpo and read the console: every entry is printed with the
prefix `[navguard]`, and `navGuardLog(<tabId>)` returns the entries of one tab
(`navGuardLog()` returns all of them). The log is lost when the extension
reloads.

**Seeing what the CLI did.** Set `VLP_LOG=<file>` to get one JSONL line per
request with `{ts, method, tool, ms, exit}`. It never contains arguments, results
or the token.
