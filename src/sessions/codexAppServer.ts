import { spawn } from "node:child_process";
import { basename } from "node:path";

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
  sessionName?: string;
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

export type CodexDailyUsage = Record<string, number>;

export function parseCodexUsageResponse(output: string, requestId = 2): CodexDailyUsage {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message?.id !== requestId || !Array.isArray(message?.result?.dailyUsageBuckets)) continue;
      const usage: CodexDailyUsage = {};
      for (const bucket of message.result.dailyUsageBuckets) {
        const day = typeof bucket?.startDate === "string" ? bucket.startDate : undefined;
        const tokens = Number(bucket?.tokens);
        if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(tokens) && tokens >= 0) usage[day] = tokens;
      }
      return usage;
    } catch {
      // Ignore diagnostics and unrelated protocol notifications.
    }
  }
  return {};
}

export function codexThreadMetadata(thread: CodexThread): CodexThreadMetadata {
  const sessionName = typeof thread.name === "string" ? thread.name.trim() : "";
  const source = typeof thread.source === "string" ? thread.source : undefined;
  const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
  const gitBranch = thread.gitInfo?.branch?.trim() || undefined;
  const gitSha = thread.gitInfo?.sha?.trim() || undefined;
  return {
    threadId: thread.id,
    sessionName: sessionName || undefined,
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
      env: process.env,
    });
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
              params: { limit, useStateDbOnly: true },
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

/** Read the same account-wide daily token buckets shown by Codex's Usage UI. */
export function readCodexUsage(options: Pick<ReadCodexThreadsOptions, "command" | "timeoutMs"> = {}): Promise<CodexDailyUsage> {
  const command = options.command || process.env.SESSIONBAR_CODEX_BIN || "codex";
  const timeoutMs = options.timeoutMs ?? 8_000;
  return new Promise(resolve => {
    const child = spawn(command, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
    let output = "";
    let initialized = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.stdout.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(parseCodexUsageResponse(output));
    };
    const inspectLines = () => {
      for (const line of output.split(/\r?\n/)) {
        try {
          const message = JSON.parse(line);
          if (!initialized && message?.id === 1 && message?.result) {
            initialized = true;
            child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 2, method: "account/usage/read", params: null })}\n`);
          }
          if (message?.id === 2) finish();
        } catch { /* wait for a complete line */ }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; inspectLines(); });
    child.once("error", finish);
    child.once("exit", finish);
    const timer = setTimeout(finish, timeoutMs);
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "sessionbar", version: "1" } } })}\n`);
  });
}
