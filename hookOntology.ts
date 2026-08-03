export const HOOK_ONTOLOGY_VERSION = "2026-06-26";

export type HookMappingType =
  | "same_concept"
  | "subtype"
  | "same_neighborhood"
  | "weak"
  | "unavailable"
  | "unmapped";

export type HookMappingConfidence = "high" | "medium" | "low" | "none";

export interface CanonicalHookStage {
  category: string;
  direction: string;
  description: string;
}

export interface HookEventMapping {
  agent: string;
  raw_event: string;
  raw_event_normalized: string;
  canonical_stage_id: string;
  canonical_category: string;
  canonical_direction: string;
  mapping_type: HookMappingType;
  confidence: HookMappingConfidence;
  source_cache?: string;
  notes: string;
}

export const canonicalHookStages: Record<string, CanonicalHookStage> = {
  "agent.loop.after": stage("agent", "after", "Agent loop has completed a visible cycle."),
  "agent.loop.before": stage("agent", "before", "Agent loop is about to start a visible cycle."),
  "agent.response.after": stage("agent", "after", "Agent response has been emitted."),
  "agent.thought.after": stage("agent", "after", "Agent-visible thought event; not hidden model reasoning."),
  "agent.turn.stop": stage("agent", "after", "Current agent turn has stopped."),
  "agent.turn.stop_failed": stage("agent", "error", "Current agent turn failed to stop cleanly."),
  "context.compact.after": stage("context", "after", "Context compaction has completed."),
  "context.compact.before": stage("context", "before", "Context compaction or compression is about to run."),
  "context.snapshot": stage("context", "status", "Context snapshot or context-state observation."),
  "context.tree.before": stage("context", "before", "Provider-specific context tree boundary."),
  "file.changed": stage("workspace", "after", "Workspace file changed."),
  "file.edit.after": stage("workspace", "after", "File edit completed."),
  "file.read.before": stage("workspace", "before", "File read is about to occur."),
  "file.tab_edit.after": stage("workspace", "after", "Tab file edit completed."),
  "file.tab_read.before": stage("workspace", "before", "Tab file read is about to occur."),
  "instructions.loaded": stage("session", "after", "Session instructions have loaded."),
  "message.display": stage("message", "after", "Message is displayed."),
  "message.end": stage("message", "after", "Message boundary reached."),
  "message.update": stage("message", "status", "Message content or state updated."),
  "model.payload.before": stage("model", "before", "Provider payload is being prepared."),
  "model.request.after": stage("model", "after", "Model request completed."),
  "model.request.before": stage("model", "before", "Model request is about to be sent."),
  "notification.emit": stage("notification", "status", "Agent emitted a notification."),
  "permission.denied": stage("permission", "after", "Permission request was denied."),
  "permission.request": stage("permission", "before", "Permission is being requested."),
  "prompt.expand": stage("prompt", "after", "Prompt expansion completed."),
  "prompt.submit": stage("prompt", "before", "User prompt has been submitted."),
  "session.end": stage("session", "after", "Session ended."),
  "session.idle": stage("session", "status", "Session is idle."),
  "session.interrupt": stage("session", "error", "Session was interrupted."),
  "session.setup": stage("session", "before", "Session setup boundary."),
  "session.start": stage("session", "before", "Session started."),
  "session.status": stage("session", "status", "Session status changed or was observed."),
  "subagent.start": stage("subagent", "before", "Subagent started."),
  "subagent.stop": stage("subagent", "after", "Subagent stopped."),
  "tool.batch.after": stage("tool", "after", "Tool batch completed."),
  "tool.execute.after": stage("tool", "after", "Tool execution completed."),
  "tool.execute.before": stage("tool", "before", "Tool execution is about to start."),
  "tool.execute.failed": stage("tool", "error", "Tool execution failed."),
  "tool.selection.before": stage("tool", "before", "Tool selection is about to occur."),
  "unconfirmed": stage("unknown", "unknown", "Stable hook schema was not confirmed from cached sources."),
  "unmapped": stage("unknown", "unknown", "Raw event is not in the reviewed ontology."),
  "workspace.cwd_changed": stage("workspace", "after", "Working directory changed."),
  "workspace.open": stage("workspace", "before", "Workspace opened."),
};

