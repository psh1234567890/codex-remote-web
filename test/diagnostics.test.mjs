import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordCodexError, scrubRpcMessage } from "../server/diagnostics.mjs";

test("app-server failures are identifiable locally without sending sensitive error strings to Safari", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-errors-"));
  try {
    const upstreamMessage = "RPC bad request C:\\Users\\USER\\Desktop\\secret.txt; Bearer test-token sk-projectSecretAbcdef1234567";
    const scrubbed = scrubRpcMessage(upstreamMessage);
    assert.equal(scrubbed.includes("secret.txt"), false);
    assert.equal(scrubbed.includes("test-token"), false);
    assert.equal(scrubbed.includes("sk-projectSecret"), false);
    const id = recordCodexError(root, "turn/start", new Error(upstreamMessage));
    assert.match(id, /^[0-9a-f]{10}$/);
    const log = readFileSync(path.join(root, ".local", "codex-error-diagnostics.jsonl"), "utf8");
    const [record] = log.trim().split("\n").map(JSON.parse);
    assert.equal(record.id, id);
    assert.equal(record.stage, "turn/start");
    assert.equal(log.includes("secret.txt"), false);
    assert.equal(log.includes("test-token"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
