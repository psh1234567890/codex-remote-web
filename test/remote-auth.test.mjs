import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumePairingCode, issuePairingCode, RemoteSessions } from "../server/remote-auth.mjs";

test("pairing code is random, single-use, only hashed on disk", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "crw-pair-"));
  try {
    const { code } = issuePairingCode(root, 1000);
    assert.match(code, /^([A-F0-9]{6}-){3}[A-F0-9]{6}$/);
    const stored = readFileSync(path.join(root, ".local", "remote-pairing.json"), "utf8");
    assert.equal(stored.includes(code.replaceAll("-", "")), false);
    assert.equal(consumePairingCode(root, "AAAAAA-AAAAAA-AAAAAA-AAAAAA", 1100), false);
    assert.equal(consumePairingCode(root, code, 1100), true);
    assert.equal(consumePairingCode(root, code, 1100), false);
    issuePairingCode(root, 2000);
    assert.equal(consumePairingCode(root, code, 2000 + 60 * 60_000), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session cookies expire, revoke, and hold a bounded count", () => {
  let now = 1000;
  const sessions = new RemoteSessions({ now: () => now, maxSessions: 2 });
  const first = sessions.issue();
  assert.ok(sessions.verify(first));
  assert.equal(sessions.verify("bad"), false);
  const second = sessions.issue();
  const third = sessions.issue();
  assert.equal(sessions.verify(first), false);
  assert.equal(sessions.verify(second), true);
  assert.equal(sessions.verify(third), true);
  sessions.revoke(second);
  assert.equal(sessions.verify(second), false);
  now += 25 * 60 * 60_000;
  assert.equal(sessions.verify(third), false);
});
