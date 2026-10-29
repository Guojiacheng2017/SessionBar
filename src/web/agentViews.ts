import { avatarRoster, type AgentDetail, type AgentSummary, type AvatarItem, type Coverage, type Page, type Snapshot } from "../shared/agentContract.js";
import type { SessionPayload } from "../shared/types.js";
import { escapeHtml } from "./webComponents.js";
import { reportedWorkflowGraph } from "../shared/workflowGraph.js";
import { workflowGraphMarkup, workflowHistoryMarkup } from "./workflowViews.js";

export type AgentTab = "overview" | "conversation" | "workflow";
export type AgentResource = "conversation" | "workflow";
export interface AgentRoster { coverage: Coverage; items: AvatarItem[] }
// A navigation bucket, never a canonical project identity.
export const UNASSIGNED_PROJECT_KEY = "unassigned-sessions";

export function agentProjectKey(session: SessionPayload, snapshot: Snapshot | null): string {
  if (/^[\\/]+$/.test(session.project_path?.trim() || "")) return UNASSIGNED_PROJECT_KEY;
  const project = snapshot?.sessions.find(item => item.session_id === session.session_id)?.project_id;
  if (project) return `agent-project:${project}`;
  const source = session.origin === "remote" ? session.harness_instance_id || session.session_id : "local";
  const rawPath = session.project_path;
  const path = rawPath?.trim() ? rawPath.replace(/\/+$/, "") || "/" : null;
  return path ? JSON.stringify([source, path]) : UNASSIGNED_PROJECT_KEY;
}

export function sessionAgentRoster(snapshot: Snapshot | null, sessionId: string): AgentRoster | null {
  if (!snapshot?.sessions.some(session => session.session_id === sessionId)) return null;
  return avatarRoster(snapshot, { kind: "session", session_id: sessionId });
}

export function projectAgentRoster(snapshot: Snapshot | null, sessions: readonly SessionPayload[]): AgentRoster | null {
  if (!snapshot || sessions.length === 0) return null;
  const projectId = snapshot.sessions.find(item => item.session_id === sessions[0]!.session_id)?.project_id;
  if (projectId) return avatarRoster(snapshot, { kind: "project", project_id: projectId });
  const rosters = sessions.map(session => sessionAgentRoster(snapshot, session.session_id));
  if (rosters.some(roster => !roster)) return null;
  const available = rosters as AgentRoster[];
  const coverage = available.every(item => item.coverage === "complete") ? "complete"
    : available.every(item => item.coverage === "unsupported") ? "unsupported"
    : available.every(item => item.coverage === "unknown") ? "unknown" : "partial";
  const items = [...new Map(available.flatMap(item => item.items).map(item => [item.agent_id, item])).values()];
  items.sort((a, b) => a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0);
  return { coverage, items };
}

const failedAvatarAssets = new Map<string, number>();
const AVATAR_RETRY_MS = 30_000;

/** Only the fallback is drawn here; source-selected artwork stays in an image. */
function generatedAvatarMarkup(agent: Pick<AvatarItem, "agent_id" | "avatar">): string {
  const seed = agent.avatar?.kind === "generated" ? agent.avatar.seed : agent.agent_id;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  const hue = hash % 360;
  let cells = "";
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (!((hash >>> ((y * 3 + x) % 30)) & 1)) continue;
    cells += `<rect x="${4 + x * 4}" y="${4 + y * 4}" width="4" height="4"></rect>`;
    if (x !== 2) cells += `<rect x="${4 + (4 - x) * 4}" y="${4 + y * 4}" width="4" height="4"></rect>`;
  }
  return `<svg class="agent-avatar-art" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="8" fill="hsl(${hue} 35% 90%)"></rect><g fill="hsl(${hue} 48% 36%)">${cells}</g></svg>`;
}