const agentEvents: Record<string, readonly string[]> = {
  "Claude Code": [
    "CwdChanged",
    "FileChanged",
    "InstructionsLoaded",
    "MessageDisplay",
    "Notification",
    "PermissionDenied",
    "PermissionRequest",
    "PostCompact",
    "PostToolBatch",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Setup",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "UserPromptExpansion",
    "UserPromptSubmit",
  ],
  "Codex CLI": [
    "PermissionRequest",
    "PostCompact",
    "PostToolUse",
    "PreCompact",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
  ],
  "Codex App": [
    "PermissionRequest",
    "PostCompact",
    "PostToolUse",
    "PreCompact",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
  ],
  "Factory Droid": [
    "Notification",
    "PostToolUse",
    "PreCompact",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "SubagentStop",
    "UserPromptSubmit",
  ],
  "Kimi Code CLI": [
    "Interrupt",
    "Notification",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
  ],
  "Gemini CLI": [
    "AfterAgent",
    "AfterModel",
    "AfterTool",
    "BeforeAgent",
    "BeforeModel",
    "BeforeTool",
    "BeforeToolSelection",
    "Notification",
    "PreCompress",
    "SessionEnd",
    "SessionStart",
  ],
  "GitHub Copilot": [
    "postToolUse",
    "preToolUse",
    "sessionEnd",
    "sessionStart",
    "userPromptSubmitted",
  ],
  Cursor: [
    "afterAgentResponse",
    "afterAgentThought",
    "afterFileEdit",
    "afterMCPExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "beforeReadFile",
    "beforeShellExecution",
    "beforeSubmitPrompt",
    "beforeTabFileRead",
    "postToolUse",
    "postToolUseFailure",
    "preCompact",
    "preToolUse",
    "sessionEnd",
    "sessionStart",
    "stop",
    "subagentStart",
    "subagentStop",
    "workspaceOpen",
  ],
  OpenCode: [
    "message.updated",
    "permission.asked",
    "session.idle",
    "session.status",
    "tool.execute.after",
    "tool.execute.before",
  ],
  Pi: [
    "before_agent_start",
    "before_provider_payload",
    "before_provider_request",
    "context",
    "message_end",
    "session_before_compact",
    "session_before_tree",
    "tool_call",
    "tool_result",
  ],
  Antigravity: [],
};

const sourceCaches: Record<string, string> = {
  "Claude Code": "/tmp/sessionbar-claude-hooks.html",
  "Codex CLI": "/tmp/sessionbar-codex-hooks.html",
  "Codex App": "/tmp/sessionbar-codex-hooks.html",
  "Factory Droid": "/tmp/sessionbar-factory-reference-hooks.md; /tmp/sessionbar-factory-hooks-guide.md; /tmp/sessionbar-factory-hooks-format.md",
  "Kimi Code CLI": "/tmp/sessionbar-kimi-hooks.md",
  "Gemini CLI": "/tmp/sessionbar-gemini-hooks-index.md",
  "GitHub Copilot": "/tmp/sessionbar-copilot-hooks.html",
  Cursor: "/tmp/sessionbar-cursor-hooks.html",
  OpenCode: "/tmp/sessionbar-opencode-plugins.html",
  Pi: "/tmp/sessionbar-pi-hooks.md",
  Antigravity: "/tmp/sessionbar-antigravity-hooks.html; /tmp/sessionbar-antigravity-hooks-decoded.html; /tmp/sessionbar-antigravity-chunk.js",
};

const agentAliases: Record<string, string> = {
  Claude: "Claude Code",
  Codex: "Codex CLI",
  Gemini: "Gemini CLI",
  Copilot: "GitHub Copilot",
  "Pi Agent": "Pi",
};

export const hookEventMappings: HookEventMapping[] = Object.entries(agentEvents).flatMap(([agent, events]) => {
  if (events.length === 0) {
    return [buildMapping(agent, "__UNCONFIRMED__", "unconfirmed", "unavailable", "none", "Cached source did not expose a stable event schema.")];
  }
  return events.map((rawEvent) => buildKnownMapping(agent, rawEvent));
});

export function mapHookEvent(agent: string, rawEvent: string): HookEventMapping {
  const ontologyAgent = agentAliases[agent] ?? agent;

  if (agentEvents[ontologyAgent]?.length === 0) {
    return buildMapping(agent, rawEvent, "unconfirmed", "unavailable", "none", "Cached source did not expose a stable event schema.", ontologyAgent);
  }

  const mapping = hookEventMappings.find((candidate) =>
    candidate.agent === ontologyAgent &&
    candidate.raw_event_normalized === rawEvent.toLowerCase()
  );

  if (mapping) return { ...mapping, agent };
  return buildMapping(agent, rawEvent, "unmapped", "unmapped", "none", `No reviewed hook ontology mapping exists for ${agent}:${rawEvent}.`, ontologyAgent);
}

function buildKnownMapping(agent: string, rawEvent: string): HookEventMapping {
  const rule = mappingRule(rawEvent);
  return buildMapping(agent, rawEvent, rule.stage, rule.mappingType, rule.confidence, rule.notes);
}

function buildMapping(
  agent: string,
  rawEvent: string,
  canonicalStageId: string,
  mappingType: HookMappingType,
  confidence: HookMappingConfidence,
  notes = "",
  sourceAgent = agent,
): HookEventMapping {
  const meta = canonicalHookStages[canonicalStageId] ?? canonicalHookStages.unmapped;
  return {
    agent,
    raw_event: rawEvent,
    raw_event_normalized: rawEvent.toLowerCase(),
    canonical_stage_id: canonicalStageId,
    canonical_category: meta.category,
    canonical_direction: meta.direction,
    mapping_type: mappingType,
    confidence,
    source_cache: sourceCaches[sourceAgent],
    notes,
  };
}

