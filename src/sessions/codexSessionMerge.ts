import type { SessionPayload } from "../shared/types.js";
import type { CodexThreadMetadata } from "./codexAppServer.js";

const CODEX_JSONL_ID = /^codex-[0-9a-f-]{36}__/i;

function isCodexSession(session: SessionPayload): boolean {
  return session.session_type.toLowerCase() === "codex";
}

function isJsonlDiscovery(session: SessionPayload): boolean {
  return session.source === "codex_jsonl" || CODEX_JSONL_ID.test(session.session_id);
}

function isHookBackedCodex(session: SessionPayload): boolean {
  return isCodexSession(session) && (session.source === "hook" || !isJsonlDiscovery(session));
}

function sameProject(a: SessionPayload, b: SessionPayload): boolean {
  if (a.project_path && b.project_path) return a.project_path === b.project_path;
  return (a.project || "") === (b.project || "");
}

function sessionUuid(sessionId: string): string | undefined {
  return sessionId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase();
}

function matchingHookCandidate(sessions: Record<string, SessionPayload>, discovery: SessionPayload): SessionPayload | undefined {
  const candidates = Object.values(sessions).filter(session =>
    isHookBackedCodex(session) && sameProject(session, discovery)
  );
  const discoveryUuid = sessionUuid(discovery.session_id);
  if (discoveryUuid) {
    const exact = candidates.find(candidate => sessionUuid(candidate.session_id) === discoveryUuid);
    if (exact) return exact;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
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
      delete sessions[discovery.session_id];
      continue;
    }

    sessions[discovery.session_id] = discovery;
    standaloneDiscoveryIds.add(discovery.session_id);
  }

  for (const id of Object.keys(sessions)) {
    const session = sessions[id];
    if (isCodexSession(session) && isJsonlDiscovery(session) && !standaloneDiscoveryIds.has(id)) {
      delete sessions[id];
    }
  }
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

    session.session_name = item.sessionName;
    session.project = item.project || session.project;
    session.project_path = item.projectPath || session.project_path;
    session.session_source = item.source;
    session.model_provider = item.modelProvider;
    session.session_preview = item.preview;
    session.git_branch = item.gitBranch;
    session.git_sha = item.gitSha;
    session.session_updated_at = item.updatedAt;
  }
}
