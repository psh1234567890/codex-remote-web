import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
import { ProjectPermissions } from "../server/project-permissions.mjs";

class FakeBridge extends EventEmitter {
  constructor(cwd, otherCwd = "/definitely-not-an-allowed-folder") {
    super();
    this.cwd = cwd;
    this.otherCwd = otherCwd;
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
        { id: "denied-thread", cwd: this.otherCwd, preview: "Hidden" },
      ] };
    }
    if (method === "thread/read") {
      return { thread: { id: params.threadId, cwd: ["allowed-thread", "new-thread"].includes(params.threadId) ? this.cwd : this.otherCwd, turns: [] } };
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
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-project-permissions-"));
  const otherCwd = path.join(temporaryRoot, "other-project");
  mkdirSync(otherCwd);
  const bridge = new FakeBridge(cwd, otherCwd);
  const permissionManager = new ProjectPermissions({
    root: temporaryRoot,
    baseWorkspaces: [{ id: "0", name: "test", path: cwd }],
  });
  permissionManager.ensureManagementKey();
  const server = createServer({
    bridge,
    accessToken: secret,
    workspaces: [{ id: "0", name: "test", path: cwd }],
    trustedHosts,
    permissionManager,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server, bridge, url, permissionManager, otherCwd,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
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
    assert.equal((await fetch(app.url + "/api/projects")).status, 401);
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
    const projectsResponse = await fetch(app.url + "/api/projects", { headers });
    assert.equal(projectsResponse.status, 200);
    const projects = (await projectsResponse.json()).projects;
    const allowedWorkspace = projects.find((item) => item.writable);
    const allowed = await fetch(app.url + "/api/threads", { method: "POST", headers, body: JSON.stringify({ workspaceId: allowedWorkspace.id }) });
    assert.equal(allowed.status, 201);
    assert.equal(app.bridge.calls.find((call) => call.method === "thread/start").params.sandbox, "workspace-write");
    const newlyCreated = await fetch(app.url + "/api/threads/new-thread", { headers });
    assert.equal(newlyCreated.status, 200, "new empty threads must open before they appear in thread/list");
    const existing = await fetch(app.url + "/api/threads/denied-thread", { headers });
    assert.equal(existing.status, 200, "saved external projects should be viewable");
    assert.equal((await existing.json()).thread.editable, false);
    assert.equal((await fetch(app.url + "/api/threads/not-listed-thread", { headers })).status, 404);
    const readOnlyChat = await fetch(app.url + "/api/threads/denied-thread/messages", {
      method: "POST", headers, body: JSON.stringify({ text: "do not modify" }),
    });
    assert.equal(readOnlyChat.status, 202, "saved projects should support read-only chat");
    const readOnlyTurn = app.bridge.calls.find(
      (call) => call.method === "turn/start" && call.params.threadId === "denied-thread",
    );
    assert.equal(readOnlyTurn.params.sandbox, "read-only", "unknown projects must not grant write access");
    assert.equal(readOnlyTurn.params.approvalPolicy, "never");
    const writableChat = await fetch(app.url + "/api/threads/allowed-thread/messages", {
      method: "POST", headers, body: JSON.stringify({ text: "test message" }),
    });
    assert.equal(writableChat.status, 202);
    const writableTurn = app.bridge.calls.find(
      (call) => call.method === "turn/start" && call.params.threadId === "allowed-thread",
    );
    assert.equal(writableTurn.params.sandbox, "workspace-write");
    assert.equal(writableTurn.params.approvalPolicy, "on-request");
    assert.equal((await fetch(app.url + "/api/threads/not-listed-thread/messages", {
      method: "POST", headers, body: JSON.stringify({ text: "hi" }),
    })).status, 404);
    const other = projects.find((item) => item.name === "other-project");
    assert.equal(other.writable, false);
    const createReadOnly = await fetch(app.url + "/api/threads", {
      method: "POST", headers, body: JSON.stringify({ workspaceId: other.id }),
    });
    assert.equal(createReadOnly.status, 201);
    assert.equal(app.bridge.calls.filter((call) => call.method === "thread/start").at(-1).params.sandbox, "read-only");
  } finally {
    await app.close();
  }
});

test("new write privileges require a PC management key and may be individually revoked", async () => {
  const app = await setup();
  try {
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const projects = (await (await fetch(app.url + "/api/projects", { headers })).json()).projects;
    const restricted = projects.find((item) => item.name === "other-project");
    const target = app.url + "/api/projects/" + restricted.id + "/access";
    const wrong = await fetch(target, {
      method: "POST", headers, body: JSON.stringify({ enabled: true, managementKey: "b".repeat(64) }),
    });
    assert.equal(wrong.status, 403);
    const key = readFileSync(app.permissionManager.adminKeyFile, "utf8").trim();
    const approved = await fetch(target, {
      method: "POST", headers, body: JSON.stringify({ enabled: true, managementKey: key }),
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).writable, true);
    const list = await fetch(app.url + "/api/threads", { headers });
    assert.equal((await list.json()).threads.find((t) => t.id === "denied-thread").editable, true);
    const posted = await fetch(app.url + "/api/threads/denied-thread/messages", {
      method: "POST", headers, body: JSON.stringify({ text: "Inspect and update this file." }),
    });
    assert.equal(posted.status, 202);
    assert.equal(app.bridge.calls.filter((c) => c.method === "turn/start").at(-1).params.sandbox, "workspace-write");
    const disabled = await fetch(target, { method: "POST", headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(disabled.status, 200);
    assert.equal(app.permissionManager.canWrite(app.otherCwd), false);
    const readOnlyPost = await fetch(app.url + "/api/threads/denied-thread/messages", {
      method: "POST", headers, body: JSON.stringify({ text: "Read only." }),
    });
    assert.equal(readOnlyPost.status, 202);
    assert.equal(app.bridge.calls.filter((c) => c.method === "turn/start").at(-1).params.sandbox, "read-only");
    const unknown = await fetch(app.url + "/api/projects/" + "a".repeat(32) + "/access", {
      method: "POST", headers, body: JSON.stringify({ enabled: true, managementKey: key }),
    });
    assert.equal(unknown.status, 404);
  } finally { await app.close(); }
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
