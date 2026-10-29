import type { SessionPayload } from "../shared/types.js";
import type { CodexThreadMetadata } from "./codexAppServer.js";
import { codexSessionNativeId } from "./codexRecoveredSessions.js";

const CODEX_JSONL_ID = /^codex-[0-9a-f-]{36}__/i;

function isCodexSession(session: SessionPayload): boolean {
  return session.session_type.toLowerCase() === "codex";
}

function isJsonlDiscovery(session: SessionPayload): boolean {
  return session.source === "codex_jsonl" || (!session.source && CODEX_JSONL_ID.test(session.session_id));
}

function isHookBackedCodex(session: SessionPayload): boolean {
  return isCodexSession(session) && (session.source === "hook" || !isJsonlDiscovery(session));
}

function sessionUuid(sessionId: string): string | undefined {
  return codexSessionNativeId(sessionId);
}

function preserveMetadata(target: SessionPayload, previous: SessionPayload): void {
  for (const key of ["session_name", "session_service", "project", "project_path", "session_source", "model_provider", "session_preview", "git_branch", "git_sha"] as const) {
    if (!target[key]?.trim()) target[key] = previous[key];
  }
  target.session_updated_at ??= previous.session_updated_at;
  target.session_kind ??= previous.session_kind;
}

function matchingHookCandidate(sessions: Record<string, SessionPayload>, discovery: SessionPayload): SessionPayload | undefined {
  const candidates = Object.values(sessions).filter(isHookBackedCodex);
  const discoveryUuid = sessionUuid(discovery.session_id);
  if (discoveryUuid) {
    const exact = candidates.find(candidate => sessionUuid(candidate.session_id) === discoveryUuid);
    if (exact) return exact;
  }
  return undefined;
}

function enrichHookSession(hook: SessionPayload, discovery: SessionPayload): void {
  hook.status = discovery.status;
  hook.task_name = discovery.task_name || hook.task_name;
  hook.activity_tail = discovery.activity_tail ?? hook.activity_tail;
  hook.timestamp = Math.max(hook.timestamp || 0, discovery.timestamp || 0);
  hook.context_percent = discovery.context_percent ?? hook.context_percent;
  hook.tokens = discovery.tokens ?? hook.tokens;
  hook.turns = discovery.turns ?? hook.turns;
  hook.progress = discovery.progress ?? hook.progress;
  hook.project = hook.project || discovery.project;
  hook.project_path = hook.project_path || discovery.project_path;
}

export function mergeCodexDiscovery(
  sessions: Record<string, SessionPayload>,
  discoveries: readonly SessionPayload[],
): void {
  const standaloneDiscoveryIds = new Set<string>();

  for (const discovery of discoveries) {
    const hook = matchingHookCandidate(sessions, discovery);

    if (hook) {
      enrichHookSession(hook, discovery);
      preserveMetadata(hook, discovery);
      for (const previous of Object.values(sessions)) {
        if (previous === hook || !isCodexSession(previous) || sessionUuid(previous.session_id) !== sessionUuid(discovery.session_id)) continue;
        preserveMetadata(hook, previous);
        delete sessions[previous.session_id];
      }
      continue;
    }

    const next = { ...discovery };
    const uuid = sessionUuid(discovery.session_id);
    for (const previous of Object.values(sessions)) {
      if (!isCodexSession(previous) || !isJsonlDiscovery(previous)) continue;
      if (previous.session_id !== discovery.session_id && (!uuid || sessionUuid(previous.session_id) !== uuid)) continue;
      preserveMetadata(next, previous);
      delete sessions[previous.session_id];
    }
    sessions[discovery.session_id] = next;
    standaloneDiscoveryIds.add(discovery.session_id);
  }

  for (const id of Object.keys(sessions)) {
    const session = sessions[id];
    if (isCodexSession(session) && isJsonlDiscovery(session) && !standaloneDiscoveryIds.has(id)) {
      delete sessions[id];
    }
  }
}

export function mergeCodexHookSession(
  sessions: Record<string, SessionPayload>,
  hook: SessionPayload,
): void {
  const hookUuid = sessionUuid(hook.session_id);
  for (const previous of Object.values(sessions)) {
    if (!isCodexSession(previous)) continue;
    if (previous.session_id !== hook.session_id && (!hookUuid || sessionUuid(previous.session_id) !== hookUuid)) continue;
    preserveMetadata(hook, previous);
    if (isJsonlDiscovery(previous)) enrichHookSession(hook, previous);
    delete sessions[previous.session_id];
  }
  sessions[hook.session_id] = hook;
}

function codexThreadId(sessionId: string): string | undefined {
  return sessionUuid(sessionId);
}

export function mergeCodexThreadMetadata(
  sessions: Record<string, SessionPayload>,
  metadata: readonly CodexThreadMetadata[],
): void {
  const byThreadId = new Map(metadata.map(item => [item.threadId.toLowerCase(), item]));
  for (const session of Object.values(sessions)) {
    if (!isCodexSession(session)) continue;
    const threadId = codexThreadId(session.session_id);
    if (!threadId) continue;
    const item = byThreadId.get(threadId);
    if (!item) continue;

    session.session_name = item.sessionName?.trim() || session.session_name;
    session.project = item.project || session.project;
    session.project_path = item.projectPath || session.project_path;
    session.session_source = item.source || session.session_source;
    session.model_provider = item.modelProvider || session.model_provider;
    session.session_preview = item.preview || session.session_preview;
    session.git_branch = item.gitBranch || session.git_branch;
    session.git_sha = item.gitSha || session.git_sha;
    session.session_updated_at = item.updatedAt ?? session.session_updated_at;
  }
}
