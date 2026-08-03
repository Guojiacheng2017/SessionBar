import type { SessionPayload } from "./types.js";

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

function preferredHookCandidate(candidates: SessionPayload[]): SessionPayload | undefined {
  return candidates.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
}

function enrichHookSession(hook: SessionPayload, discovery: SessionPayload): void {
  if (discovery.task_name && discovery.task_name !== "Ready") {
    hook.task_name = discovery.task_name;
  }
  if (discovery.activity_tail?.length) {
    hook.activity_tail = discovery.activity_tail;
  }
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
    const hook = preferredHookCandidate(Object.values(sessions).filter(session =>
      isHookBackedCodex(session) && sameProject(session, discovery)
    ));

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
