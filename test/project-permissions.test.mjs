import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectPermissions, WRITE_TTL_MS, issueWriteCode } from "../server/project-permissions.mjs";

test("per-project write access requires a separate secret, expires, and survives restart", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "crw-project-write-"));
  try {
    const included = path.join(root, "initial");
    const nested = path.join(included, "nested");
    const other = path.join(root, "other");
    for (const folder of [included, nested, other]) mkdirSync(folder, { recursive: true });
    let now = 10_000;
    const options = { root, baseWorkspaces: [{ id: "0", path: included, name: "initial" }], now: () => now };
    const policy = new ProjectPermissions(options);
    assert.equal(policy.canWrite(included), true);
    assert.equal(policy.canWrite(nested), true);
    assert.equal(policy.canWrite(other), false);
    assert.match(policy.projectId(other), /^[a-f0-9]{32}$/);
    policy.ensureManagementKey();
    const key = readFileSync(policy.adminKeyFile, "utf8").trim();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(policy.verifyManagementKey(key), true);
    assert.equal(policy.verifyManagementKey("x".repeat(64)), false);
    assert.equal(policy.setWriteAccess(other, true, "wrong").status, 403);
    const once = issueWriteCode(root, now);
    const onDisk = readFileSync(path.join(root, ".local", "project-write-code.json"), "utf8");
    assert.equal(onDisk.includes(once.code.replaceAll("-", "")), false);
    assert.equal(policy.setWriteAccess(other, true, once.code).ok, true);
    assert.equal(policy.setWriteAccess(other, true, once.code).status, 403, "codes are consumed once");
    assert.equal(policy.setWriteAccess(other, false).ok, true);
    const grant = policy.setWriteAccess(other, true, key);
    assert.equal(grant.ok, true);
    assert.equal(grant.expiresAt, now + WRITE_TTL_MS);
    assert.equal(policy.canWrite(other), true);
    const restarted = new ProjectPermissions(options);
    assert.equal(restarted.canWrite(other), true);
    assert.equal(restarted.setWriteAccess(included, false).ok, true);
    assert.equal(restarted.canWrite(included), false);
    assert.equal(restarted.canWrite(nested), false, "revoking a root must protect nested sessions");
    assert.equal(new ProjectPermissions(options).canWrite(included), false);
    assert.equal(restarted.setWriteAccess(nested, true, key).ok, true);
    assert.equal(restarted.canWrite(nested), true, "a new explicit nested grant is more specific");
    now += WRITE_TTL_MS + 1;
    assert.equal(restarted.canWrite(other), false);
    assert.equal(restarted.canWrite(nested), false);
    assert.equal(new ProjectPermissions(options).canWrite(other), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
