import type { ProviderPollResult } from "./providerAdapters.js";
import type { SessionAgentSignal, SessionPayload } from "../shared/types.js";

const MAX_PROVIDER_SIGNALS = 20;

export function applyProviderPollResults(
  sessions: Record<string, SessionPayload>,
  results: readonly ProviderPollResult[],
  now = Date.now(),
): boolean {
  let changed = false;
  for (const result of results) {
    for (const session of Object.values(sessions)) {
      if (!matchesTarget(session, result.config.target)) continue;
      const previous = session.agent_signals ?? [];
      const incoming = result.signals.map(signal => {
        const previousSignal = previous.find(item => signalKey(item) === signalKey(signal));
        if (previousSignal && sameSignalData(previousSignal, signal)) return previousSignal;
        return { ...signal, timestamp: signal.timestamp ?? now };
      });
      const next = [
        ...previous.filter(signal => !incoming.some(nextSignal => signalKey(signal) === signalKey(nextSignal))),
        ...incoming,
      ].slice(-MAX_PROVIDER_SIGNALS);
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      session.agent_signals = next;
      changed = true;
    }
  }
  return changed;
}

function matchesTarget(session: SessionPayload, target: string): boolean {
  const sessionType = (session.session_type || "").toLowerCase();
  return target.split(",").some(part => {
    const needle = part.trim().toLowerCase();
    return needle === "*" || (needle.length > 0 && sessionType.includes(needle));
  });
}

function signalKey(signal: Pick<SessionAgentSignal, "signal" | "source" | "scope" | "kind">): string {
  return `${signal.source ?? ""}:${signal.scope ?? ""}:${signal.kind ?? ""}:${signal.signal}`;
}

function sameSignalData(a: SessionAgentSignal, b: Partial<SessionAgentSignal>): boolean {
  return JSON.stringify({ ...a, timestamp: undefined }) === JSON.stringify({ ...b, timestamp: undefined });
}