export function agentAvatarMarkup(agent: Pick<AvatarItem, "agent_id" | "avatar">): string {
  const fallback = generatedAvatarMarkup(agent);
  if (agent.avatar?.kind !== "asset") return fallback;
  const assetId = agent.avatar.asset_id;
  if (typeof assetId !== "string" || !assetId.trim() || assetId.length > 256) return fallback;
  const retryAt = failedAvatarAssets.get(assetId);
  if (retryAt !== undefined) {
    if (retryAt > Date.now()) return fallback;
    failedAvatarAssets.delete(assetId);
  }
  const url = (theme: "light" | "dark") => escapeHtml(`/agents/avatar?${new URLSearchParams({ asset_id: assetId, theme })}`);
  return `<span class="agent-avatar-art agent-avatar-native" data-agent-avatar="" aria-hidden="true"><span class="agent-avatar-fallback">${fallback}</span><picture class="agent-avatar-picture"><source media="(prefers-color-scheme: dark)" srcset="${url("dark")}"><img data-agent-avatar-image="" data-agent-avatar-id="${escapeHtml(assetId)}" src="${url("light")}" alt="" draggable="false"></picture></span>`;
}

function settleAgentAvatar(image: HTMLImageElement): void {
  const avatar = image.closest<HTMLElement>("[data-agent-avatar]");
  if (!avatar || !image.complete || !image.currentSrc) return;
  const loaded = image.naturalWidth > 0;
  avatar.dataset.agentAvatarState = loaded ? "loaded" : "failed";
  const assetId = image.dataset.agentAvatarId;
  if (!assetId) return;
  if (loaded) failedAvatarAssets.delete(assetId);
  else {
    // A missing source should not be fetched again on every session-age tick.
    if (failedAvatarAssets.size >= 256) failedAvatarAssets.delete(failedAvatarAssets.keys().next().value!);
    failedAvatarAssets.set(assetId, Date.now() + AVATAR_RETRY_MS);
  }
}

/** Covers images that completed from the browser cache before a load callback. */
export function syncAgentAvatars(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>("img[data-agent-avatar-image]").forEach(settleAgentAvatar);
}

/** Install before rendering. Both async and cached failures keep the same SVG fallback. */
export function installAgentAvatarFallbacks(root: Document): () => void {
  const settled = (event: Event) => {
    if (event.target instanceof HTMLImageElement && event.target.hasAttribute("data-agent-avatar-image")) settleAgentAvatar(event.target);
  };
  root.addEventListener("load", settled, true);
  root.addEventListener("error", settled, true);
  const theme = root.defaultView?.matchMedia("(prefers-color-scheme: dark)");
  let frame: number | undefined;
  const changed = () => {
    root.querySelectorAll<HTMLElement>("[data-agent-avatar]").forEach(avatar => avatar.removeAttribute("data-agent-avatar-state"));
    if (frame !== undefined) root.defaultView?.cancelAnimationFrame(frame);
    frame = root.defaultView?.requestAnimationFrame(() => { frame = undefined; syncAgentAvatars(root); });
  };
  theme?.addEventListener("change", changed);
  syncAgentAvatars(root);
  return () => {
    root.removeEventListener("load", settled, true);
    root.removeEventListener("error", settled, true);
    theme?.removeEventListener("change", changed);
    if (frame !== undefined) root.defaultView?.cancelAnimationFrame(frame);
  };
}

/** Image load state is local DOM state, not a reason to replace the roster. */
export function withoutAgentAvatarLoadState(markup: string): string {
  return markup.replace(/ data-agent-avatar-state="(?:loaded|failed)"/g, "");
}

