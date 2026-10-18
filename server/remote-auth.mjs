import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PAIRING_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 24 * 60 * 60_000;

const pairingPath = (root) => path.join(root, ".local", "remote-pairing.json");
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function issuePairingCode(root, now = Date.now()) {
  const code = randomBytes(12).toString("hex").toUpperCase();
  const location = pairingPath(root);
  mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
  writeFileSync(location, JSON.stringify({ digest: hash(code), expiresAt: now + PAIRING_TTL_MS }), { mode: 0o600 });
  return { code: code.match(/.{1,6}/g).join("-"), expiresAt: now + PAIRING_TTL_MS };
}

export function consumePairingCode(root, input, now = Date.now()) {
  if (typeof input !== "string") return false;
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-F0-9]{24}$/.test(code)) return false;
  const location = pairingPath(root);
  if (!existsSync(location)) return false;
  let record;
  try { record = JSON.parse(readFileSync(location, "utf8")); } catch { return false; }
  if (typeof record.digest !== "string" || !/^[0-9a-f]{64}$/.test(record.digest)) return false;
  if (record.expiresAt <= now) {
    unlinkSync(location);
    return false;
  }
  if (!timingSafeEqual(Buffer.from(hash(code), "hex"), Buffer.from(record.digest, "hex"))) return false;
  unlinkSync(location);
  return true;
}

export class RemoteSessions {
  constructor({ now = () => Date.now(), maxSessions = 5 } = {}) {
    this.now = now;
    this.maxSessions = maxSessions;
    this.entries = new Map();
  }
  issue() {
    this.cleanup();
    if (this.entries.size >= this.maxSessions) this.entries.delete(this.entries.keys().next().value);
    const token = randomBytes(32).toString("base64url");
    this.entries.set(hash(token), this.now() + SESSION_TTL_MS);
    return token;
  }
  verify(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const key = hash(token);
    const expiresAt = this.entries.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }
  revoke(token) {
    if (typeof token === "string") this.entries.delete(hash(token));
  }
  cleanup() {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= this.now()) this.entries.delete(key);
    }
  }
}
