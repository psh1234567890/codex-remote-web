# Codex Remote Web

**Your Codex sessions, one personal dashboard.** A self-hosted, local-first web companion built on the official [Codex app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server).

[한국어 설명서 / Korean guide](README.ko.md)

> **Status: early MVP.** This is an independent community project, not an official OpenAI product. It does not magically control an already running Codex Desktop window. It starts a separate local Codex app-server process and can read compatible saved threads from the configured Codex home.

## Features

- View Codex threads and their recent messages in a responsive web dashboard.
- Browse saved Codex conversations across projects, with a **read-only** mode
  for conversations outside the explicit local workspace allowlist.
- Touch-friendly collapsible project drawer and searchable conversation list
  on tablets and phones.
- Start a thread in an **explicitly allowed local workspace**.
- Send follow-up instructions and stream live progress.
- Review individual command/file-change approval requests; **no automatic approval**.
- Interrupt an active turn.
- Token authentication, loopback-only server, strict Host checks, no CORS.
- No remote shell endpoint, cloud database, tracking, or analytics.
- Codex-inspired dark interface with project-grouped sessions, message bubbles,
  a compact activity inspector, and safe basic Markdown rendering.

### Visual design and fonts

The interface is independently implemented using the desktop Codex layout as a
visual reference. It uses a system font stack, preferring `OpenAI Sans` **only
if it is already installed**, then `Segoe UI Variable Text`, `Segoe UI`,
and platform-specific Korean fallbacks. No proprietary font files, official
logos, or copied app assets are included. Pixel-perfect visual parity is not
guaranteed.

### Private iPad / Safari access

**Browser-only Safari access from outside the home Wi-Fi:** on the PC, run
`.\scripts\start-safari.cmd`. This creates an independently authenticated,
loopback-only gateway and exposes **only the gateway** through Tailscale
**Funnel** on HTTPS port **10000**, leaving any existing 443 and 8443 services
unchanged. On the PC, generate a one-time pairing code using
`npm.cmd run remote:code`. Enter that code into the printed URL on Safari.
The code expires after 10 minutes and is consumed once. Approved browsers
receive a secure, HttpOnly, SameSite=Strict cookie valid for at most 24 hours.
Session registrations are stored in memory and vanish after gateway restart.
The upstream Codex access token is never returned to the browser.
To disable the public endpoint, run
`tailscale funnel --https=10000 off` **on the PC**.

**Security note:** A public HTTPS *login page* is exposed, not an unauthenticated
Codex API. Anyone can visit the login page, but accessing the dashboard
requires a PC-issued code. This prototype is not security audited, so do not
share codes or expose the backend HTTP service. Consider stronger identity
verification before long-term use.

#### Private-only alternative

Use **Tailscale Serve** (tailnet-only HTTPS), not Tailscale Funnel or a
publicly forwarded HTTP port. Install and sign in to Tailscale on both
Windows and iPadOS. On Windows, run:

```powershell
.\scripts\start-tailnet.cmd -Workspaces "C:\projects\my-app"
```

The `.cmd` launcher uses a process-scoped PowerShell execution-policy bypass
because some Windows installations block unsigned local scripts; it does not
modify the machine-wide execution policy.
For repeated use, save one absolute workspace path per line in the ignored
`.local/tailnet-workspaces.txt` file, then run `.\scripts\start-tailnet.cmd`
without arguments. An explicit `-Workspaces` argument takes precedence.

The script checks that Tailscale is running, refuses to use a port exposed
through Funnel, preserves existing Serve services, and configures a private
HTTPS listener on port 8443 for the loopback-only Node server. Open the
printed `https://<machine>.<tailnet>.ts.net:8443/` URL in Safari while
connected to the same tailnet. Enter the existing access token from the
Windows PC's `.local/access-token` file. Never put the token in a URL.
The PC and Node server must remain running; review Tailscale ACLs to restrict
which devices can reach the service.

## Quick start (Windows PowerShell)