export function agentRosterMarkup(roster: AgentRoster, key: string, selectedId: string | null, expanded = false): string {
  const empty = { complete: "No sub-agents", partial: "No sub-agents observed", unknown: "Sub-agents not observed", unsupported: "Sub-agents not supported" }[roster.coverage];
  if (!roster.items.length) return `<div class="agent-roster agent-roster-empty" data-agent-coverage="${roster.coverage}">${empty}</div>`;
  const shown = expanded ? roster.items : roster.items.slice(0, 6);
  const buttons = shown.map(item => {
    const state = ["completed", "cancelled", "failed"].includes(item.lifecycle) ? item.lifecycle : item.status;
    const label = `${item.name} · ${state}${item.provider_id ? ` · ${item.provider_id}` : ""}`;
    return `<button type="button" class="agent-avatar-button" data-agent-id="${escapeHtml(item.agent_id)}" data-agent-session="${escapeHtml(item.session_id)}" data-agent-status="${escapeHtml(state)}" aria-pressed="${item.agent_id === selectedId}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${agentAvatarMarkup(item)}${item.provider_id ? `<span class="agent-provider-badge" aria-hidden="true">${escapeHtml(item.provider_id.slice(0, 1).toUpperCase())}</span>` : ""}<span class="agent-avatar-status" aria-hidden="true"></span></button>`;
  }).join("");
  const toggle = roster.items.length > 6 ? `<button type="button" class="agent-roster-more" data-agent-expand="${escapeHtml(key)}" aria-expanded="${expanded}" aria-label="${expanded ? "Show fewer sub-agents" : `Show ${roster.items.length - 6} more sub-agents`}">${expanded ? "Less" : `+${roster.items.length - 6}`}</button>` : "";
  return `<div class="agent-roster" data-agent-coverage="${roster.coverage}" aria-label="Sub-agents"><span class="agent-roster-items">${buttons}${toggle}</span>${roster.coverage === "partial" ? '<span class="agent-roster-note" title="Only observed sub-agents are shown">Partial</span>' : ""}</div>`;
}

export function agentTabsMarkup(tab: AgentTab): string {
  return `<span class="detail-tabs agent-detail-tabs" aria-label="Agent detail views">${(["overview", "conversation", "workflow"] as const).map(value => `<button type="button" data-agent-tab="${value}" class="detail-tab${value === tab ? " detail-tab-active" : ""}" aria-pressed="${value === tab}">${value[0]!.toUpperCase() + value.slice(1)}</button>`).join("")}</span>`;
}

function availabilityMarkup(state: string, resource: string): string {
  const description = state === "unsupported" ? `This source does not provide ${resource}.`
    : state === "redacted" ? `${resource[0]!.toUpperCase() + resource.slice(1)} is hidden.`
    : `No ${resource} has been observed yet.`;
  return `<p class="agent-empty">${escapeHtml(description)}</p>`;
}

function paginationMarkup(resource: AgentResource, page: Page<unknown>, loading: boolean): string {
  return `${page.truncated_before ? '<p class="agent-retention-note">Earlier history is outside the retained window.</p>' : ""}${page.next_cursor ? `<button type="button" class="agent-action" data-agent-more="${resource}"${loading ? " disabled" : ""}>${loading ? "Loading…" : "Load more"}</button>` : ""}`;
}

export interface AgentDetailView {
  agent: AgentSummary;
  snapshot: Snapshot;
  detail: AgentDetail | null;
  loading: boolean;
  error: string | null;
}

