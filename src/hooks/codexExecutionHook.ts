import { readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureCodexHook } from "../agents/codexHooks.js";

// Passive metadata only: no network, stdout, hook decisions, prompts or tool output.
try {
  const chunks: Buffer[] = []; let length = 0;
  for (;;) { const buffer = Buffer.alloc(8192), size = readSync(0, buffer, 0, buffer.length, null); if (!size) break;
    length += size; if (length > 128 * 1024) throw new Error("hook input limit"); chunks.push(buffer.subarray(0, size)); }
  captureCodexHook({ root: process.env.SESSIONBAR_CODEX_HOOK_EVENTS_DIR || join(process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar"), "codex-hooks"),
    sessionsRoot: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"), raw: JSON.parse(Buffer.concat(chunks).toString("utf8")), now: Date.now() });
} catch { /* Optional observation must never block or alter a native tool call. */ }
