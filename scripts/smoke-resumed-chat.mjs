// Diagnostic-only: exercise a reopened Codex conversation in a throwaway folder.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../server/bridge.mjs";

const cwd = mkdtempSync(path.join(os.tmpdir(), "crw-resume-smoke-"));
const sandbox = process.argv.includes("--workspace-write") ? "workspace-write" : "read-only";
const approvalPolicy = sandbox === "workspace-write" ? "on-request" : "never";
let bridge = new CodexBridge();
let threadId;
let successful = false;
function waitCompleted(client, id, ms = 50000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("notification", listener);
      reject(new Error("Timed out waiting for turn/completed"));
    }, ms);
    const listener = ({ method, params }) => {
      if (method !== "turn/completed" || params?.threadId !== id) return;
      clearTimeout(timer);
      client.off("notification", listener);
      resolve(params?.turn?.status ?? "unknown");
    };
    client.on("notification", listener);
  });
}
try {
  await bridge.start();
  const started = await bridge.request("thread/start", { cwd, sandbox, approvalPolicy }, 30000);
  threadId = started?.thread?.id;
  if (!threadId) throw new Error("thread/start did not provide thread ID");
  const firstDone = waitCompleted(bridge, threadId);
  const firstTurn = await bridge.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply OK. Do not use tools." }],
    sandbox,
    approvalPolicy,
  }, 40000);
  if (!firstTurn?.turn?.id) throw new Error("First turn was not accepted");
  console.log("First turn status:", await firstDone);
  bridge.close();

  bridge = new CodexBridge();
  await bridge.start();
  await bridge.resumeThread(threadId);
  const nextDone = waitCompleted(bridge, threadId);
  const outcome = await bridge.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with only OK. Do not use tools or modify files." }],
    sandbox,
    approvalPolicy,
  }, 40000);
  if (!outcome?.turn?.id) throw new Error("turn/start did not provide turn ID");
  console.log("Reopened saved Codex thread accepted a read-only chat turn.");
  successful = true;
  console.log("Reopened turn status:", await nextDone);
} catch (error) {
  console.error("Reopened chat diagnostic:", String(error.message).slice(0, 480));
  process.exitCode = 1;
} finally {
  if (threadId) {
    try {
      const turnId = bridge.activeTurns.get(threadId);
      if (turnId) await bridge.request("turn/interrupt", { threadId, turnId }, 5000);
    } catch {}
    try { await bridge.request("thread/archive", { threadId }, 7000); } catch {}
  }
  bridge.close();
  if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  if (!successful) process.exitCode = 1;
}
