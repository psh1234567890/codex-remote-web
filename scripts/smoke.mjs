import { CodexBridge } from "../server/bridge.mjs";

const bridge = new CodexBridge();
try {
  const init = await bridge.start();
  const result = await bridge.request("thread/list", { limit: 5 });
  const threads = result?.data ?? result?.threads ?? [];
  console.log("App-server initialized:", Boolean(init));
  console.log("Codex threads available:", threads.length);
  if (threads.length) {
    try {
      const read = await bridge.request("thread/read", { threadId: threads[0].id, includeTurns: false });
      console.log("Thread metadata read:", Boolean(read?.thread?.id));
      console.log("Thread cwd present:", Boolean(read?.thread?.cwd));
      const page = await bridge.request("thread/turns/list", {
        threadId: threads[0].id, limit: 4, sortDirection: "desc", itemsView: "summary",
      });
      console.log("Paginated history read:", Array.isArray(page?.data));
    } catch (error) {
      console.log("Thread history read error:", error.message.slice(0, 160));
    }
  }
  console.log("Handshake and thread/list: OK");
} catch (error) {
  console.error("Smoke test failed:", error.message);
  process.exitCode = 1;
} finally {
  bridge.close();
}
