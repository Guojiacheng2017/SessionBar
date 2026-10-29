import type { Avatar } from "../shared/agentContract.js";
import { layoutWorkflowGraph, type FlowGraph } from "../shared/workflowGraph.js";
import { escapeHtml } from "./webComponents.js";

function statusTone(status: string): string {
  status = status.toLowerCase().replaceAll(" ", "_");
  if (["working", "running", "in_progress", "active"].includes(status)) return "working";
  if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
  if (["blocked", "waiting", "pending"].includes(status)) return "blocked";
  if (["failed", "error"].includes(status)) return "failed";
  return "neutral";
}
function scopeId(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
  return `wf-${hash.toString(36)}`;
}

export type AvatarRenderer = (agent: { agent_id: string; avatar: Avatar }) => string;

export function workflowGraphMarkup(graph: FlowGraph, key: string, renderAvatar?: AvatarRenderer, compact = false): string {
  const nativeWait = graph.evidence === "native_wait" || graph.evidence === "native_wait_result";
  const title = graph.evidence === "native_wait" ? "Native wait DAG" : nativeWait ? "Returned wait results" : graph.kind === "agents" ? "Agent topology" : compact ? "Task DAG" : "Workflow graph";
  const explanation = graph.kind === "agents" ? "Arrows show observed parent → child relationships. Select an agent for details."
    : compact ? "Only reported dependencies are connected." : "Arrows show reported connections. Select a step to inspect its connections.";
  const notices = graph.notes.map(note => `<p class="workflow-note">${escapeHtml(note)}</p>`).join("");
  if (!graph.nodes.length) return `<section class="workflow-section"><h4>${title}</h4><p class="workflow-note">The source reported an empty graph.</p>${notices}</section>`;
  const layout = layoutWorkflowGraph(graph, compact), scope = scopeId(key);
  const labels = new Map(graph.nodes.map(node => [node.id, node.label]));
  const connections = graph.edges.map(edge => `${labels.get(edge.from)} → ${labels.get(edge.to)}${edge.label ? ` · ${edge.label}` : ""}`);
  const paths = layout.edges.map((edge, i) => `<path data-flow-edge="${i}" class="workflow-edge${edge.loop ? " workflow-edge-loop" : ""}" d="${edge.path}" marker-end="url(#${scope}-arrow)"><title>${escapeHtml(connections[i]!)}</title></path>`).join("");
  const cards = layout.nodes.map((node, i) => {
    const agent = node.agentId ? ` data-agent-id="${escapeHtml(node.agentId)}" data-agent-session="${escapeHtml(node.sessionId || "")}"` : "";
    const avatar = graph.kind === "agents" && renderAvatar ? `<span class="workflow-node-avatar">${renderAvatar({ agent_id: node.id, avatar: node.avatar ?? { kind: "generated", seed: node.id } })}</span>` : "";
    return `<button type="button" class="workflow-node${graph.kind === "agents" ? " workflow-node-agent" : ""}" data-flow-node="${escapeHtml(node.id)}" data-flow-tone="${statusTone(node.status)}" data-flow-index="${i}"${agent} style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px" aria-pressed="false" title="${escapeHtml(`${node.label} · ${node.status}`)}">${avatar}<span class="workflow-node-content"><span class="workflow-node-subtitle">${escapeHtml(node.subtitle)}</span><strong>${escapeHtml(node.label)}</strong><span class="workflow-node-state"><i aria-hidden="true"></i>${escapeHtml(node.status)}</span></span></button>`;
  }).join("");
  const templates = graph.nodes.map((node, i) => `<template data-flow-inspector="${i}"><strong>${escapeHtml(node.label)}</strong><p>${escapeHtml(node.subtitle)} · ${escapeHtml(node.status)}</p><ul>${graph.edges.flatMap(edge => edge.from === node.id ? [`<li>To ${escapeHtml(labels.get(edge.to)!)}${edge.label ? ` · ${escapeHtml(edge.label)}` : ""}</li>`] : edge.to === node.id ? [`<li>From ${escapeHtml(labels.get(edge.from)!)}${edge.label ? ` · ${escapeHtml(edge.label)}` : ""}</li>`] : []).join("") || "<li>No reported connections.</li>"}</ul></template>`).join("");
  const counts = new Map<string, number>();
  for (const node of graph.nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  return `<section class="workflow-section${compact ? " execution-dag" : ""}"><div class="workflow-heading"><h4>${title}</h4><span>${graph.nodes.length} ${nativeWait ? "nodes" : graph.kind === "agents" ? "agents" : "steps"} · ${graph.edges.length} connections</span></div>${compact ? "" : `<p class="workflow-caption">${explanation}</p>`}${notices}<sessionbar-flow ${compact ? 'data-flow-fit="" ' : ""}data-flow-key="${escapeHtml(key)}" data-flow-width="${layout.width}" data-flow-height="${layout.height}"><div class="workflow-toolbar" aria-label="Graph controls"><span class="workflow-direction">${graph.evidence === "native_wait" ? "Target agent → wait" : nativeWait ? "Returned result references" : compact ? "Reported dependencies" : "Left → right"}</span><button type="button" data-flow-action="out" aria-label="Zoom out">−</button><output data-flow-zoom aria-live="polite">100%</output><button type="button" data-flow-action="in" aria-label="Zoom in">+</button><button type="button" data-flow-action="fit">Fit</button><button type="button" data-flow-action="reset" aria-label="Reset graph zoom">1:1</button></div><div class="workflow-viewport" tabindex="0" role="region" aria-label="${title}. Scroll to explore; use the zoom controls to resize."><div class="workflow-sizer" style="width:${layout.width}px;height:${layout.height}px"><div class="workflow-canvas" style="width:${layout.width}px;height:${layout.height}px"><svg class="workflow-connectors" width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs><marker id="${scope}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>${paths}</svg>${cards}</div></div></div><div class="workflow-status-summary">${[...counts].map(([status, count]) => `<span data-flow-tone="${statusTone(status)}"><i aria-hidden="true"></i>${count} ${escapeHtml(status)}</span>`).join("")}</div><div class="workflow-inspector" data-flow-selection hidden></div>${templates}<details class="workflow-connections"><summary>Connections (${graph.edges.length})${layout.edges.some(edge => edge.loop) ? " · dashed lines mark loops" : ""}</summary><ul>${connections.map(label => `<li>${escapeHtml(label)}</li>`).join("") || "<li>No connections reported.</li>"}</ul></details></sessionbar-flow></section>`;
}
