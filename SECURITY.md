# Security policy

Codex Remote Web can instruct an AI coding agent to modify files and run tools.
Treat access to this dashboard as access to your development machine.

- The server binds to **127.0.0.1** by default and rejects non-loopback binds.
- A randomly generated access token is required for all private endpoints.
- The token is stored in `.local/access-token` (gitignored), never in source control.
- Use a trusted **HTTPS private network** solution for access from other devices.
- `scripts/start-tailnet.ps1` uses Tailscale **Serve** on port 8443 and
  explicitly refuses a Tailscale **Funnel** configuration for that endpoint.
  Restrict tailnet access using Tailscale ACLs and only enroll trusted devices.
- `scripts/start-safari.ps1` exposes **only** the separate authentication
  gateway (loopback port 4776) through Funnel HTTPS port 10000. It verifies
  that unauthenticated Codex API requests are rejected before enabling Funnel.
- The gateway uses a 96-bit one-time code, expiring after 10 minutes, that is
  stored as a hash on disk in the gitignored `.local/` folder. Failed pairing
  attempts are throttled. Every approved browser gets a random session cookie
  with Secure, HttpOnly, SameSite=Strict and a maximum age of 24 hours.
- Only fixed app assets and allowlisted Codex routes are proxied, after
  authentication. Unsafe requests require matching HTTPS Origin and a
  custom same-origin header. The browser never receives the backend token.
- Since a public authentication endpoint is still a security-sensitive
  surface, this initial implementation is **not** a security-audited remote
  access solution. Disable Funnel when not needed.
- Per-project **write** permissions require an additional 256-bit PC management
  key (stored only under gitignored `.local/project-management-key`). The
  browser sends it only when enabling access; it is not stored client-side.
  A separate 96-bit one-use grant code can be generated locally and expires
  in ten minutes; only its hash is saved under `.local/`.
  Grants expire after two hours, and their paths come only from existing
  Codex project records. Disabling persists. Permissions are checked on each
  mutable Codex operation; the server still requests command/file approvals.
- **Never** expose the HTTP port directly to the internet or put the token in a URL.
- Approvals require an explicit click and are never automatically accepted.
- This project does not expose a generic shell, file reader, or arbitrary JSON-RPC endpoint.
- Workspaces must be configured locally; unknown directories are not authorized.
- All HTML output is escaped through DOM text nodes, not inserted as HTML.

## Current limitations

This is an early personal-use MVP, **not** a security-audited multi-user service.
There is no account recovery, multi-factor authentication, or security guarantee.
The application does not automatically connect to the active Codex Desktop UI
process: it launches its own Codex app-server and may share saved conversations
only when both installations use compatible local state.

Please report vulnerabilities privately via GitHub's security reporting features.
