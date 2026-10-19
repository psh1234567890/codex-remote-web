import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
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
      return { thread: { id: params.threadId, cwd: params.threadId === "allowed-thread" ? this.cwd : "/definitely-not-an-allowed-folder", turns: [] } };
    }
    if (method === "thread/turns/list") return { data: [] };
    if (method === "thread/start") return { thread: { id: "new-thread", cwd: params.cwd, turns: [] } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: "new-turn" } };
    return {};
  }
  async resumeThread(id) { this.calls.push({ method: "thread/resume", params: { threadId: id } }); }
  pendingApprovals() { return []; }
}

const secret = "a".repeat(64);

async function setup({ trustedHosts = [] } = {}) {
  const cwd = process.cwd();
  const bridge = new FakeBridge(cwd);
  const server = createServer({
    bridge,
    accessToken: secret,
    workspaces: [{ id: "0", name: "test", path: cwd }],
    trustedHosts,
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
    const html = await home.text();
    assert.match(html, /Codex Remote Web/);
    assert.match(html, /id="sidebar-toggle"/);
    assert.match(html, /id="thread-search"/);
    const stylesheet = await fetch(app.url + "/codex.css");
    assert.equal(stylesheet.status, 200);
    assert.match(await stylesheet.text(), /--sidebar: #1b2023/);
    assert.equal((await fetch(app.url + "/style.css")).status, 404);
    assert.equal((await fetch(app.url + "/api/threads")).status, 401);
    assert.equal((await fetch(app.url + "/api/threads", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const allowed = await fetch(app.url + "/api/threads", { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(allowed.status, 200);
    const data = await allowed.json();
    assert.deepEqual(data.threads.map((item) => [item.id, item.editable]), [
      ["allowed-thread", true],
      ["denied-thread", false],
    ]);
  } finally {
    await app.close();
  }
});

test("saved projects are collected across paginated Codex thread lists", async () => {
  const cwd = process.cwd();
  const bridge = new FakeBridge(cwd);
  const seen = [];
  const original = bridge.request.bind(bridge);
  bridge.request = async (method, params) => {
    if (method !== "thread/list") return original(method, params);
    seen.push(params.cursor ?? "first");
    return params.cursor
      ? { data: [{ id: "second-page-thread", cwd: "/archive", preview: "Old conversation" }] }
      : { data: [{ id: "first-page-thread", cwd, preview: "Recent conversation" }], nextCursor: "next-page" };
  };
  const server = createServer({
    bridge, accessToken: secret,
    workspaces: [{ id: "0", name: "test", path: cwd }],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/threads`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.threads.map((item) => [item.id, item.editable]), [
      ["first-page-thread", true],
      ["second-page-thread", false],
    ]);
    assert.deepEqual(seen, ["first", "next-page"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("private HTTPS proxy hostname must be explicitly trusted", async () => {
  const app = await setup({ trustedHosts: ["my-pc.example.ts.net"] });
  const requestWithHost = (host) => new Promise((resolve, reject) => {
    const url = new URL(app.url);
    http.get({ hostname: url.hostname, port: url.port, path: "/api/health", headers: { Host: host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  try {
    assert.equal(await requestWithHost("my-pc.example.ts.net:8443"), 200);
    assert.equal(await requestWithHost("untrusted.example.ts.net:8443"), 421);
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
    const existing = await fetch(app.url + "/api/threads/denied-thread", { headers });
    assert.equal(existing.status, 200, "saved external projects should be viewable");
    assert.equal((await existing.json()).thread.editable, false);
    assert.equal((await fetch(app.url + "/api/threads/not-listed-thread", { headers })).status, 404);
    const mutation = await fetch(app.url + "/api/threads/denied-thread/messages", {
      method: "POST", headers, body: JSON.stringify({ text: "do not modify" }),
    });
    assert.equal(mutation.status, 403, "unknown workspaces must remain read-only");
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
