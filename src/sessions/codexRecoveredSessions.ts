import type { SessionPayload } from "../shared/types.js";
import { codexBackgroundService } from "../shared/codexServices.js";

export function codexSessionNativeId(sessionId: string): string | undefined {
  return /^(?:codex-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-[0-9a-f]{8})?$/i
    .exec(sessionId.split("__", 1)[0]!)?.[1]?.toLowerCase();
}

/** Old marker files alone do not prove a session is still open.
 * Fresh reports remain visible, including unnamed or transient native threads. */
export function visibleCodexSessions(
  sessions: readonly SessionPayload[],
  evidence: { primaryIds: ReadonlySet<string>; subagentIds: ReadonlySet<string> },
  pendingRecovery: ReadonlySet<string> = new Set(),
): SessionPayload[] {
  return sessions.filter(session => {
    if (session.origin === "remote" || session.session_type.toLowerCase() !== "codex") return true;
    const id = codexSessionNativeId(session.session_id);
    const service = codexBackgroundService(session.session_service);
    const internalService = session.session_kind === "background" && (codexBackgroundService(session.session_source)
      || service && service !== "composer_predictions");
    // Older native APIs label internal services as generic subagents, too.
    if (id && evidence.subagentIds.has(id) && !internalService) return false;
    return !pendingRecovery.has(session.session_id) || !!id && evidence.primaryIds.has(id);
  });
}
