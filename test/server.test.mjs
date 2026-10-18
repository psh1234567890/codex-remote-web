import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "../server/index.mjs";

class FakeBridge extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.ready = true;
    this.loadedThreads = new Set();
    this.activeTurns = new Map();
    this.calls = [];
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return { data: [
        { id: "allowed-thread", cwd: this.cwd, preview: "Safe" },
        { id: "denied-thread", cwd: "/definitely-not-an-allowed-folder", preview: "Hidden" },
      ] };
    }
    if (method === "thread/read") {
      return { thread: { id: params.threadId, cwd: params.threadId === "allowed-thread" ? this.cwd : "/not-allowed", turns: [] } };
    }
    if (method === "thread/start") return { thread: { id: "new-thread", cwd: params.cwd, turns: [] } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: "new-turn" } };
    return {};
  }
  async resumeThread(id) { this.calls.push({ method: "thread/resume", params: { threadId: id } }); }
  pendingApprovals() { return []; }
}

const secret = "a".repeat(64);

async function setup() {
  const cwd = process.cwd();
  const bridge = new FakeBridge(cwd);
  const server = createServer({
    bridge,
    accessToken: secret,
    workspaces: [{ id: "0", name: "test", path: cwd }],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, bridge, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("private endpoints require a token; static app is accessible", async () => {
  const app = await setup();
  try {
    const home = await fetch(app.url + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Codex Remote Web/);
    assert.equal((await fetch(app.url + "/api/threads")).status, 401);
    assert.equal((await fetch(app.url + "/api/threads", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const allowed = await fetch(app.url + "/api/threads", { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(allowed.status, 200);
    const data = await allowed.json();
    assert.deepEqual(data.threads.map((item) => item.id), ["allowed-thread"]);
  } finally {
    await app.close();
  }
});

test("new threads are confined to allowed workspaces", async () => {
  const app = await setup();
  try {
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const denied = await fetch(app.url + "/api/threads", { method: "POST", headers, body: JSON.stringify({ workspaceId: "99" }) });
    assert.equal(denied.status, 400);
    const allowed = await fetch(app.url + "/api/threads", { method: "POST", headers, body: JSON.stringify({ workspaceId: "0" }) });
    assert.equal(allowed.status, 201);
    assert.equal(app.bridge.calls.find((call) => call.method === "thread/start").params.sandbox, "workspace-write");
    assert.equal((await fetch(app.url + "/api/threads/denied-thread", { headers })).status, 403);
  } finally {
    await app.close();
  }
});

test("cross-origin mutation is rejected", async () => {
  const app = await setup();
  try {
    const response = await fetch(app.url + "/api/threads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      body: JSON.stringify({ workspaceId: "0" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await app.close();
  }
});
