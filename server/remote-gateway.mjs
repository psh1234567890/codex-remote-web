import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { consumePairingCode, RemoteSessions, SESSION_TTL_MS } from "./remote-auth.mjs";
import { loadAccessToken } from "./security.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONTENT_ROOT = path.join(ROOT, "public");
const STATIC = new Map([
  ["/", ["remote-login.html", "text/html; charset=utf-8"]],
  ["/remote-login.js", ["remote-login.js", "text/javascript; charset=utf-8"]],
  ["/remote-login.css", ["remote-login.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);
const API_ROUTES = [
  ["GET", /^\/api\/(session|workspaces|approvals|events|threads)$/],
  ["GET", /^\/api\/projects$/],
  ["POST", /^\/api\/projects\/[a-f0-9]{32}\/access$/],
  ["POST", /^\/api\/threads$/],
  ["GET", /^\/api\/threads\/[A-Za-z0-9_-]{5,150}$/],
  ["POST", /^\/api\/threads\/[A-Za-z0-9_-]{5,150}\/(messages|interrupt)$/],
  ["POST", /^\/api\/approvals\/[a-f0-9-]{36}$/],
];
const COMMON = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...COMMON, "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
};
const bounce = (res, target) => {
  res.writeHead(303, { ...COMMON, Location: target });
  res.end();
};
const isApiAllowed = (method, pathName) => API_ROUTES.some(([verb, regex]) => method === verb && regex.test(pathName));

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function sameOrigin(req, expectedHost) {
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return false;
  return typeof origin === "string" && origin === `https://${expectedHost}`;
}

function inputJson(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 2048) {
        reject(new Error("too_large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (total > 2048) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("bad_json")); }
    });
    req.on("error", reject);
  });
}

export function createRemoteGateway({
  expectedHost,
  pairingRoot = ROOT,
  upstreamPort = 4765,
  upstreamToken,
  sessions = new RemoteSessions(),
  clock = () => Date.now(),
} = {}) {
  if (!expectedHost || !/^[-.a-z0-9]+\.ts\.net:10000$/.test(expectedHost)) {
    throw new Error("REMOTE_PUBLIC_HOST must be the exact Tailscale HTTPS hostname and port 10000");
  }
  if (typeof upstreamToken !== "string" || upstreamToken.length < 32) throw new Error("Missing upstream access token");
  let failedAttempts = 0;
  let lockUntil = 0;
  const hostHeader = "127.0.0.1:" + upstreamPort;

  function proxy(req, res, pathName) {
    const upstreamPath = pathName === "/app" ? "/" : pathName;
    const upstreamHeaders = {
      Host: hostHeader,
      Authorization: "Bearer " + upstreamToken,
      Accept: String(req.headers.accept ?? "*/*").slice(0, 128),
    };
    if (req.method === "POST") {
      upstreamHeaders.Origin = "http://" + hostHeader;
      upstreamHeaders["Content-Type"] = "application/json";
      const len = Number(req.headers["content-length"]);
      if (Number.isFinite(len) && len > 65536) {
        json(res, 413, { error: "Body too large" });
        return;
      }
    }
    const upstreamReq = http.request({
      hostname: "127.0.0.1",
      port: upstreamPort,
      method: req.method,
      path: upstreamPath,
      headers: upstreamHeaders,
      timeout: upstreamPath === "/api/events" ? 0 : 45000,
    }, (upstreamRes) => {
      const contentType = String(upstreamRes.headers["content-type"] ?? "application/octet-stream");
      res.writeHead(upstreamRes.statusCode ?? 502, {
        ...COMMON,
        "Content-Type": contentType,
        ...(upstreamPath === "/api/events" ? { Connection: "keep-alive", "X-Accel-Buffering": "no" } : {}),
      });
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", () => {
      if (!res.headersSent) json(res, 502, { error: "Local Codex service unavailable" });
      else res.destroy();
    });
    upstreamReq.on("timeout", () => upstreamReq.destroy());
    req.on("close", () => {
      if (!req.complete) upstreamReq.destroy();
    });
    res.on("close", () => upstreamReq.destroy());
    if (req.method === "POST") {
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) upstreamReq.destroy();
      });
    }
    req.pipe(upstreamReq);
  }

  return http.createServer(async (req, res) => {
    const host = String(req.headers.host ?? "").toLowerCase();
    // The only public ingress is an HTTPS Tailscale Funnel endpoint.
    if (host !== expectedHost) return json(res, 421, { error: "Invalid Host" });
    let pathname;
    try { pathname = new URL(req.url ?? "/", "https://" + expectedHost).pathname; }
    catch { return json(res, 400, { error: "Invalid path" }); }
    const token = cookieValue(req.headers.cookie, "crw_session");
    const authenticated = sessions.verify(token);

    if (pathname === "/remote-api/pair" && req.method === "POST") {
      if (!sameOrigin(req, expectedHost) || !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return json(res, 403, { error: "Forbidden" });
      }
      if (clock() < lockUntil) return json(res, 429, { error: "Too many attempts. Try again later." });
      let body;
      try { body = await inputJson(req); }
      catch { if (!res.destroyed) json(res, 400, { error: "Invalid request" }); return; }
      if (!consumePairingCode(pairingRoot, body?.code, clock())) {
        failedAttempts++;
        if (failedAttempts >= 8) {
          lockUntil = clock() + 15 * 60_000;
          failedAttempts = 0;
        }
        return json(res, 401, { error: "Invalid or expired code" });
      }
      failedAttempts = 0;
      lockUntil = 0;
      const newToken = sessions.issue();
      return json(res, 200, { connected: true }, {
        "Set-Cookie": `crw_session=${newToken}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; Secure; HttpOnly; SameSite=Strict`,
      });
    }
    if (pathname === "/remote-api/logout" && req.method === "POST") {
      if (!sameOrigin(req, expectedHost)) return json(res, 403, { error: "Forbidden" });
      sessions.revoke(token);
      return json(res, 200, { disconnected: true }, {
        "Set-Cookie": "crw_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
      });
    }
    if (pathname === "/remote-api/session" && req.method === "GET") {
      return authenticated ? json(res, 200, { connected: true }) : json(res, 401, { error: "Not connected" });
    }
    if (pathname === "/" && req.method === "GET" && authenticated) return bounce(res, "/app");
    if (req.method === "GET" && STATIC.has(pathname)) {
      const [file, type] = STATIC.get(pathname);
      try {
        const fileData = await readFile(path.join(CONTENT_ROOT, file));
        res.writeHead(200, { ...COMMON, "Content-Type": type });
        return res.end(fileData);
      } catch { return json(res, 500, { error: "Static asset unavailable" }); }
    }
    if (!authenticated) {
      if (req.method === "GET" && pathname === "/app") return bounce(res, "/");
      return json(res, 401, { error: "Connect this Safari on the login page" });
    }
    if (req.method === "GET" && ["/app", "/app.js", "/codex.css"].includes(pathname)) {
      return proxy(req, res, pathname);
    }
    if (isApiAllowed(req.method, pathname)) {
      if (req.method === "POST" && (!sameOrigin(req, expectedHost) || req.headers["x-remote-client"] !== "1")) {
        return json(res, 403, { error: "Cross-site request denied" });
      }
      return proxy(req, res, pathname);
    }
    return json(res, 404, { error: "Not found" });
  });
}

async function main() {
  const expectedHost = process.env.REMOTE_PUBLIC_HOST?.toLowerCase();
  const upstreamToken = loadAccessToken(ROOT);
  const server = createRemoteGateway({ expectedHost, upstreamToken });
  const port = Number(process.env.REMOTE_GATEWAY_PORT ?? 4776);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid REMOTE_GATEWAY_PORT");
  server.listen(port, "127.0.0.1", () => {
    console.log("Safari authentication gateway ready on 127.0.0.1:" + port);
    console.log("Public endpoint (only after security checks): https://" + expectedHost + "/");
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Could not start Safari authentication gateway");
    process.exitCode = 1;
  });
}
