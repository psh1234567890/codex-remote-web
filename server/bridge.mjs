import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const CODEX_ENTRY = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export class CodexBridge extends EventEmitter {
  constructor({ command = process.execPath, args = [CODEX_ENTRY, "app-server"], spawnProcess = spawn } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.ready = false;
    this.nextId = 1;
    this.buffer = "";
    this.discardingOversizeLine = false;
    this.waiting = new Map();
    this.approvals = new Map();
    this.activeTurns = new Map();
    this.loadedThreads = new Set();
  }

  async start() {
    if (this.child) throw new Error("Codex bridge is already started");
    this.child = this.spawnProcess(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    // Do not expose stderr: Codex may print private paths or environment details.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.handleExit());
    this.child.on("exit", () => this.handleExit());

    const init = await this.request("initialize", {
      clientInfo: { name: "codex_remote_web", title: "Codex Remote Web", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, 20000);
    this.send({ method: "initialized" });
    this.ready = true;
    this.emit("status", { ready: true });
    return init;
  }

  handleExit() {
    if (!this.child) return;
    this.child = null;
    this.ready = false;
    for (const item of this.waiting.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Codex app-server disconnected"));
    }
    this.waiting.clear();
    for (const item of this.approvals.values()) clearTimeout(item.timer);
    this.approvals.clear();
    this.activeTurns.clear();
    this.loadedThreads.clear();
    this.emit("status", { ready: false });
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not connected");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(error);
      }
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (this.discardingOversizeLine) {
        this.discardingOversizeLine = false;
        continue;
      }
      if (line.length > 8 * 1024 * 1024) continue;
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        // Ignore malformed upstream notifications; never echo raw payloads.
      }
    }
    // Discard only the oversized message, not the entire Codex process.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = "";
      this.discardingOversizeLine = true;
    }
  }

  handleMessage(message) {
    if (message && "id" in message && !message.method) {
      const waiting = this.waiting.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.waiting.delete(message.id);
      if (message.error) waiting.reject(new Error(String(message.error.message || "Codex RPC error")));
      else waiting.resolve(message.result);
      return;
    }
    if (!message?.method) return;

    if ("id" in message) {
      if (!APPROVAL_METHODS.has(message.method)) {
        this.send({ id: message.id, error: { code: -32601, message: "Unsupported interactive request" } });
        return;
      }
      const publicId = randomUUID();
      const details = {
        id: publicId,
        method: message.method,
        threadId: message.params?.threadId ?? null,
        turnId: message.params?.turnId ?? null,
        command: message.params?.command ?? null,
        cwd: message.params?.cwd ?? null,
        reason: message.params?.reason ?? null,
        itemId: message.params?.itemId ?? null,
      };
      const timer = setTimeout(() => {
        if (!this.approvals.has(publicId)) return;
        this.approvals.delete(publicId);
        try { this.send({ id: message.id, result: { decision: "decline" } }); } catch {}
        this.emit("approvalResolved", { id: publicId, decision: "decline" });
      }, 120000);
      this.approvals.set(publicId, { rpcId: message.id, timer, details });
      this.emit("approval", details);
      return;
    }

    if (message.method === "turn/started" && message.params?.threadId && message.params?.turn?.id) {
      this.activeTurns.set(message.params.threadId, message.params.turn.id);
    }
    if (message.method === "turn/completed" && message.params?.threadId) {
      this.activeTurns.delete(message.params.threadId);
    }
    if (message.method === "serverRequest/resolved" && message.params?.requestId != null) {
      for (const [id, item] of this.approvals) {
        if (String(item.rpcId) === String(message.params.requestId)) {
          clearTimeout(item.timer);
          this.approvals.delete(id);
          this.emit("approvalResolved", { id, decision: "resolved" });
        }
      }
    }
    this.emit("notification", { method: message.method, params: message.params ?? {} });
  }

  resolveApproval(publicId, decision) {
    if (decision !== "accept" && decision !== "decline") throw new Error("Invalid approval decision");
    const item = this.approvals.get(publicId);
    if (!item) throw new Error("Approval expired or already resolved");
    clearTimeout(item.timer);
    this.approvals.delete(publicId);
    this.send({ id: item.rpcId, result: { decision } });
    this.emit("approvalResolved", { id: publicId, decision });
  }

  pendingApprovals() {
    return [...this.approvals.values()].map((item) => item.details);
  }

  async resumeThread(threadId) {
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", { threadId, excludeTurns: true });
    this.loadedThreads.add(threadId);
  }

  close() {
    this.child?.kill();
    this.handleExit();
  }
}
