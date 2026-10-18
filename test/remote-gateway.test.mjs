import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRemoteGateway } from "../server/remote-gateway.mjs";
import { issuePairingCode } from "../server/remote-auth.mjs";

const host = "pc.example.ts.net:10000";
const secret = "local-secret-should-never-reach-browser-xxxxxxxxxxxxxxxxxxxxxxxx";

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};
const close = async (server) => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
};
function request(port, { pathname = "/", method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method, path: pathname,
      headers: {
        Host: host,
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("Safari gateway blocks unauthenticated access and safely proxies authenticated requests", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "crw-gateway-"));
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer " + secret) {
      res.writeHead(401); res.end("no"); return;
    }
    if (req.method === "POST" && req.headers.origin !== "http://127.0.0.1:" + upstream.address().port) {
      res.writeHead(403); res.end("origin rejected"); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ method: req.method, path: req.url, auth: true }));
  });
  const upstreamPort = await listen(upstream);
  const gateway = createRemoteGateway({ expectedHost: host, pairingRoot: temp, upstreamPort, upstreamToken: secret });
  const port = await listen(gateway);
  try {
    assert.equal((await request(port, { pathname: "/api/threads" })).status, 401);
    assert.equal((await request(port, { pathname: "/app" })).status, 303);
    assert.equal((await request(port)).status, 200);
    assert.equal((await request(port, { headers: { Host: "attacker.example:10000" } })).status, 421);

    const { code } = issuePairingCode(temp);
    assert.equal((await request(port, {
      pathname: "/remote-api/pair", method: "POST", body: { code },
      headers: { Origin: "https://attacker.example" },
    })).status, 403);
    assert.equal((await request(port, {
      pathname: "/remote-api/pair", method: "POST", body: { code: "A".repeat(24) },
      headers: { Origin: "https://" + host },
    })).status, 401);
    const paired = await request(port, {
      pathname: "/remote-api/pair", method: "POST", body: { code },
      headers: { Origin: "https://" + host },
    });
    assert.equal(paired.status, 200);
    assert.match(paired.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
    const cookie = paired.headers["set-cookie"][0].split(";")[0];
    assert.equal((await request(port, { pathname: "/remote-api/pair", method: "POST", body: { code }, headers: { Origin: "https://" + host } })).status, 401);

    const allowed = await request(port, { pathname: "/api/threads", headers: { Cookie: cookie, Authorization: "Bearer injected-attacker-token" } });
    assert.equal(allowed.status, 200);
    assert.equal(JSON.parse(allowed.text).auth, true);
    assert.equal((await request(port, { pathname: "/app.js", headers: { Cookie: cookie } })).status, 200);
    assert.equal((await request(port, { pathname: "/api/health", headers: { Cookie: cookie } })).status, 404);
    assert.equal((await request(port, { pathname: "/api/threads", method: "POST", body: {}, headers: { Cookie: cookie, Origin: "https://" + host } })).status, 403);
    const posted = await request(port, { pathname: "/api/threads", method: "POST", body: {}, headers: { Cookie: cookie, Origin: "https://" + host, "X-Remote-Client": "1" } });
    assert.equal(posted.status, 200);
    assert.equal(JSON.parse(posted.text).method, "POST");

    const logout = await request(port, { pathname: "/remote-api/logout", method: "POST", headers: { Cookie: cookie, Origin: "https://" + host } });
    assert.equal(logout.status, 200);
    assert.equal((await request(port, { pathname: "/api/threads", headers: { Cookie: cookie } })).status, 401);
  } finally {
    await close(gateway);
    await close(upstream);
    rmSync(temp, { recursive: true, force: true });
  }
});
