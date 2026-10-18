import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexBridge } from "../server/bridge.mjs";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0);
  return child;
}

test("app-server handshake and approval require explicit decision", async () => {
  const child = fakeProcess();
  const writes = [];
  child.stdin.on("data", (buffer) => {
    for (const line of buffer.toString().trim().split("\n")) writes.push(JSON.parse(line));
  });
  const bridge = new CodexBridge({ spawnProcess: () => child });
  const start = bridge.start();
  assert.equal(writes[0].method, "initialize");
  assert.equal(writes[0].params.capabilities.experimentalApi, true);
  child.stdout.write(JSON.stringify({ id: writes[0].id, result: { userAgent: "test" } }) + "\n");
  await start;
  assert.equal(bridge.ready, true);
  assert.equal(writes[1].method, "initialized");

  let approval;
  bridge.on("approval", (value) => { approval = value; });
  child.stdout.write(JSON.stringify({
    id: 700,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-test", turnId: "turn-test", command: "npm test", cwd: "/test" },
  }) + "\n");
  assert.equal(approval.command, "npm test");
  assert.equal(bridge.pendingApprovals().length, 1);
  assert.equal(writes.some((item) => item.id === 700), false, "must not auto-approve");
  bridge.resolveApproval(approval.id, "decline");
  assert.deepEqual(writes.at(-1), { id: 700, result: { decision: "decline" } });
  assert.equal(bridge.pendingApprovals().length, 0);
  assert.throws(() => bridge.resolveApproval(approval.id, "accept"), /expired/);

  child.stdout.write(JSON.stringify({ id: 701, method: "fs/remove", params: {} }) + "\n");
  assert.equal(writes.at(-1).error.code, -32601, "unknown requests must be rejected");
  bridge.close();
  assert.equal(bridge.ready, false);
});

test("oversized upstream lines are dropped without killing the bridge", () => {
  const child = fakeProcess();
  const bridge = new CodexBridge({ spawnProcess: () => child });
  bridge.child = child;
  bridge.ready = true;
  bridge.consume("x".repeat(8 * 1024 * 1024 + 1));
  assert.equal(bridge.discardingOversizeLine, true);
  assert.equal(bridge.ready, true);
  bridge.consume("tail\n" + JSON.stringify({ method: "turn/completed", params: { threadId: "test" } }) + "\n");
  assert.equal(bridge.discardingOversizeLine, false);
  assert.equal(bridge.ready, true);
  bridge.close();
});
