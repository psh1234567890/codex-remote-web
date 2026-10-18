import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configuredWorkspaces,
  isAllowedWorkspace,
  isTrustedHost,
  isValidThreadId,
  loadAccessToken,
  parseBearer,
  tokenMatches,
} from "../server/security.mjs";

test("access token is generated, persisted and kept secret", () => {
  const root = mkdtempSync(path.join(tmpdir(), "crw-test-"));
  try {
    const first = loadAccessToken(root, {});
    const second = loadAccessToken(root, {});
    assert.equal(first, second);
    assert.equal(first.length, 64);
    assert.equal(readFileSync(path.join(root, ".local", "access-token"), "utf8").trim(), first);
    assert.ok(tokenMatches(first, second));
    assert.equal(tokenMatches("incorrect", second), false);
    assert.equal(tokenMatches(null, second), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects weak configured tokens", () => {
  assert.throws(() => loadAccessToken(".", { REMOTE_WEB_ACCESS_TOKEN: "short" }), /at least 32/);
});

test("Bearer token parsing is strict", () => {
  assert.equal(parseBearer("Bearer abc"), "abc");
  assert.equal(parseBearer("Basic abc"), null);
  assert.equal(parseBearer("Bearer abc def"), null);
});

test("workspace allowlist does not authorize sibling directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "crw-root-"));
  const allowed = configuredWorkspaces(root, {});
  try {
    assert.ok(isAllowedWorkspace(root, allowed));
    assert.equal(isAllowedWorkspace(tmpdir(), allowed), false);
    assert.equal(isAllowedWorkspace(path.join(root, "does-not-exist"), allowed), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("thread IDs and Host headers are validated", () => {
  assert.ok(isValidThreadId("12345678-abcd-1234-9876"));
  assert.equal(isValidThreadId("../etc/passwd"), false);
  assert.ok(isTrustedHost("127.0.0.1:4765"));
  assert.ok(isTrustedHost("localhost:4765"));
  assert.equal(isTrustedHost("attacker.example:4765"), false);
  assert.ok(isTrustedHost("myhost.example", ["myhost.example"]));
});
