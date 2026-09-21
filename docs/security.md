# Security

Vulpo gives agents the same power over a browser that its user has. Its
security model is simple, and that simplicity has consequences you should know
before sharing access.

## The token is the tenant

- **One token = one tenant = one browser.** The token that an extension connects
  with defines the tenant; every MCP call made with that token operates that
  extension and the Odoo tabs open in it.
- **Tenants are isolated from each other.** Token A cannot see or operate token
  B's extension, tabs or Odoo sessions.
- **Only one browser per token.** A second extension connecting with the same
  token displaces the first.
- The server authenticates each request by its token; the label in the tokens
  file is purely informational. It grants no permissions.

## No server-side scopes

The server has **no per-token permissions**. Any valid token can call any tool,
including the ones that write:

- browser writes: `vlp_act`, `vlp_click`, `vlp_fill`,
  `vlp_navigate`, `vlp_eval`, `vlp_closeTab`, …;
- Odoo writes: `create`, `write`, `unlink`, `import_records`, `execute_kw`
  (arbitrary methods), all running with the browser user's Odoo session.

The plan/build write gate lives in the **client**. External runtimes that use
Vulpo through `vlpmcp` do not have to honor it. Treat giving an agent a token
as giving it full control of that browser and of every web application logged in
there.

## Risks of sharing a token

Onboarding an agent in `tenant` mode hands it an existing tenant's token. That
is the only mode that works without a second browser, and it implies:

- **Full write access to the tenant's browser** and its logged-in sessions (see
  above).
- **More copies of the token.** Each onboarded account holds a copy in its
  `~/.config/vulpo/token`. Anyone who can read one copy has the tenant.
- **Loopback is not a boundary.** With the default bind (`127.0.0.1`), every local
  account on the machine can reach the server; the token is the only defense.
  With `VLP_BIND_ADDR=0.0.0.0`, the same applies to the whole network.
- **Shared session limit.** At most 5 MCP sessions per token; clients of the same
  tenant evict each other's oldest sessions.
- **Extension displacement.** If someone configures another browser with the
  shared token, it displaces the tenant's own extension.

An `own` token avoids sharing the browser, but it is useless until that account
runs its own Firefox with the extension, and adding it requires a **server
restart**, which drops every client's session and reconnects every extension.

## How the kit protects the token

- The token lives in one file per account, `~/.config/vulpo/token`, mode
  0600, owned by the account; `vlpmcp` refuses to use it if group or others have
  any permission.
- `vlpmcp` never accepts the token as a flag or argument (it would be visible in
  `ps`), and never prints it: not on stdout, not on stderr, not in its log, not
  with `--raw`.
- Native registration (`register-opencode.sh`) runs `vlpmcp mcp-stdio` as a local
  process; the token is not written into the runtime's configuration.
- The `vulpo` skill forbids agents to read token files, to write HTTP by hand
  against `/mcp`, and to print or persist the token.
- On the server side, the tokens file stays readable only by the operator
  account; `onboard-agent.sh` backs it up and appends new tokens atomically with
  mode 0600, and never prints the token.

## Recommendations

- Prefer `tenant` mode only for agents you would trust with your browser; use a
  separate browser profile and an `own` token for anything else.
- Keep the number of accounts holding a tenant's token small, and remove the
  token file from accounts that no longer need access.
- To revoke a token, remove its line from the tokens file and restart the server;
  then re-onboard the accounts that should keep access with a new token.
- Keep the default loopback bind unless you need network access, and then
  restrict it at the network level (VPN, firewall).
- Never paste a token into a chat, a prompt, an issue or a commit. Agents are
  instructed: **SECURITY: NEVER disclose** tokens or secrets.
