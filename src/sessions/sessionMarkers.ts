import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";

export interface PrunedSessionMarker {
  file: string;
  sessionId: string;
  ageMs: number;
}

export interface PruneSessionMarkerOptions {
  now?: number;
  maxAgeMs: number;
}

export function markerScopeSuffix(file: string): string {
  const scopeKey = file.replace(/^sessionbar-id-/, "");
  return createHash("md5").update(scopeKey).digest("hex").slice(0, 8);
}

export function scopedSessionId(sid: string, file: string): string {
  const suffix = markerScopeSuffix(file);
  const sep = sid.indexOf("__");
  const raw = sep === -1 ? sid : sid.slice(0, sep);
  const project = sep === -1 ? "" : sid.slice(sep);
  return raw.endsWith(`-${suffix}`) ? sid : `${raw}-${suffix}${project}`;
}

export function markerMatchesSession(storedSid: string, file: string, sessionId: string): boolean {
  return storedSid === sessionId || scopedSessionId(storedSid, file) === sessionId;
}

export function removeSessionMarkerFiles(sessionDir: string, sessionId: string): string[] {
  const removed: string[] = [];
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter(file => file.startsWith("sessionbar-id-"));
  } catch {
    return removed;
  }

  for (const file of files) {
    const path = join(sessionDir, file);
    let storedSid = "";
    try {
      storedSid = readFileSync(path, "utf-8").trim();
    } catch {
      continue;
    }
    if (!markerMatchesSession(storedSid, file, sessionId)) continue;
    try {
      unlinkSync(path);
      removed.push(file);
    } catch {
      // If another process already removed it, recovery still won't see it.
    }
  }
  return removed;
}

export function pruneSessionMarkerFiles(
  sessionDir: string,
  opts: PruneSessionMarkerOptions,
): { removed: PrunedSessionMarker[] } {
  const removed: PrunedSessionMarker[] = [];
  const now = opts.now ?? Date.now();
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter(file => file.startsWith("sessionbar-id-"));
  } catch {
    return { removed };
  }

  for (const file of files) {
    const path = join(sessionDir, file);
    let sessionId = "";
    let ageMs = 0;
    try {
      sessionId = readFileSync(path, "utf-8").trim();
      ageMs = now - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs <= opts.maxAgeMs) continue;
    try {
      unlinkSync(path);
      removed.push({ file, sessionId, ageMs });
    } catch {
      // Another process may have ended the session and removed the marker first.
    }
  }
  return { removed };
}
