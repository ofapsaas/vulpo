# Getting started

This guide takes you from a fresh checkout to an agent calling Vulpo tools:

1. build and run the server;
2. install the Firefox extension and connect it with a token;
3. onboard a first agent with the agent kit.

Requirements: Go 1.24+, Node 22+, Firefox 141+, Linux with systemd (user units)
for the service setup.

## 1. Server

### Build

```bash
./scripts/build-server.sh            # → server/bin/vlpsrv (static, CGO off)
./server/bin/vlpsrv --check
```

### Configure

Environment variables (all have sensible defaults):

| Variable | Default | Description |
|---|---|---|
| `VLP_PORT` | `8765` | Server port (WebSocket + MCP). |
| `VLP_BIND_ADDR` | `127.0.0.1` | Listener bind address (`0.0.0.0` for VPN/LAN). |
| `VLP_TOKENS_FILE` | `~/.vulpo/tokens.txt` | Authorized tokens. |

**Tokens file.** One token per line; comments with `#`:

```text
<token-1>
<token-2>
```

See `tokens.txt.example`. Keep the file at mode 0600. Without valid tokens, or
with a malformed line, the server fails loudly (exit 1).

Generate a token with enough randomness, for example:

```bash
openssl rand -hex 32
```

The server reads the tokens file **only at startup**: adding a token requires a
restart (see [Security](security.md)).

### Run as a systemd user service

Minimal unit:

```ini
[Service]
WorkingDirectory=<repo>
ExecStart=<repo>/server/bin/vlpsrv
Environment=VLP_TOKENS_FILE=%h/.vulpo/tokens.txt
Restart=on-failure
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now vlpsrv.service
journalctl --user -u vlpsrv.service | grep READY
# → SYSTEM VLP_READY {bind:127.0.0.1 port:8765 profiles:N}
```

## 2. Firefox extension

```bash
./scripts/build-xpi.sh               # → dist/vulpo-<version>.xpi
```

- **Production:** install the signed XPI, or on Nightly/Developer Edition with
  `xpinstall.signatures.required=false`.
- **Development:** `npx web-ext run --source-dir extension` (temporary add-on).
- In the extension **Options**, set the token. The extension connects to
  `ws://127.0.0.1:8765/extension` with it.

The token you put in the extension defines the **tenant**: every agent that uses
the same token operates this browser. Only one browser can be connected per
token; a second one with the same token displaces the first.

## 3. First agent

Agents do not talk HTTP to the server and never see the token. They use the
`vlpmcp` CLI (or native MCP tools registered through it), installed by the agent
kit.

### Build the kit

```bash
./scripts/build-agent-kit.sh                 # → dist/vulpo-agent-kit-<version>.tar.gz
./scripts/build-agent-kit.sh --check         # list the tarball contents
```

The tarball contains `bin/vlpmcp` (static linux/amd64), `skills/`,
`integrations/`, `install.sh`, `VERSION` and a README.

### Onboard an agent account

Run as the operator (the account that owns the server and its tokens file),
targeting the local account the agent runs under:

```bash
scripts/onboard-agent.sh <account> --token-mode tenant --token-file <file-with-the-token> \
  --kit dist/vulpo-agent-kit-<version>.tar.gz
```

This installs `vlpmcp` in the account's `~/.local/bin`, installs the skills,
writes the token to `~/.config/vulpo/token` (mode 0600, owned by the
account) and runs `vlpmcp doctor` as that account. See [Agents](agents.md) for
the two token modes and runtime registration.

### Check it works

As the agent account:

```bash
vlpmcp doctor
# server: ok
# token: ok
# extension: connected

vlpmcp tools
vlpmcp call vlp_listTabs '{}'
```

If `doctor` reports a problem, see [Troubleshooting](troubleshooting.md).

### Using the tools

Agents should load the `vulpo` skill first (connection, catalog, security),
then `vulpo-web-navigation` for the frame driver loop and `vulpo-odoo-web` on Odoo sites.
The frame driver in short:

```bash
vlpmcp call vlp_getFrame '{"tabId":7}'
vlpmcp call vlp_act '{"tabId":7,"ref":"main>form>div:1>input","action":"type","value":"hello"}'
```

`getFrame` returns the paginated accessible map: `sections[]` (elements with
`ref`, role, name), `read[]` (visible text) and `invalidation.changedSinceLast`
(reuse the cached map when `false`). `act` answers `{ok:true}`,
`{ok:false, stale:true}` (old ref → read again) or `{ok:false, error}`.
`getFrame` is read-only; `act` is gated by plan/build. `vlp_help` returns
the full tool guide.
