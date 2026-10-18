import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBridge } from "./bridge.mjs";
import {
  configuredWorkspaces,
  isAllowedWorkspace,
  isTrustedHost,
  isValidThreadId,
  loadAccessToken,
  parseBearer,
  tokenMatches,
} from "./security.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/mobile.css", ["mobile.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function respond(res, status, payload) {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function parseJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      const error = new Error("Request body too large");
      error.httpStatus = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Invalid JSON body");
    error.httpStatus = 400;
    throw error;
  }
}

export function createServer({
  bridge,
  accessToken,
  workspaces,
  trustedHosts = [],
  staticRoot = path.join(ROOT, "public"),
} = {}) {
  if (!bridge || !accessToken || !workspaces?.length) throw new Error("Missing server configuration");
  const clients = new Set();
  const failedLogins = new Map();

  function broadcast(kind, value) {
    const payload = `event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of clients) {
      if (!client.writableEnded) client.write(payload);
    }
  }

  bridge.on("notification", (value) => broadcast("notification", value));
  bridge.on("approval", (value) => broadcast("approval", value));
  bridge.on("approvalResolved", (value) => broadcast("approvalResolved", value));
  bridge.on("status", (value) => broadcast("status", value));

  async function assertAuthorizedThread(threadId) {
    if (!isValidThreadId(threadId)) {
      const error = new Error("Invalid thread ID");
      error.httpStatus = 400;
      throw error;
    }
    const result = await bridge.request("thread/read", { threadId, includeTurns: false });
    if (!isAllowedWorkspace(result?.thread?.cwd, workspaces)) {
      const error = new Error("Thread is outside configured workspaces");
      error.httpStatus = 403;
      throw error;
    }
    return result.thread;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isTrustedHost(req.headers.host, trustedHosts)) return respond(res, 421, { error: "Untrusted Host header" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && STATIC_FILES.has(pathname)) {
        const [file, type] = STATIC_FILES.get(pathname);
        const contents = await readFile(path.join(staticRoot, file));
        res.writeHead(200, { ...BASE_HEADERS, "Content-Type": type });
        return res.end(contents);
      }
      if (req.method === "GET" && pathname === "/api/health") {
        return respond(res, 200, { ok: true, codexReady: bridge.ready });
      }
      if (!pathname.startsWith("/api/")) return respond(res, 404, { error: "Not found" });

      const address = req.socket.remoteAddress ?? "unknown";
      const failures = failedLogins.get(address);
      if (failures && failures.until > Date.now() && failures.count >= 20) {
        return respond(res, 429, { error: "Too many invalid authentication attempts" });
      }
      const token = parseBearer(req.headers.authorization);
      if (!tokenMatches(token, accessToken)) {
        const current = failures?.until > Date.now() ? failures : { count: 0, until: Date.now() + 15 * 60_000 };
        current.count += 1;
        failedLogins.set(address, current);
        return respond(res, 401, { error: "Invalid access token" });
      }
      failedLogins.delete(address);

      if (req.method === "POST") {
        const origin = req.headers.origin;
        const fetchSite = req.headers["sec-fetch-site"];
        if (fetchSite === "cross-site" || (origin && new URL(origin).host !== req.headers.host)) {
          return respond(res, 403, { error: "Cross-origin request denied" });
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return respond(res, 415, { error: "JSON content type required" });
        }
      }
      if (req.method === "GET" && pathname === "/api/session") {
        return respond(res, 200, { authenticated: true, codexReady: bridge.ready });
      }
      if (req.method === "GET" && pathname === "/api/workspaces") {
        return respond(res, 200, { workspaces: workspaces.map(({ id, name }) => ({ id, name })) });
      }
      if (req.method === "GET" && pathname === "/api/approvals") {
        return respond(res, 200, { approvals: bridge.pendingApprovals() });
      }
      if (req.method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          ...BASE_HEADERS,
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        clients.add(res);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(": heartbeat\n\n");
        }, 25000);
        req.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }
      if (!bridge.ready) return respond(res, 503, { error: "Codex app-server is not ready. Check local Codex sign-in and startup." });

      if (req.method === "GET" && pathname === "/api/threads") {
        const result = await bridge.request("thread/list", { limit: 50 });
        const items = (result?.data ?? result?.threads ?? []).filter((thread) => isAllowedWorkspace(thread.cwd, workspaces));
        return respond(res, 200, { threads: items, nextCursor: result?.nextCursor ?? null });
      }
      if (req.method === "POST" && pathname === "/api/threads") {
        const body = await parseJson(req);
        const workspace = workspaces.find((item) => item.id === body.workspaceId);
        if (!workspace) return respond(res, 400, { error: "Select an allowed workspace" });
        const result = await bridge.request("thread/start", {
          cwd: workspace.path,
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        });
        if (result?.thread?.id) bridge.loadedThreads.add(result.thread.id);
        return respond(res, 201, result);
      }

      const threadMatch = /^\/api\/threads\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && threadMatch) {
        const threadId = threadMatch[1];
        const thread = await assertAuthorizedThread(threadId);
        let turns = [];
        let historyUnavailable = false;
        try {
          const page = await bridge.request("thread/turns/list", {
            threadId, limit: 12, sortDirection: "desc", itemsView: "summary",
          });
          turns = (page?.data ?? []).reverse();
        } catch {
          historyUnavailable = true;
        }
        return respond(res, 200, {
          thread: { ...thread, turns },
          activeTurnId: bridge.activeTurns.get(threadId) ?? null,
          historyUnavailable,
        });
      }
      const messageMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(pathname);
      if (req.method === "POST" && messageMatch) {
        const threadId = messageMatch[1];
        await assertAuthorizedThread(threadId);
        const body = await parseJson(req);
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 12000) {
          return respond(res, 400, { error: "Message must contain 1–12,000 characters" });
        }
        await bridge.resumeThread(threadId);
        const result = await bridge.request("turn/start", {
          threadId,
          input: [{ type: "text", text: body.text.trim() }],
          approvalPolicy: "on-request",
        });
        if (result?.turn?.id) bridge.activeTurns.set(threadId, result.turn.id);
        return respond(res, 202, result);
      }
      const stopMatch = /^\/api\/threads\/([^/]+)\/interrupt$/.exec(pathname);
      if (req.method === "POST" && stopMatch) {
        const threadId = stopMatch[1];
        await assertAuthorizedThread(threadId);
        const turnId = bridge.activeTurns.get(threadId);
        if (!turnId) return respond(res, 409, { error: "No active turn to interrupt" });
        await bridge.request("turn/interrupt", { threadId, turnId });
        return respond(res, 200, { interrupted: true });
      }
      const approvalMatch = /^\/api\/approvals\/([a-f0-9-]+)$/.exec(pathname);
      if (req.method === "POST" && approvalMatch) {
        const body = await parseJson(req);
        const approval = bridge.pendingApprovals().find((item) => item.id === approvalMatch[1]);
        if (!approval) return respond(res, 404, { error: "Approval no longer available" });
        await assertAuthorizedThread(approval.threadId);
        bridge.resolveApproval(approvalMatch[1], body.decision);
        return respond(res, 200, { resolved: true });
      }
      return respond(res, 404, { error: "Unknown API route" });
    } catch (error) {
      const status = Number.isInteger(error.httpStatus) ? error.httpStatus : 500;
      // Do not expose internal errors or sensitive filesystem paths in HTTP responses.
      return respond(res, status, { error: status === 500 ? "Codex request failed. Check the local server." : error.message });
    }
  });
  server.on("close", () => {
    for (const client of clients) client.end();
    clients.clear();
  });
  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 4765);
  const host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Non-loopback binding is disabled. Use a private HTTPS reverse proxy to 127.0.0.1 instead.");
  }
  const workspaces = configuredWorkspaces(ROOT);
  const accessToken = loadAccessToken(ROOT);
  const trustedHosts = (process.env.TRUSTED_HOSTS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const bridge = new CodexBridge();
  const server = createServer({ bridge, accessToken, workspaces, trustedHosts });
  server.listen(port, host, () => {
    console.log(`Codex Remote Web: http://${host}:${port}`);
    console.log("Access token: .local/access-token (never commit or share it)");
    console.log("Allowed workspaces: " + workspaces.map((item) => item.name).join(", "));
  });
  try {
    await bridge.start();
    console.log("Codex app-server connected");
  } catch {
    console.error("Codex app-server failed to initialize. Verify npm dependencies and Codex CLI sign-in.");
    bridge.close();
  }
  const shutdown = () => { bridge.close(); server.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Unable to start Codex Remote Web"); process.exitCode = 1; });
}
