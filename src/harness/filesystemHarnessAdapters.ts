import { posix, win32 } from "node:path";

export interface HarnessPathContext {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface FilesystemHarnessArtifact {
  id: string;
  harness: string;
  contract: "session_snapshot" | "session_registry" | "event_log" | "usage_log";
  readMode: "snapshot" | "append";
  roots: string[];
  depth: number;
  platform: NodeJS.Platform;
  acceptsRelativePath: (relativePath: string) => boolean;
}

export function appDataRoot(appDirectory: string, context: HarnessPathContext): string {
  if (context.platform === "win32") {
    return win32.join(context.env.APPDATA || win32.join(context.home, "AppData", "Roaming"), appDirectory);
  }
  if (context.platform === "darwin") {
    return posix.join(context.home, "Library", "Application Support", appDirectory);
  }
  return posix.join(context.env.XDG_CONFIG_HOME || posix.join(context.home, ".config"), appDirectory);
}

export function filesystemHarnessArtifacts(context: HarnessPathContext): FilesystemHarnessArtifact[] {
  const path = context.platform === "win32" ? win32 : posix;
  const claudeData = appDataRoot("Claude-3p", context);
  const workbuddy = path.join(context.home, ".workbuddy");
  return [
    {
      id: "kimi-code-session-index",
      harness: "kimi-code",
      contract: "session_registry",
      readMode: "snapshot",
      roots: [context.env.KIMI_CODE_HOME || path.join(context.home, ".kimi-code")],
      depth: 3,
      platform: context.platform,
      acceptsRelativePath: relative => relative === "session_index.jsonl" || /^sessions\/[^/]+\/[^/]+\/state\.json$/.test(relative),
    },
    {
      id: "dsh-projection-checkpoint",
      harness: "dsh",
      contract: "session_snapshot",
      readMode: "snapshot",
      roots: [path.join(context.env.SESSIONBAR_DSH_HOME || path.join(context.home, ".dsh"), "storages", "session_projcache", "sessions")],
      depth: 0,
      platform: context.platform,
      acceptsRelativePath: relative => /^[\w-]+\.json$/.test(relative),
    },
    {
      id: "codex-session-jsonl",
      harness: "codex",
      contract: "event_log",
      readMode: "append",
      roots: [path.join(context.home, ".codex", "sessions")],
      depth: 8,
      platform: context.platform,
      acceptsRelativePath: relative => relative.endsWith(".jsonl"),
    },
    {
      id: "claude-desktop-session-snapshot",
      harness: "claude-desktop",
      contract: "session_snapshot",
      readMode: "snapshot",
      roots: [
        path.join(claudeData, "local-agent-mode-sessions"),
        path.join(claudeData, "claude-code-sessions"),
      ],
      depth: 6,
      platform: context.platform,
      acceptsRelativePath: relative => /(?:^|\/)local_[^/]+\.json$/.test(relative),
    },
    {
      id: "workbuddy-desktop-live-registry",
      harness: "workbuddy-desktop",
      contract: "session_registry",
      readMode: "snapshot",
      roots: [path.join(workbuddy, "sessions")],
      depth: 1,
      platform: context.platform,
      acceptsRelativePath: relative => !relative.includes("/") && relative.endsWith(".json"),
    },
    {
      id: "workbuddy-desktop-database",
      harness: "workbuddy-desktop",
      contract: "session_registry",
      readMode: "snapshot",
      roots: [workbuddy],
      depth: 0,
      platform: context.platform,
      acceptsRelativePath: relative => relative === "workbuddy.db" || relative === "workbuddy.db-wal",
    },
    {
      id: "workbuddy-desktop-session-index",
      harness: "workbuddy-desktop",
      contract: "session_registry",
      readMode: "snapshot",
      roots: [path.join(workbuddy, "app")],
      depth: 1,
      platform: context.platform,
      acceptsRelativePath: relative => relative === "sessions.json",
    },
    {
      id: "workbuddy-desktop-transcript",
      harness: "workbuddy-desktop",
      contract: "event_log",
      readMode: "append",
      roots: [path.join(workbuddy, "projects")],
      depth: 3,
      platform: context.platform,
      acceptsRelativePath: relative => relative.endsWith(".jsonl"),
    },
  ];
}

export function matchesHarnessArtifact(artifact: FilesystemHarnessArtifact, file: string): boolean {
  const path = artifact.platform === "win32" ? win32 : posix;
  return artifact.roots.some(root => {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    if (!relative || relative === "." || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false;
    const depth = relative.split("/").length - 1;
    return depth <= artifact.depth && artifact.acceptsRelativePath(relative);
  });
}
