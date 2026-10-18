import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";

export function loadAccessToken(projectRoot, env = process.env) {
  if (env.REMOTE_WEB_ACCESS_TOKEN !== undefined) {
    const token = env.REMOTE_WEB_ACCESS_TOKEN.trim();
    if (token.length < 32) throw new Error("REMOTE_WEB_ACCESS_TOKEN must contain at least 32 characters");
    return token;
  }
  const dir = path.join(projectRoot, ".local");
  const file = path.join(dir, "access-token");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token.length < 32) throw new Error("Existing .local/access-token is too short");
    return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token + "\n", { flag: "wx", mode: 0o600 });
  return token;
}

export function tokenMatches(candidate, secret) {
  if (typeof candidate !== "string" || candidate.length > 512) return false;
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(secret).digest();
  return timingSafeEqual(left, right);
}

export function parseBearer(value) {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? "");
  return match ? match[1] : null;
}

export function configuredWorkspaces(root, env = process.env) {
  const raw = env.CODEX_WORKSPACES?.trim();
  const candidates = raw ? raw.split(path.delimiter).map((value) => value.trim()).filter(Boolean) : [root];
  const found = new Map();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) throw new Error(`Workspace does not exist: ${resolved}`);
    const real = realpathSync(resolved);
    found.set(real.toLowerCase(), { id: String(found.size), path: real, name: path.basename(real) });
  }
  return [...found.values()];
}

export function isAllowedWorkspace(candidate, workspaces) {
  if (typeof candidate !== "string" || !candidate) return false;
  try {
    const resolved = realpathSync(candidate);
    return workspaces.some((workspace) => {
      const relative = path.relative(workspace.path, resolved);
      return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
    });
  } catch {
    return false;
  }
}

export function isValidThreadId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{5,150}$/.test(value);
}

export function isTrustedHost(header, extraHosts = []) {
  try {
    const hostname = new URL("http://" + header).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || extraHosts.includes(hostname);
  } catch {
    return false;
  }
}
