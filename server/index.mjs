import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBridge } from "./bridge.mjs";
import { recordCodexError } from "./diagnostics.mjs";
import { ProjectPermissions } from "./project-permissions.mjs";
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
  ["/codex.css", ["codex.css", "text/css; charset=utf-8"]],
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

function classifyCodexFailure(error) {
  const message = String(error?.message ?? "");
  if (/\balready has an active writer\b/i.test(message)) {
    return {
      status: 409, code: "THREAD_ACTIVE_WRITER",
      error: "다른 Codex 실행 주체가 이 대화를 사용하고 있습니다. 기존 작업을 종료하지 않고, 아래 '대화 복제해서 이어가기'를 눌러 별도 대화로 이어갈 수 있습니다.",
    };
  }
  if (/no rollout found|rollout (?:not found|missing)/i.test(message)) {
    return {
      status: 409, code: "THREAD_NOT_RESTORABLE",
      error: "이 대화는 Codex 저장 기록을 복원할 수 없습니다. 기존 대화는 그대로 두고 새 채팅을 시작해 주세요.",
    };
  }
  if (/no such file or directory|ENOENT|working directory does not exist|cwd.*not found|not a directory/i.test(message)) {
    return {
      status: 409, code: "PROJECT_FOLDER_MISSING",
      error: "이 대화의 작업 폴더를 현재 PC에서 찾을 수 없습니다. 폴더를 복구하거나 존재하는 프로젝트에서 새 채팅을 시작해 주세요.",
    };
  }
  if (/already.*(?:turn|running)|turn.*in progress|another turn is active/i.test(message)) {
    return {
      status: 409, code: "THREAD_BUSY",
      error: "이 대화에서 Codex 작업이 이미 실행 중입니다. 완료될 때까지 기다리거나 작업 중지를 눌러 주세요.",
    };
  }
  if (/timed out/i.test(message)) {
    return { status: 504, code: "CODEX_TIMEOUT", error: "Codex 응답 시간이 초과됐습니다. 잠시 기다린 후 다시 시도해 주세요." };
  }
  if (/disconnected|not connected/i.test(message)) {
    return { status: 503, code: "CODEX_DISCONNECTED", error: "PC에서 Codex 연결이 끊어졌습니다. 로컬 Codex 서버를 확인해 주세요." };
  }
  return {
    status: 502, code: "CODEX_RPC_FAILED",
    error: "Codex가 이 작업 요청을 거부했습니다. 다른 대화에서도 같은 문제가 발생하면 PC의 Codex 로그인과 앱 서버 상태를 확인해 주세요.",
  };
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
  permissionManager,
  trustedHosts = [],
  staticRoot = path.join(ROOT, "public"),
} = {}) {
  if (!bridge || !accessToken || !workspaces?.length) throw new Error("Missing server configuration");
  const permissions = permissionManager ?? new ProjectPermissions({ root: ROOT, baseWorkspaces: workspaces });
  const clients = new Set();
  const failedLogins = new Map();
  const failedManagement = new Map();

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

  async function listSavedThreads() {
    const threads = [];
    const visited = new Set();
    let cursor = null;
    // The Codex list API is paginated; filtering the first page hid most projects.
    for (let page = 0; page < 10 && threads.length < 500; page++) {
      const result = await bridge.request("thread/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }, 40000);
      for (const thread of result?.data ?? result?.threads ?? []) {
        if (!isValidThreadId(thread?.id) || visited.has(thread.id)) continue;
        visited.add(thread.id);
        threads.push({
          ...thread,
          projectId: permissions.projectId(thread.cwd),
          available: permissions.isAvailable(thread.cwd),
          editable: permissions.canWrite(thread.cwd),
        });
      }
      if (!result?.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return threads;
  }

  async function listProjects() {
    const threads = await listSavedThreads();
    const projects = new Map();
    for (const workspace of workspaces) {
      const id = permissions.projectId(workspace.path);
      if (id) projects.set(id, { id, path: workspace.path, name: workspace.name, threadCount: 0 });
    }
    for (const thread of threads) {
      if (!thread.projectId) continue;
      let project = projects.get(thread.projectId);
      if (!project) {
        project = {
          id: thread.projectId,
          path: thread.cwd,
          name: path.basename(thread.cwd),
          threadCount: 0,
        };
        projects.set(thread.projectId, project);
      }
      project.threadCount++;
    }
    return [...projects.values()].map((project) => ({
      ...project,
      available: permissions.isAvailable(project.path),
      writable: permissions.canWrite(project.path),
      expiresAt: permissions.accessUntil(project.path),
    }));
  }

  async function assertKnownThread(threadId) {
    if (!isValidThreadId(threadId)) {
      const error = new Error("Invalid thread ID");
      error.httpStatus = 400;
      throw error;
    }
    const thread = (await listSavedThreads()).find((item) => item.id === threadId);
    if (!thread) {
      // A newly started empty thread can take a moment to appear in
      // thread/list. Only permit our own already-loaded thread IDs here.
      if (bridge.loadedThreads.has(threadId)) {
        const response = await bridge.request("thread/read", { threadId, includeTurns: false });
        if (response?.thread?.id === threadId) {
          return { ...response.thread, editable: permissions.canWrite(response.thread.cwd) };
        }
      }
      const error = new Error("Saved Codex thread not found");
      error.httpStatus = 404;
      throw error;
    }
    return thread;
  }

  async function assertAuthorizedThread(threadId) {
    if (!isValidThreadId(threadId)) {
      const error = new Error("Invalid thread ID");
      error.httpStatus = 400;
      throw error;
    }
    const result = await bridge.request("thread/read", { threadId, includeTurns: false });
    if (!permissions.canWrite(result?.thread?.cwd)) {
      const error = new Error("Thread is outside configured workspaces");
      error.httpStatus = 403;
      throw error;
    }
    return result.thread;
  }

  const server = http.createServer(async (req, res) => {
    let codexStage = "request";
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
        const projects = await listProjects();
        return respond(res, 200, {
          workspaces: projects.filter((project) => project.available)
            .map(({ id, name, writable }) => ({ id, name, writable })),
        });
      }
      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await listProjects();
        return respond(res, 200, {
          projects: projects.map(({ id, name, available, writable, expiresAt, threadCount }) =>
            ({ id, name, available, writable, expiresAt, threadCount })),
        });
      }
      const permissionMatch = /^\/api\/projects\/([a-f0-9]{32})\/access$/.exec(pathname);
      if (req.method === "POST" && permissionMatch) {
        const body = await parseJson(req);
        if (typeof body.enabled !== "boolean") return respond(res, 400, { error: "Invalid access setting" });
        const projects = await listProjects();
        const project = projects.find((item) => item.id === permissionMatch[1]);
        if (!project) return respond(res, 404, { error: "Project is not available in Codex" });
        const windowStart = Date.now();
        if (body.enabled) {
          const record = failedManagement.get(address);
          if (record?.until > windowStart) return respond(res, 429, { error: "Too many management key attempts" });
        }
        const result = permissions.setWriteAccess(project.path, body.enabled, body.managementKey);
        if (!result.ok) {
          if (body.enabled && result.status === 403) {
            const record = failedManagement.get(address) ?? { count: 0, until: 0 };
            record.count++;
            if (record.count >= 8) { record.until = windowStart + 15 * 60_000; record.count = 0; }
            failedManagement.set(address, record);
          }
          return respond(res, result.status, { error: result.error });
        }
        failedManagement.delete(address);
        // A revoke also attempts to stop running turns in that project.
        // Any new turns must pass the permission check again.
        if (!body.enabled && bridge.activeTurns.size) {
          const saved = await listSavedThreads();
          for (const [threadId, turnId] of bridge.activeTurns) {
            const thread = saved.find((item) => item.id === threadId);
            if (!thread || thread.projectId !== project.id) continue;
            try {
              await bridge.request("turn/interrupt", { threadId, turnId }, 5000);
              bridge.activeTurns.delete(threadId);
            } catch { /* Future turns remain read-only. */ }
          }
        }
        return respond(res, 200, result);
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
        const threads = await listSavedThreads();
        return respond(res, 200, { threads, total: threads.length });
      }
      if (req.method === "POST" && pathname === "/api/threads") {
        const body = await parseJson(req);
        const projects = await listProjects();
        const workspace = projects.find((item) => item.id === body.workspaceId);
        if (!workspace || !workspace.available) return respond(res, 400, { error: "Select an existing project folder" });
        const result = await bridge.request("thread/start", {
          cwd: workspace.path,
          approvalPolicy: workspace.writable ? "on-request" : "never",
          sandbox: workspace.writable ? "workspace-write" : "read-only",
        });
        if (result?.thread?.id) bridge.loadedThreads.add(result.thread.id);
        return respond(res, 201, result);
      }

      const threadMatch = /^\/api\/threads\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && threadMatch) {
        const threadId = threadMatch[1];
        const known = await assertKnownThread(threadId);
        const read = await bridge.request("thread/read", { threadId, includeTurns: false });
        const thread = read?.thread;
        if (thread?.cwd !== known.cwd) {
          const error = new Error("Saved Codex thread directory changed");
          error.httpStatus = 403;
          throw error;
        }
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
          thread: {
            ...thread,
            projectId: permissions.projectId(thread.cwd),
            available: permissions.isAvailable(thread.cwd),
            editable: permissions.canWrite(thread.cwd),
            turns,
          },
          activeTurnId: bridge.activeTurns.get(threadId) ?? null,
          historyUnavailable,
        });
      }
      const messageMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(pathname);
      const forkMatch = /^\/api\/threads\/([^/]+)\/fork$/.exec(pathname);
      if (req.method === "POST" && forkMatch) {
        codexStage = "thread/fork";
        const sourceId = forkMatch[1];
        const known = await assertKnownThread(sourceId);
        const read = await bridge.request("thread/read", { threadId: sourceId, includeTurns: false });
        if (!read?.thread || read.thread.cwd !== known.cwd) {
          return respond(res, 403, { error: "Saved thread directory changed" });
        }
        if (!permissions.isAvailable(known.cwd)) {
          return respond(res, 409, {
            code: "PROJECT_FOLDER_MISSING",
            error: "기존 작업 폴더가 없어서 대화를 복제할 수 없습니다. 프로젝트 폴더를 복구해 주세요.",
          });
        }
        const writable = permissions.canWrite(known.cwd);
        const result = await bridge.request("thread/fork", {
          threadId: sourceId,
          cwd: known.cwd,
          sandbox: writable ? "workspace-write" : "read-only",
          approvalPolicy: writable ? "on-request" : "never",
          excludeTurns: true,
        }, 40000);
        const forked = result?.thread;
        if (!isValidThreadId(forked?.id) || forked.id === sourceId || forked.cwd !== known.cwd) {
          throw new Error("Invalid Codex fork response");
        }
        bridge.loadedThreads.add(forked.id);
        return respond(res, 201, {
          thread: {
            ...forked,
            projectId: permissions.projectId(known.cwd),
            available: true,
            editable: writable,
          },
          sourceThreadId: sourceId,
        });
      }
      if (req.method === "POST" && messageMatch) {
        codexStage = "thread/lookup";
        const threadId = messageMatch[1];
        // Existing projects may be discussed without granting filesystem writes.
        // Only explicitly allowlisted workspaces retain workspace-write access.
        const known = await assertKnownThread(threadId);
        const current = await bridge.request("thread/read", { threadId, includeTurns: false });
        if (!current?.thread || current.thread.cwd !== known.cwd) {
          return respond(res, 403, { error: "Saved thread directory changed" });
        }
        if (!permissions.isAvailable(current.thread.cwd)) {
          return respond(res, 409, {
            code: "PROJECT_FOLDER_MISSING",
            error: "이 대화의 원래 프로젝트 폴더가 PC에 없습니다. 저장된 대화는 읽을 수 있지만 메시지를 계속하려면 폴더를 복구하거나 다른 프로젝트에서 새 채팅을 시작해야 합니다.",
          });
        }
        const body = await parseJson(req);
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 12000) {
          return respond(res, 400, { error: "Message must contain 1–12,000 characters" });
        }
        codexStage = "thread/resume";
        await bridge.resumeThread(threadId);
        codexStage = "turn/start";
        const result = await bridge.request("turn/start", {
          threadId,
          input: [{ type: "text", text: body.text.trim() }],
          approvalPolicy: permissions.canWrite(current.thread.cwd) ? "on-request" : "never",
          sandbox: permissions.canWrite(current.thread.cwd) ? "workspace-write" : "read-only",
        });
        if (result?.turn?.id) bridge.activeTurns.set(threadId, result.turn.id);
        return respond(res, 202, result);
      }
      const stopMatch = /^\/api\/threads\/([^/]+)\/interrupt$/.exec(pathname);
      if (req.method === "POST" && stopMatch) {
        const threadId = stopMatch[1];
        await assertKnownThread(threadId);
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
      if (status !== 500) return respond(res, status, { error: error.message });
      // An upstream JSON-RPC message can contain private local filesystem
      // paths. Return only a classified, non-sensitive error to Safari.
      const detail = classifyCodexFailure(error);
      const diagnosticId = recordCodexError(permissions.root ?? ROOT, codexStage, error);
      return respond(res, detail.status, {
        code: detail.code,
        diagnosticId,
        error: detail.error,
      });
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
  const permissionManager = new ProjectPermissions({ root: ROOT, baseWorkspaces: workspaces });
  permissionManager.ensureManagementKey();
  const accessToken = loadAccessToken(ROOT);
  const trustedHosts = (process.env.TRUSTED_HOSTS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const bridge = new CodexBridge();
  const server = createServer({ bridge, accessToken, workspaces, trustedHosts, permissionManager });
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