Prerequisites: Node.js 22+, npm, and a Codex CLI login with an eligible account.

```powershell
git clone https://github.com/psh1234567890/codex-remote-web.git
cd codex-remote-web
npm.cmd ci
npm.cmd exec -- codex login
```

**Configure your workspaces** before starting. For example:

```powershell
$env:CODEX_WORKSPACES = "C:\\projects\\my-project"
npm.cmd start
```

Open **http://127.0.0.1:4765**. The server creates a local access token on first start. Read it in a separate terminal and paste it into the login form:

```powershell
Get-Content .local/access-token
```

The token is a **secret**. Do not commit, screenshot, share, or place it in a URL.
The `.local/` directory is gitignored.

If `CODEX_WORKSPACES` is omitted, only this project's own directory is allowed.
Use a semicolon-separated list for multiple Windows folders; on macOS/Linux,
use your platform's path separator.

### macOS / Linux

```bash
npm ci
npm exec -- codex login
CODEX_WORKSPACES=/home/me/project npm start
cat .local/access-token
```

## Remote access from another device

The HTTP server intentionally listens **only on 127.0.0.1**. To access it from
a phone or another computer, use a private, authenticated HTTPS network or
reverse proxy (for example, a correctly configured Tailscale Serve setup).
Configure `TRUSTED_HOSTS` with the exact HTTPS proxy hostname, and ensure
only your own trusted devices can reach it.

**Do not** forward port 4765 on your router, expose it with a public tunnel,
or deploy this local-agent server to Vercel or a public hosting platform.
The app does not provide multi-user isolation or MFA.

## Architecture

```text
Web browser (session-only bearer token)
           │ HTTPS private proxy / local loopback
           ▼
Node.js HTTP server (auth, Host validation, workspace allowlist)
           │ restricted HTTP routes + event stream
           ▼
Codex app-server (JSON-RPC over stdio, local subprocess)
           │
           ▼
Codex CLI state, allowed project files, local tools
```

The app-server integration uses `thread/list`, `thread/read`, `thread/start`,
`thread/resume`, `turn/start`, and `turn/interrupt`. Incoming interactive
requests are handled only for command/file-change approvals. A request expires
after two minutes and is declined by default. The server does **not** accept
arbitrary RPC methods from the browser.

## Security model and limitations

- Only the configured workspace directories (and their descendants) are visible.
- Codex runs with `workspace-write` sandbox and `on-request` approval policy
  for new threads. The active Codex runtime and OS still determine what a
  sandbox can enforce. Read every approval carefully.
- A secret bearer token protects every private endpoint, including event streams.
- Tokens are kept in browser **sessionStorage** (cleared when the tab session
  ends or you disconnect), not in URLs or source code.
- Access-token storage is created with restrictive permissions where supported.
- Failed authentication is throttled. No third-party JavaScript or fonts are loaded.
- `thread/turns/list` loads up to 12 recent turns per view, using Codex's
  **experimental** paginated-history API. Protocol changes may require updates.
- Existing Codex Desktop conversations may use a separate state directory or
  running app-server; compatibility is **not guaranteed**.
- This MVP has not been independently security-audited. Do not expose it publicly.

See [SECURITY.md](SECURITY.md) for the threat model.

## Development

```bash
npm ci
npm run check
npm test
npm start
```

The automated tests use a fake Codex bridge. They do not execute shell
commands through Codex or modify user projects.

## Roadmap

- [x] Authenticated local dashboard
- [x] Thread listing, history, new threads, messages, live events
- [x] One-time approval / denial and turn interruption
- [ ] Compatibility validation with Codex Desktop's saved thread storage
- [ ] Independent security review and stronger remote-device authentication
- [ ] Mobile-focused thread switching and approval experience
- [ ] Paginated thread history, search, and richer diffs
- [ ] One-command private-network setup (after security review)

## Contributing / License

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
MIT licensed. Not affiliated with or endorsed by OpenAI.
