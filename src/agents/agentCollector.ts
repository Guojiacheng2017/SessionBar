import type { SessionPayload } from "../shared/types.js";
import type { NativeExecutionEvent } from "../shared/executionTrace.js";
import {
  SCHEMA, assertSnapshot, type AgentSummary, type Availability, type Coverage,
  type GraphResource, type Message, type WorkflowEvent,
} from "../shared/agentContract.js";

export interface CollectedAgentDetail {
  execution?: { events: NativeExecutionEvent[]; truncated_before: boolean; notes?: string[]; closed_scopes?: string[]; initial_active_event_ids?: string[] };
  conversation: { availability: Availability; items: Message[]; truncated_before: boolean };
  workflow: { availability: Availability; items: WorkflowEvent[]; truncated_before: boolean };
  workflow_graph: GraphResource;
}

export interface CollectedAgents {
  agents: AgentSummary[];
  coverage: Record<string, Coverage>;
  details: Map<string, CollectedAgentDetail>;
}

export interface AgentCollector {
  collect(sessions: readonly SessionPayload[], now?: number): Promise<CollectedAgents>;
}

interface Source {
  sessionTypes: readonly string[];
  collector: AgentCollector;
}
interface Retained {
  result: CollectedAgents;
  scopes: Map<string, string>;
}
const scope = (session: SessionPayload): string => JSON.stringify([
  session.session_type.toLowerCase(), session.project_path ?? null,
  session.origin ?? "local", session.harness_instance_id ?? null,
]);

/** Each harness owns only its assigned local sessions. A failed adapter cannot
 * erase another harness's data or attach its transcript to a different session. */
export function createCompositeAgentCollector(sources: readonly Source[]): AgentCollector {
  const routes = new Map<string, number>();
  sources.forEach((source, index) => source.sessionTypes.forEach(type => {
    const key = type.toLowerCase();
    if (!key.trim() || routes.has(key)) throw new Error("Ambiguous agent collector routing");
    routes.set(key, index);
  }));
  const retained = new Map<number, Retained>();
  return {
    async collect(sessions, now = Date.now()) {
      const groups = sources.map(() => [] as SessionPayload[]);
      const output: CollectedAgents = { agents: [], coverage: {}, details: new Map() };
      for (const session of sessions) {
        output.coverage[session.session_id] = "unsupported";
        const route = session.origin === "remote" ? undefined : routes.get(session.session_type.toLowerCase());
        if (route !== undefined) groups[route]!.push(structuredClone(session));
      }
      const reads = await Promise.all(sources.map(async (source, index): Promise<CollectedAgents | null> => {
        const group = groups[index]!;
        if (!group.length) { retained.delete(index); return null; }
        const scopes = new Map(group.map(session => [session.session_id, scope(session)]));
        try {
          const result = structuredClone(await source.collector.collect(structuredClone(group), now));
          assertSnapshot({
            schema_version: SCHEMA, kind: "snapshot", stream_id: "collector-validation", revision: 0,
            projects: [], sessions: group.map(session => ({
              session_id: session.session_id, project_id: null, name: session.session_id,
              agents_coverage: result.coverage[session.session_id] ?? "unknown",
            })), agents: result.agents,
          });
          const ids = new Set(result.agents.map(agent => agent.agent_id));
          result.details = new Map([...result.details].filter(([id]) => ids.has(id)));
          retained.set(index, { result: structuredClone(result), scopes });
          return result;
        } catch {
          const previous = retained.get(index);
          const agents = previous?.result.agents.filter(agent => {
            const id = agent.identity.session_id;
            return scopes.has(id) && previous.scopes.get(id) === scopes.get(id);
          }).map(agent => ({ ...structuredClone(agent), status: "unknown" as const })) ?? [];
          const ids = new Set(agents.map(agent => agent.agent_id));
          const result: CollectedAgents = {
            agents, coverage: Object.fromEntries(group.map(session => [session.session_id,
              agents.some(agent => agent.identity.session_id === session.session_id) ? "partial" : "unknown"])),
            details: new Map([...(previous?.result.details ?? [])].filter(([id]) => ids.has(id))),
          };
          // Removed or reassigned sessions cannot resurrect from an old cache.
          retained.set(index, { result: structuredClone(result), scopes });
          return result;
        }
      }));
      reads.forEach((result, index) => {
        if (!result) return;
        for (const session of groups[index]!) output.coverage[session.session_id] = result.coverage[session.session_id] ?? "unknown";
        output.agents.push(...result.agents);
        for (const [id, detail] of result.details) output.details.set(id, detail);
      });
      output.agents.sort((a, b) => a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0);
      return structuredClone(output);
    },
  };
}
