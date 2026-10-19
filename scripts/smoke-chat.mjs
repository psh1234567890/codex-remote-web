// A safe end-to-end app-server check. Uses an isolated, temporary empty cwd.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../server/bridge.mjs";

const isolated = mkdtempSync(path.join(os.tmpdir(), "crw-readonly-smoke-"));
const bridge = new CodexBridge();
let threadId;
let completed = false;
try {
  await bridge.start();
  const started = await bridge.request("thread/start", {
    cwd: isolated,
    approvalPolicy: "never",
    sandbox: "read-only",
  }, 30_000);
  threadId = started.thread?.id;
  if (!threadId) throw new Error("Codex did not return a thread ID");

  const turnCompleted = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Codex response timed out")), 90_000);
    const handler = ({ method, params }) => {
      if (method === "turn/completed" && params?.threadId === threadId) {
        clearTimeout(timeout);
        bridge.off("notification", handler);
        resolve(params);
      }
    };
    bridge.on("notification", handler);
  });
  const turn = await bridge.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Say exactly READY. Do not run tools or modify files." }],
    approvalPolicy: "never",
    sandbox: "read-only",
  }, 45_000);
  if (!turn?.turn?.id) throw new Error("Codex did not accept a new turn");
  const done = await turnCompleted;
  if (done.turn?.status === "failed") throw new Error("Codex turn failed");
  completed = true;
  console.log("Real Codex read-only text turn: accepted and completed.");
} catch (error) {
  console.error("Real Codex message test failed:", error.message);
  process.exitCode = 1;
} finally {
  if (threadId && !completed) {
    try {
      const turnId = bridge.activeTurns.get(threadId);
      if (turnId) await bridge.request("turn/interrupt", { threadId, turnId }, 5_000);
    } catch {}
  }
  if (threadId) {
    try { await bridge.request("thread/archive", { threadId }, 7_000); } catch {}
  }
  bridge.close();
  // The path was created by mkdtempSync and contains no user project files.
  rmSync(isolated, { recursive: true, force: true });
}
