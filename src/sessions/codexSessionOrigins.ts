import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionPayload } from "../shared/types.js";
import { codexSessionNativeId } from "./codexRecoveredSessions.js";
import { codexBackgroundService, CODEX_USER_SOURCES } from "../shared/codexServices.js";

/** Native source or an unambiguous native log chain classifies a session; an absent name proves nothing. */
export function classifyCodexSession(session: SessionPayload, desktopOrigins: ReadonlyMap<string, string>): void {
  if (session.origin === "remote" || session.session_type.toLowerCase() !== "codex") return;
  const nativeId = codexSessionNativeId(session.session_id);
  // An explicit native user source is stronger than cached/log-derived classification.
  if (session.session_source && CODEX_USER_SOURCES.has(session.session_source)) {
    session.session_kind = "user";
    if (codexBackgroundService(session.session_service)) delete session.session_service;
    return;
  }
  const service = codexBackgroundService(session.session_source) ?? codexBackgroundService(session.session_service)
    ?? codexBackgroundService(nativeId ? desktopOrigins.get(nativeId) : undefined);
  if (service) {
    session.session_kind = "background";
    session.session_service = service;
  } else {
    session.session_kind ??= "unknown";
  }
}

/** Desktop's ephemeral MCP hosts are intentionally absent from its thread DB. */
export function parseCodexDesktopOrigins(text: string): Map<string, string> {
  const origins = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!/^\S+ info \[electron-message-handler\] mcp_extension_host_thread_(?:created|retired)\b/.test(line) || !/\bhostId=local(?:\s|$)/.test(line)) continue;
    const id = /\bthreadId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s|$)/i.exec(line)?.[1];
    if (id) origins.set(id.toLowerCase(), "mcp_extension_host");
  }
  return origins;
}

/** Bounded, cached metadata lookup; never creates sessions or retains log bodies. */
export function createCodexDesktopOriginsReader(base = join(homedir(), "Library", "Logs", "com.openai.codex")): (now?: number) => ReadonlyMap<string, string> {
  let lastRead = -Infinity;
  let origins = new Map<string, string>();
  const cache = new Map<string, { stamp: string; origins: Map<string, string> }>();
  return (now = Date.now()) => {
    if (now - lastRead < 30_000) return origins;
    lastRead = now;
    const files: Array<{ path: string; mtime: number; size: number }> = [];
    for (const offset of [0, 86_400_000]) {
      const day = new Date(now - offset);
      const dir = join(base, String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
      try {
        for (const entry of readdirSync(dir).filter(name => name.endsWith(".log"))) {
          const path = join(dir, entry), stat = statSync(path);
          if (stat.isFile()) files.push({ path, mtime: stat.mtimeMs, size: stat.size });
        }
      } catch { /* Optional desktop logs may not exist on this host. */ }
    }
    const selected = files.sort((a, b) => b.mtime - a.mtime).slice(0, 4);
    const next = new Map<string, string>();
    for (const file of selected) {
      const stamp = `${file.mtime}:${file.size}`;
      let parsed = cache.get(file.path);
      if (parsed?.stamp !== stamp) {
        let fd: number | undefined;
        try {
          fd = openSync(file.path, "r");
          const size = Math.min(file.size, 8 * 1024 * 1024);
          const buffer = Buffer.alloc(size);
          const count = readSync(fd, buffer, 0, size, file.size - size);
          parsed = { stamp, origins: parseCodexDesktopOrigins(buffer.toString("utf8", 0, count)) };
          cache.set(file.path, parsed);
        } catch { /* Keep the last successful metadata for a rotating file. */ }
        finally { if (fd !== undefined) closeSync(fd); }
      }
      for (const [id, source] of parsed?.origins ?? []) next.set(id, source);
    }
    for (const path of cache.keys()) if (!selected.some(file => file.path === path)) cache.delete(path);
    origins = new Map([...next].slice(-512));
    return origins;
  };
}
