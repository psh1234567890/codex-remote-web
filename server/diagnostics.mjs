import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Local-only app-server failures. Never record prompts, API bearer credentials,
// or full paths. The .local directory is intentionally ignored by Git.
export function scrubRpcMessage(input) {
  return String(input ?? "unknown failure")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|[a-f0-9]{64})/gi, "[redacted-secret]")
    .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s"',;]+/g, "[local-path]")
    .replace(/[\r\n\t\u0000-\u001f]+/g, " ")
    .slice(0, 500);
}

export function recordCodexError(root, stage, error, now = new Date()) {
  const id = randomBytes(5).toString("hex");
  try {
    const directory = path.join(root, ".local");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, "codex-error-diagnostics.jsonl");
    let currentBytes = 0;
    try { currentBytes = statSync(destination).size; } catch {}
    // Preserve at most one recent log window without unbounded local growth.
    if (currentBytes > 128 * 1024) writeFileSync(destination, "", { mode: 0o600 });
    appendFileSync(destination, JSON.stringify({
      time: now.toISOString(),
      id,
      stage: String(stage ?? "unknown").slice(0, 48),
      upstream: scrubRpcMessage(error?.message),
    }) + "\n", { mode: 0o600 });
  } catch {
    // Failure to write a diagnostic must never alter authorization or routing.
  }
  return id;
}
