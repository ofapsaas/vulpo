# Agents

This page is for whoever gives an agent access to Vulpo: how to onboard an
agent account with the agent kit, which token mode to choose and what it
implies, and how each runtime connects.

The agent never handles the token. It uses the `vlpmcp` CLI — directly from a
shell, or through native MCP tools that the runtime starts as
`vlpmcp mcp-stdio` — and `vlpmcp` reads the token from a 0600 file that onboarding
writes.

## What gets installed

| Path (in the agent account) | Content |
|---|---|
| `~/.local/bin/vlpmcp` | The CLI (static binary). |
| `~/.local/share/vulpo-agent-kit/<version>/` | The kit: skills, integrations, `VERSION`. |
| `~/.config/opencode/skills/` | The skills `vulpo`, `vulpo-web-navigation`, `vulpo-odoo-web`, if OpenCode is present. Otherwise they stay in the kit directory and the installer prints where. |
| `~/.config/vulpo/token` | The token, mode 0600, owned by the account. Written by onboarding, never by the agent. |
| `~/.cache/vulpo/session` | The MCP session id (mode 0600), managed by `vlpmcp`. |

## Onboarding

Onboarding is done by the **operator** — the account that runs the server and
owns its tokens file — for a local agent account:

```bash
scripts/onboard-agent.sh <account> --token-mode tenant|own \
  [--token-file <file>] [--kit <tarball>] [--yes]
```

It asks for confirmation before acting unless `--yes` is given.

It uses `sudo -u <account>` only as transport; everything is installed inside
that account's home:

1. extracts the kit and runs `install.sh` as the account;
2. writes `~/.config/vulpo/token` with mode 0600, owned by the account;
3. runs `vlpmcp doctor` as the account.

It never prints the token.

The target account can also install the kit by itself (`install.sh` from the
extracted tarball); `install.sh` never writes the token and prints the next
steps. The token file then has to be provided by the operator.

## Token modes

The token decides **whose browser the agent operates**. Choose deliberately.

### `tenant` — share an existing tenant's token

```bash
scripts/onboard-agent.sh <account> --token-mode tenant --token-file <file>
```

The token is read from `--token-file` (for example, a file holding the token your
own extension uses).

- **Works immediately:** no server restart; the extension of that tenant is
  already connected, so every tool works.
- **Full access to that browser:** the agent can do anything the tenant's tools
  allow, including writes (`act`, `eval`, Odoo `write`/`unlink`/`execute_kw`).
  There are no server-side scopes (see [Security](security.md)).
- **Shared session limit:** the server keeps at most **5 MCP sessions per
  token**, evicting the oldest. Every client of the tenant (your own runtimes,
  every onboarded agent) competes for those 5. Evicted clients recover
  automatically, but many clients on one token will keep evicting each other.

This is the recommended default for an agent that assists you on your own
browser.

### `own` — a new token for the account

```bash
scripts/onboard-agent.sh <account> --token-mode own
```

1. Generates 32 random bytes in hex.
2. Backs up the server's tokens file and appends the new token line.
3. Validates the resulting file layout — every non-comment, non-empty line is
   a token — and only then replaces the file atomically, keeping mode 0600.
   If the check fails, the tokens file is left untouched.
4. Prints that a **server restart is required** — and that the restart drops
   every MCP session and reconnects every extension — **without restarting**.

Implications:

- **The token sees nothing until a browser uses it.** A new token authenticates
  and lists tools, but every tool call fails with
  `No extension connected for token` until a Firefox with the Vulpo extension
  is configured with that same token. Use `own` only for an account that will
  run its own browser.
- **Restart needed.** The server loads tokens only at startup. Restart it when
  convenient:

  ```bash
  systemctl --user restart vlpsrv.service
  journalctl --user -u vlpsrv.service | grep READY   # profiles: N+1
  ```

  Clients recover their sessions automatically after the restart.

## Runtime registration

### OpenCode (native tools)

After the kit is installed, run as the agent account:

```bash
~/.local/share/vulpo-agent-kit/<version>/integrations/register-opencode.sh
opencode mcp list        # should list "vulpo"
```

It registers, in the user's OpenCode configuration, a local (stdio) MCP server
named `vulpo` whose command is `~/.local/bin/vlpmcp mcp-stdio`. It is
idempotent and does not write the token into the OpenCode configuration: the
bridge reads it from the token file at runtime. The Vulpo tools then appear
as native tools.

### Any other runtime (Claude Code, agy, …)

Native registration for other runtimes is planned for a later phase. Any runtime
that can run shell commands uses `vlpmcp` directly, guided by the `vulpo`
skill:

```bash
vlpmcp tools
vlpmcp tools --schema vlp_getFrame
vlpmcp call vlp_listTabs '{}'
```

If the runtime does not load skills from `~/.config/opencode/skills/`, point it
to the skills in the kit directory (or copy them to where it loads skills from).

## `vlpmcp` reference

| Command | What it does |
|---|---|
| `vlpmcp tools` | One line per tool: `name<TAB>first sentence of the description`. |
| `vlpmcp tools --json` | The raw `tools` array. |
| `vlpmcp tools --schema <tool>` | The tool's input schema as JSON (exit 2 if the tool does not exist). |
| `vlpmcp call [--raw] <tool> [json]` | Calls the tool; prints `result.content[0].text` as-is. `json` defaults to `{}`; `-` reads it from stdin. `--raw` (before the tool name) prints the full JSON-RPC response. |
| `vlpmcp ping` | Initializes a session and pings; prints `ok`. |
| `vlpmcp doctor` | Prints `server:`, `token:` and `extension:` status. Gives up after `VLP_TIMEOUT` or 120 s, whichever is shorter. |
| `vlpmcp mcp-stdio` | Line-delimited JSON-RPC MCP bridge on stdin/stdout, for native registration. |
| `vlpmcp version` | Prints the kit version. |

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `VLP_TOKEN_FILE` | `~/.config/vulpo/token` | Token file (must be mode 0600). The token is never accepted as a flag or argument. |
| `VLP_URL` | `http://127.0.0.1:8765/mcp` | Server endpoint. |
| `VLP_SESSION_FILE` | `~/.cache/vulpo/session` | Where the session id is kept. |
| `VLP_TIMEOUT` | `1800` | Request timeout, in seconds. A safety net: the server already ends a call whose extension stops answering (no heartbeat for 45 s), so long Odoo operations are not cut. |
| `VLP_LOG` | unset | If set, appends one JSONL line per request: `{ts, method, tool, ms, exit}` (no arguments, no results, no token). |

Server environment (set on `vlpsrv`, not on the agent account):

| Variable | Default | Meaning |
|---|---|---|
| `VLP_IDLE_BUDGET_MS` | `45000` | Idle budget, in milliseconds: the server fails a call with `command_timeout` when this long passes without an answer or a heartbeat from the extension. Independent of `VLP_TIMEOUT`. |

The idle budget has to outlast the slowest legitimate gap between two signs of
life, so it is not a free number: the Odoo page beats every 15 s, a timer in a
background tab can be throttled by the browser for several seconds beyond its
period, and an ORM call waits up to 10 s for an in-flight navigation before it
even runs (and so sends nothing during that wait). 15 s + worst-case throttling
+ 10 s is why the default is 45000; **do not set it below 45 s** — a shorter
budget fails healthy calls on a backgrounded tab. Raising it is safe.

Exit codes and what to do about them: see [Troubleshooting](troubleshooting.md).
