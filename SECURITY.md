# Security policy

Codex Remote Web can instruct an AI coding agent to modify files and run tools.
Treat access to this dashboard as access to your development machine.

- The server binds to **127.0.0.1** by default and rejects non-loopback binds.
- A randomly generated access token is required for all private endpoints.
- The token is stored in `.local/access-token` (gitignored), never in source control.
- Use a trusted **HTTPS private network** solution for access from other devices.
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
