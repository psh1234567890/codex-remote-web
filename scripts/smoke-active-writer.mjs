// Reproduce an active writer using two isolated Codex app-server processes.
// The experiment uses only a temporary project and never touches user sessions.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../server/bridge.mjs";

const cwd = mkdtempSync(path.join(os.tmpdir(), "crw-writer-smoke-"));
const owner = new CodexBridge();
const guest = new CodexBridge();
let original, forked;
function completed(bridge, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Turn timeout")), 60000);
    const handler = ({ method, params }) => {
      if (method !== "turn/completed" || params?.threadId !== id) return;
      clearTimeout(timer);
      bridge.off("notification", handler);
      resolve(params.turn?.status);
    };
    bridge.on("notification", handler);
  });
}
try {
  await owner.start();
  const started = await owner.request("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" });
  original = started.thread?.id;
  if (!original) throw new Error("Missing source thread");
  const finish = completed(owner, original);
  await owner.request("turn/start", {
    threadId: original,
    input: [{ type: "text", text: "Answer OK and do not use tools." }],
    sandbox: "read-only", approvalPolicy: "never",
  });
  if (await finish !== "completed") throw new Error("Initial turn did not complete");
  await guest.start();
  try {
    await guest.request("thread/resume", { threadId: original, excludeTurns: true });
    console.log("Resume from second app-server succeeded (no writer conflict reproduced)");
  } catch (error) {
    console.log("Concurrent resume error:", String(error.message).slice(0, 160));
  }
  const fork = await guest.request("thread/fork", {
    threadId: original,
    cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    excludeTurns: true,
  });
  forked = fork.thread?.id;
  if (!forked || forked === original) throw new Error("Fork did not create an independent thread");
  const finishFork = completed(guest, forked);
  await guest.request("turn/start", {
    threadId: forked,
    input: [{ type: "text", text: "Answer OK again. No tools." }],
    sandbox: "read-only", approvalPolicy: "never",
  });
  if (await finishFork !== "completed") throw new Error("Fork turn did not complete");
  console.log("Independent fork and new message: OK");
} catch (error) {
  console.error("Active-writer smoke test failed:", error.message);
  process.exitCode = 1;
} finally {
  guest.close();
  owner.close();
  // Test threads are throwaway: archive after releasing both active writers.
  const cleanup = new CodexBridge();
  try {
    await cleanup.start();
    for (const id of [forked, original]) {
      if (!id) continue;
      try { await cleanup.request("thread/archive", { threadId: id }, 5000); } catch {}
    }
  } catch {}
  cleanup.close();
  rmSync(cwd, { recursive: true, force: true });
}
