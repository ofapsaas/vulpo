# Odoo.sh proxy

`vlp-odoosh-proxy` is the read-only HTTP proxy that connects `odoosh-mcp` to
an authenticated `odoo.sh` tab through Vulpo.

## What it is

`vlp-odoosh-proxy` is a long-lived, per-host proxy. It replaces the direct
egress from `odoosh-mcp` to `odoo.sh`: the MCP server sends its control-plane
requests to the proxy instead of the web app, and the proxy runs each one as a
synchronous evaluation inside an authenticated `odoo.sh` tab through Vulpo's
`vlp_eval` tool.

- It is read-only by default: the write scope is empty, so no request can
  change an Odoo record.
- It keeps the MCP session in memory only, discards the incoming Cookie and
  never emits the token.
- The token is the same canonical token used by `vlpmcp`; there is no
  dedicated proxy token.

## Requirements

- Linux with `systemd` user units (for the service setup).
- Go 1.24 or newer (to build from source).
- The token file at `~/.config/vulpo/token`, mode `0600`.
- Firefox with the Vulpo extension connected to the same token, on an
  `odoo.sh` tab whose project is in **Build** mode (not Plan).
- A running `vlpsrv` server that the proxy can reach.

## Build

Build the whole agent kit from a clean clone; it produces the static
`bin/vlp-odoosh-proxy` inside the tarball:

```bash
./scripts/build-agent-kit.sh
```

The proxy is compiled with `CGO_ENABLED=0`, `GOOS=linux` and `GOARCH=amd64`,
the same static recipe as `vlpmcp`. To build only the proxy module for
development:

```bash
cd agent-kit/odoosh-proxy
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o vlp-odoosh-proxy .
```

Run its contract suite with:

```bash
cd agent-kit/odoosh-proxy && go test ./...
```

## Install

Run the kit installer; it installs the proxy next to `vlpmcp`:

```bash
tar -xzf vulpo-agent-kit-<version>.tar.gz
./vulpo-agent-kit-<version>/install.sh
```

`install.sh` places the binary at `~/.local/bin/vlp-odoosh-proxy` with mode
`0755`. It does not install a service, and it does not print the proxy
version.

## Run as a user service

The repository ships the unit `vlp-odoosh-proxy.service`. Install it as a user
unit:

```bash
mkdir -p ~/.config/systemd/user
cp vlp-odoosh-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vlp-odoosh-proxy.service
systemctl --user status vlp-odoosh-proxy.service
```

The unit uses `%h` for the home directory, so it is portable across accounts.
Read the log with `journalctl --user -u vlp-odoosh-proxy.service`.

## Point odoosh-mcp at the proxy

Register the proxy as an `odoosh-mcp` session. The `session-id` is a
placeholder: the proxy accepts any cookie value and discards it, so no file
holds the real cookie.

```bash
odoosh-mcp session add vulpo --session-id vulpo:default --base-url http://127.0.0.1:8899
odoosh-mcp session set-default vulpo
odoosh-mcp run list_projects
```

Reads are allowed by default (`write_scope=[]`). Writes stay disabled unless
an operator opts in on the `odoosh-mcp` side; the proxy itself adds no write
surface.

## Configuration

The proxy resolves its configuration from the environment once at startup:

| Variable | Default | Description |
|---|---|---|
| `VLP_PROXY_BIND` | `127.0.0.1` | Listener bind address. |
| `VLP_PROXY_PORT` | `8899` | Listener port. |
| `VLP_URL` | `http://127.0.0.1:8765/mcp` | Vulpo MCP endpoint. |
| `VLP_TOKEN_FILE` | `~/.config/vulpo/token` | Token file, mode 0600. |
| `VLP_TAB_URL_PREFIX` | `https://www.odoo.sh` | Tab URL prefix the proxy may drive. |
| `VLP_EVAL_TAB` | (empty) | Explicit tab id to evaluate in. |
| `VLP_EVAL_TIMEOUT` | `50` | Evaluation timeout, in seconds. |
| `VLP_PROXY_LOG` | (empty) | Log file. |
| `VLP_PROXY_ALLOW_NON_LOOPBACK` | (empty) | Set to `1` to allow a non-loopback bind. |

The proxy fails loud at startup if the token is unreadable or its mode is not
`0600`, or if it is asked to bind outside loopback without the opt-in.

## Health

Two endpoints report state without contacting Vulpo:

- `GET /healthz` — liveness. Answers `200` with `{"status":"ok"}` while the
  process is up; `503` with `{"status":"unavailable","error":…}` otherwise.
- `GET /readyz` — readiness. Answers `200` with `{"status":"ready"}` when the
  Vulpo session can serve the control plane; `503` with
  `{"status":"not_ready",…}` otherwise.

Without a browser or a server the proxy still starts and `/healthz` answers
`200`; `/readyz` then reports `503`.

## Troubleshooting

- **The proxy does not start.** Check that `~/.config/vulpo/token` exists and
  its mode is `0600`. The proxy exits with a clear message when the token is
  missing or the mode is wrong.
- **`/readyz` reports `503`.** The Vulpo server or the Firefox extension is not
  connected, or the `odoo.sh` tab is not loaded. Open the tab and check
  `vlpmcp doctor`.
- **A request returns `502`.** The `odoo.sh` project may be in **Plan** mode;
  the proxy needs **Build** mode to evaluate.
- **The contract suite fails.** Run `cd agent-kit/odoosh-proxy && go test ./...`
  from the repository.