export function agentDetailMarkup(view: AgentDetailView, tab: AgentTab): string {
  const { agent, snapshot, detail, loading, error } = view;
  const session = snapshot.sessions.find(item => item.session_id === agent.identity.session_id);
  const parent = snapshot.agents.find(item => item.agent_id === agent.parent_agent_id);
  const header = `<div class="agent-detail-toolbar"><button type="button" class="agent-action" data-agent-back>← Session</button><span title="Details stay fixed while you read. Refresh for the latest activity.">As loaded</span><button type="button" class="agent-action" data-agent-refresh${loading ? " disabled" : ""}>Refresh</button></div><div class="agent-detail-identity">${agentAvatarMarkup({ agent_id: agent.agent_id, avatar: agent.avatar ?? { kind: "generated", seed: agent.agent_id } })}<div><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(session?.name || agent.identity.session_id)}</p></div></div>`;
  const message = error ? `<p class="agent-detail-error" role="alert">${escapeHtml(error)}</p>` : "";
  let body = "";
  if (tab === "overview") {
    const values = [
      ["Status", agent.status], ["Lifecycle", agent.lifecycle], ["Provider", agent.provider_id || "Unknown"],
      ["Parent", parent?.name || (agent.role === "primary" ? "Session primary" : "Not observed")],
      ["Agent ID", agent.identity.native_agent_id],
    ];
    body = `<dl class="agent-facts">${values.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value!)}</dd>`).join("")}</dl>`;
  } else if (!detail) {
    body = `<p class="agent-empty" role="status">${loading ? "Loading agent details…" : "Agent details are not available. Refresh to try again."}</p>`;
  } else if (tab === "conversation") {
    const page = detail.conversation;
    body = page.availability !== "available" ? availabilityMarkup(page.availability, "conversation")
      : `<div class="agent-conversation">${page.items.map(item => `<article class="agent-message" data-message-id="${escapeHtml(item.message_id)}"><div class="agent-message-label"><span>${escapeHtml(item.role)}</span>${item.content_state !== "complete" ? `<span>${escapeHtml(item.content_state)}</span>` : ""}</div><p>${item.content_state === "redacted" ? "Message hidden" : escapeHtml(item.text)}</p></article>`).join("") || '<p class="agent-empty">No messages in this retained view.</p>'}</div>${paginationMarkup("conversation", page, loading)}`;
  } else {
    const page = detail.workflow;
    const graph = detail.workflow_graph;
    const graphBody = graph.availability !== "available" ? availabilityMarkup(graph.availability, "a workflow graph")
      : workflowGraphMarkup(reportedWorkflowGraph({ nodes: graph.graph!.nodes.map(node => ({ id: node.node_id, label: node.label, status: node.status })), edges: graph.graph!.edges }), `agent:${agent.agent_id}`);
    const history = page.availability !== "available" ? availabilityMarkup(page.availability, "workflow history")
      : `${workflowHistoryMarkup(page.items.map(item => ({ id: item.event_id, stage: item.stage, label: item.label, occurredAt: item.occurred_at })), `agent:${agent.agent_id}`)}${paginationMarkup("workflow", page, loading)}`;
    body = `${graph.availability === "available" ? graphBody : `<section class="agent-detail-section"><h4>Workflow graph</h4>${graphBody}</section>`}<details class="workflow-history-disclosure"><summary>Observed events (${page.items.length})</summary>${history}</details>`;
  }
  return `${header}${message}${body}`;
}

/** Merge only the requested resource; the sibling page may be repeated. */
export function mergeAgentDetailPage(previous: AgentDetail, incoming: AgentDetail, resource: AgentResource): AgentDetail {
  if (previous.agent_id !== incoming.agent_id || previous.stream_id !== incoming.stream_id || previous.revision !== incoming.revision) throw new Error("Agent detail page belongs to a different view");
  const oldPage = previous[resource];
  const newPage = incoming[resource];
  if (oldPage.availability !== "available" || newPage.availability !== "available") throw new Error("Resource availability changed during pagination");
  if (!oldPage.next_cursor || newPage.next_cursor === oldPage.next_cursor) throw new Error("Pagination did not advance");
  const key = resource === "conversation" ? "message_id" : "event_id";
  const items = [...oldPage.items];
  const seen = new Map(items.map(item => [(item as unknown as Record<string, unknown>)[key], item]));
  for (const item of newPage.items) {
    const id = (item as unknown as Record<string, unknown>)[key];
    const duplicate = seen.get(id);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(item)) throw new Error("Conflicting item across pages");
      continue;
    }
    if (items.length && item.sequence <= items[items.length - 1]!.sequence) throw new Error("Out-of-order item across pages");
    items.push(item);
    seen.set(id, item);
  }
  return { ...previous, [resource]: { ...newPage, items, truncated_before: oldPage.truncated_before || newPage.truncated_before } };
}
