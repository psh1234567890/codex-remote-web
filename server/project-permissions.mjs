import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isAllowedWorkspace } from "./security.mjs";

export const WRITE_TTL_MS = 2 * 60 * 60_000;
export const WRITE_CODE_TTL_MS = 10 * 60_000;

function canonical(directory) {
  if (typeof directory !== "string" || !directory) return null;
  try {
    const resolved = realpathSync(directory);
    if (!statSync(resolved).isDirectory()) return null;
    return resolved;
  } catch { return null; }
}
const fileKey = (directory) => process.platform === "win32" ? directory.toLowerCase() : directory;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function issueWriteCode(root, now = Date.now()) {
  const code = randomBytes(12).toString("hex").toUpperCase();
  const destination = path.join(root, ".local", "project-write-code.json");
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, JSON.stringify({
    hash: hash(code),
    expiresAt: now + WRITE_CODE_TTL_MS,
  }), { mode: 0o600 });
  return { code: code.match(/.{1,6}/g).join("-"), expiresAt: now + WRITE_CODE_TTL_MS };
}

// On-disk admin key is never sent to a browser, exposed by an API, or committed.
// It is supplied manually when granting new filesystem-write privileges.
export class ProjectPermissions {
  constructor({ root, baseWorkspaces, now = () => Date.now() } = {}) {
    if (!root || !Array.isArray(baseWorkspaces)) throw new Error("Missing project permissions configuration");
    this.root = root;
    this.baseWorkspaces = baseWorkspaces;
    this.now = now;
    this.overrides = new Map();
    this.policyFile = path.join(root, ".local", "project-permissions.json");
    this.adminKeyFile = path.join(root, ".local", "project-management-key");
    this.writeCodeFile = path.join(root, ".local", "project-write-code.json");
    try {
      const records = JSON.parse(readFileSync(this.policyFile, "utf8"));
      if (Array.isArray(records)) {
        for (const item of records) {
          const directory = canonical(item?.path);
          if (!directory || item.path !== directory) continue;
          if (item.enabled === false) this.overrides.set(fileKey(directory), { path: directory, enabled: false });
          else if (item.enabled === true && Number.isSafeInteger(item.expiresAt) && item.expiresAt > this.now()) {
            this.overrides.set(fileKey(directory), { path: directory, enabled: true, expiresAt: item.expiresAt });
          }
        }
      }
    } catch { /* First run or unavailable policy: fail back to configured defaults. */ }
  }

  projectId(directory) {
    if (typeof directory !== "string" || !directory.trim()) return null;
    // Preserve old Codex projects in the UI even if their original working
    // directory was moved or deleted. IDs are metadata, not authorization.
    const resolved = canonical(directory) ?? path.resolve(directory);
    return hash(fileKey(resolved)).slice(0, 32);
  }

  isAvailable(directory) {
    return canonical(directory) !== null;
  }

  canWrite(directory) {
    const resolved = canonical(directory);
    if (!resolved) return false;
    // A revoked project root also protects nested Codex sessions.
    // More specific explicit grants take precedence.
    let override = null;
    for (const entry of this.overrides.values()) {
      const relative = path.relative(entry.path, resolved);
      if (relative === "" ||
          (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) {
        if (!override || entry.path.length > override.path.length) override = entry;
      }
    }
    if (override) {
      if (!override.enabled) return false;
      return override.expiresAt > this.now();
    }
    return isAllowedWorkspace(resolved, this.baseWorkspaces);
  }

  accessUntil(directory) {
    const resolved = canonical(directory);
    const entry = resolved && this.overrides.get(fileKey(resolved));
    return entry?.enabled && entry.expiresAt > this.now() ? entry.expiresAt : null;
  }

  verifyManagementKey(input) {
    if (typeof input !== "string" || !/^[0-9a-f]{64}$/i.test(input)) return false;
    let key;
    try { key = readFileSync(this.adminKeyFile, "utf8").trim(); } catch { return false; }
    if (!/^[0-9a-f]{64}$/i.test(key)) return false;
    return timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(input, "hex"));
  }

  consumeWriteCode(input) {
    if (typeof input !== "string") return false;
    const normalized = input.replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-F0-9]{24}$/.test(normalized)) return false;
    let record;
    try { record = JSON.parse(readFileSync(this.writeCodeFile, "utf8")); }
    catch { return false; }
    if (!/^[a-f0-9]{64}$/.test(record.hash ?? "")) return false;
    if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= this.now()) return false;
    if (!timingSafeEqual(Buffer.from(hash(normalized), "hex"), Buffer.from(record.hash, "hex"))) return false;
    unlinkSync(this.writeCodeFile);
    return true;
  }

  ensureManagementKey() {
    mkdirSync(path.dirname(this.adminKeyFile), { recursive: true, mode: 0o700 });
    if (!existsSync(this.adminKeyFile)) {
      try {
        writeFileSync(this.adminKeyFile, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    return this.adminKeyFile;
  }

  setWriteAccess(directory, enabled, managementKey) {
    const resolved = canonical(directory);
    if (!resolved) return { ok: false, error: "Unknown or missing project directory", status: 404 };
    if (enabled !== true && enabled !== false) return { ok: false, error: "Invalid access setting", status: 400 };
    if (enabled && !this.verifyManagementKey(managementKey) && !this.consumeWriteCode(managementKey)) {
      return { ok: false, error: "PC 관리 키 또는 일회용 코드가 올바르지 않습니다", status: 403 };
    }
    const entry = enabled
      ? { path: resolved, enabled: true, expiresAt: this.now() + WRITE_TTL_MS }
      : { path: resolved, enabled: false };
    this.overrides.set(fileKey(resolved), entry);
    this.persist();
    return { ok: true, writable: this.canWrite(resolved), expiresAt: this.accessUntil(resolved) };
  }

  persist() {
    mkdirSync(path.dirname(this.policyFile), { recursive: true, mode: 0o700 });
    const items = [...this.overrides.values()].filter((entry) => !entry.enabled || entry.expiresAt > this.now());
    const staging = this.policyFile + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(staging, JSON.stringify(items, null, 2), { mode: 0o600 });
    // Rename in the same directory for an atomic update on supported filesystems.
    // Avoid following any caller-controlled filesystem paths.
    renameSync(staging, this.policyFile);
  }
}
