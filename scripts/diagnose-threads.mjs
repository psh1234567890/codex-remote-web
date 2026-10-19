import { fileURLToPath } from "node:url";
import path from "node:path";
import { CodexBridge } from "../server/bridge.mjs";
import { configuredWorkspaces, isAllowedWorkspace } from "../server/security.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspaces = configuredWorkspaces(root);
const bridge = new CodexBridge();
try {
  await bridge.start();
  const grouped = new Map();
  let cursor;
  let total = 0;
  let pages = 0;
  let matched = 0;
  do {
    const result = await bridge.request("thread/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    }, 40000);
    const threads = result?.data ?? [];
    for (const thread of threads) {
      total++;
      const allowed = isAllowedWorkspace(thread.cwd, workspaces);
      if (allowed) matched++;
      const key = path.basename(thread.cwd || "unknown");
      const value = grouped.get(key) ?? { count: 0, allowed: false };
      value.count++;
      value.allowed ||= allowed;
      grouped.set(key, value);
    }
    cursor = result?.nextCursor ?? null;
    pages++;
  } while (cursor && pages < 10);
  console.log(JSON.stringify({
    allowedWorkspaces: workspaces.map((entry) => entry.name),
    total, matched, pages, furtherPages: Boolean(cursor),
    projectGroups: [...grouped].map(([name, stats]) => ({ name, ...stats })).sort((a, b) => b.count - a.count),
  }, null, 2));
} catch (error) {
  console.error("thread diagnosis error:", error.message);
  process.exitCode = 1;
} finally {
  bridge.close();
}