function mappingRule(rawEvent: string): {
  stage: string;
  mappingType: HookMappingType;
  confidence: HookMappingConfidence;
  notes?: string;
} {
  switch (rawEvent) {
    case "SessionStart":
    case "sessionStart":
      return same("session.start");
    case "SessionEnd":
    case "sessionEnd":
      return same("session.end");
    case "Setup":
      return same("session.setup");
    case "InstructionsLoaded":
      return same("instructions.loaded");
    case "UserPromptSubmit":
    case "userPromptSubmitted":
      return same("prompt.submit");
    case "beforeSubmitPrompt":
      return same("prompt.submit", "Cursor names this as before prompt submission.");
    case "UserPromptExpansion":
      return same("prompt.expand");
    case "MessageDisplay":
      return same("message.display");
    case "message.updated":
      return same("message.update", "OpenCode plugin event bus update signal.");
    case "message_end":
      return same("message.end", "Pi message boundary signal.");
    case "PreToolUse":
    case "preToolUse":
    case "BeforeTool":
    case "tool.execute.before":
    case "tool_call":
      return same("tool.execute.before");
    case "beforeShellExecution":
      return subtype("tool.execute.before", "Tool subtype: shell execution.");
    case "beforeMCPExecution":
      return subtype("tool.execute.before", "Tool subtype: MCP execution.");
    case "PostToolUse":
    case "postToolUse":
    case "AfterTool":
    case "tool.execute.after":
    case "tool_result":
      return same("tool.execute.after");
    case "afterShellExecution":
      return subtype("tool.execute.after", "Tool subtype: shell execution.");
    case "afterMCPExecution":
      return subtype("tool.execute.after", "Tool subtype: MCP execution.");
    case "PostToolUseFailure":
    case "postToolUseFailure":
      return same("tool.execute.failed");
    case "PostToolBatch":
      return subtype("tool.batch.after", "Batch-level tool completion boundary.");
    case "BeforeToolSelection":
      return same("tool.selection.before");
    case "PermissionRequest":
    case "permission.asked":
      return same("permission.request");
    case "PermissionDenied":
      return same("permission.denied");
    case "PreCompact":
    case "preCompact":
    case "PreCompress":
    case "session_before_compact":
      return same("context.compact.before", "Different expression for the same context compaction/compression boundary.");
    case "PostCompact":
      return same("context.compact.after");
    case "session_before_tree":
      return weak("context.tree.before", "Pi-specific tree/session boundary; keep separate until payload semantics are clearer.");
    case "context":
      return neighborhood("context.snapshot", "Pi context signal is useful state input, not necessarily a lifecycle transition.");
    case "Stop":
    case "stop":
      return same("agent.turn.stop", "End of current agent turn/response, not necessarily whole session end.");
    case "StopFailure":
      return same("agent.turn.stop_failed");
    case "Interrupt":
      return same("session.interrupt");
    case "Notification":
      return same("notification.emit");
    case "SubagentStart":
    case "subagentStart":
      return same("subagent.start");
    case "SubagentStop":
    case "subagentStop":
      return same("subagent.stop");
    case "CwdChanged":
      return same("workspace.cwd_changed");
    case "FileChanged":
      return same("file.changed");
    case "BeforeAgent":
    case "before_agent_start":
      return same("agent.loop.before");
    case "AfterAgent":
      return same("agent.loop.after");
    case "BeforeModel":
    case "before_provider_request":
      return same("model.request.before");
    case "AfterModel":
      return same("model.request.after");
    case "before_provider_payload":
      return subtype("model.payload.before", "Provider payload construction boundary before request.");
    case "beforeReadFile":
      return subtype("file.read.before", "IDE file read boundary, adjacent to tool/file access but not generic tool execution.");
    case "beforeTabFileRead":
      return subtype("file.tab_read.before", "IDE tab file read boundary.");
    case "afterFileEdit":
      return subtype("file.edit.after", "IDE file edit boundary.");
    case "afterTabFileEdit":
      return subtype("file.tab_edit.after", "IDE tab file edit boundary.");
    case "afterAgentResponse":
      return same("agent.response.after");
    case "afterAgentThought":
      return neighborhood("agent.thought.after", "Cursor-visible thought event; do not infer hidden model reasoning.");
    case "workspaceOpen":
      return same("workspace.open");
    case "session.idle":
      return same("session.idle");
    case "session.status":
      return same("session.status");
    default:
      return weak("unmapped", `No mapping rule exists for raw event ${rawEvent}.`);
  }
}

function same(stageId: string, notes = "") {
  return { stage: stageId, mappingType: "same_concept" as const, confidence: "high" as const, notes };
}

function subtype(stageId: string, notes = "") {
  return { stage: stageId, mappingType: "subtype" as const, confidence: "high" as const, notes };
}

function neighborhood(stageId: string, notes = "") {
  return { stage: stageId, mappingType: "same_neighborhood" as const, confidence: "medium" as const, notes };
}

function weak(stageId: string, notes = "") {
  return { stage: stageId, mappingType: "weak" as const, confidence: "low" as const, notes };
}

function stage(category: string, direction: string, description: string): CanonicalHookStage {
  return { category, direction, description };
}
