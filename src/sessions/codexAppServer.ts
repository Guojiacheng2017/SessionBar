import { spawn } from "node:child_process";
import { basename } from "node:path";
import { relayChildEnv, trackRelayChild } from "../runtime/networkRuntime.js";
import { codexBackgroundService, codexHasSubagentSource, codexNativeSource } from "../shared/codexServices.js";

export interface CodexThread {
  id: string;
  sessionId: string;
  name?: string | null;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  source: unknown;
  modelProvider: string;
  path?: string | null;
  gitInfo?: { branch?: string | null; sha?: string | null } | null;
  [key: string]: unknown;
}

export interface CodexThreadMetadata {
  threadId: string;
  isSubagent?: boolean;
  sessionName?: string;
  sessionPath?: string;
  project: string;
  projectPath: string;
  updatedAt: number;
  source?: string;
  modelProvider?: string;
  preview?: string;
  gitBranch?: string;
  gitSha?: string;
}

export function parseCodexThreadListResponse(output: string, requestId = 2): CodexThread[] {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message?.id === requestId && Array.isArray(message?.result?.data)) {
        return message.result.data;
      }
    } catch {
      // app-server diagnostics may share the stream; ignore non-protocol lines.
    }
  }
  return [];
}

export function codexThreadMetadata(thread: CodexThread): CodexThreadMetadata {
  const sessionName = typeof thread.name === "string" ? thread.name.trim() : "";
  const source = codexNativeSource(thread.threadSource, thread.thread_source, thread.source);
  const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
  const gitBranch = thread.gitInfo?.branch?.trim() || undefined;
  const gitSha = thread.gitInfo?.sha?.trim() || undefined;
  return {
    threadId: thread.id,
    isSubagent: !codexBackgroundService(source) && codexHasSubagentSource(thread.threadSource, thread.thread_source, thread.source),
    sessionName: sessionName || undefined,
    sessionPath: typeof thread.path === "string" && thread.path.trim() ? thread.path : undefined,
    project: basename(thread.cwd),
    projectPath: thread.cwd,
    updatedAt: thread.updatedAt * 1000,
    source,
    modelProvider: thread.modelProvider || undefined,
    preview: preview || undefined,
    gitBranch,
    gitSha,
  };
}

export function recentCodexThreadPaths(
  threads: readonly CodexThread[],
  now: number,
  windowMs: number,
): string[] {
  const cutoff = now - Math.max(0, windowMs);
  const paths = new Set<string>();
  for (const thread of threads) {
    const updatedAt = Number(thread.updatedAt) * 1000;
    if (!Number.isFinite(updatedAt) || updatedAt < cutoff) continue;
    if (typeof thread.path !== "string" || !thread.path.trim().endsWith(".jsonl")) continue;
    paths.add(thread.path.trim());
  }
  return [...paths];
}

export interface ReadCodexThreadsOptions {
  command?: string;
  limit?: number;
  timeoutMs?: number;
}

/** Read Codex's state DB through its protocol instead of reverse-engineering SQLite. */
export function readCodexThreads(options: ReadCodexThreadsOptions = {}): Promise<CodexThread[]> {
  const command = options.command || process.env.SESSIONBAR_CODEX_BIN || "codex";
  const limit = options.limit ?? 100;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise(resolve => {
    const child = spawn(command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: relayChildEnv(),
    });
    const untrack = trackRelayChild(child);
    let output = "";
    let initialized = false;
    let settled = false;
    const finish = (threads: CodexThread[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.stdout.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
      untrack();
      resolve(threads);
    };
    const inspectLines = () => {
      for (const line of output.split(/\r?\n/)) {
        try {
          const message = JSON.parse(line);
          if (!initialized && message?.id === 1 && message?.result) {
            initialized = true;
            child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
            child.stdin.write(`${JSON.stringify({
              id: 2,
              method: "thread/list",
              params: { limit, sortKey: "updated_at", useStateDbOnly: true },
            })}\n`);
          }
          if (message?.id === 2) finish(parseCodexThreadListResponse(output));
        } catch {
          // Wait for a complete JSON line.
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      inspectLines();
    });
    child.once("error", () => finish([]));
    child.once("exit", () => finish(parseCodexThreadListResponse(output)));
    const timer = setTimeout(() => finish(parseCodexThreadListResponse(output)), timeoutMs);

    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "sessionbar", version: "1" } },
    })}\n`);
  });
}
