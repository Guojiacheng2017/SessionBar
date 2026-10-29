import type { NativeExecutionEvent, NativePhase, PhaseState } from "../shared/executionTrace.js";

type Json = Record<string, unknown>;
export interface ExecutionRow { value: Json; sequence: number }
const object = (v: unknown): Json | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
const text = (v: unknown, max = 256): string | undefined => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const timestamp = (v: unknown): number | null => {
  const n = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15 ? n : null;
};
const state = (v: unknown): PhaseState | undefined => ["pending", "in_progress", "completed", "failed", "cancelled", "deleted"].includes(String(v)) ? v as PhaseState : undefined;
const toolName = (v: unknown): string => text(v)?.split(/[./]/).at(-1) || "Tool";
const nativeUuid = (v: unknown): string | undefined => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : undefined;
const parsed = (v: unknown): Json | undefined => {
  if (typeof v !== "string" || v.length > 64 * 1024) return object(v);
  try { return object(JSON.parse(v)); } catch { return undefined; }
};
function plan(value: unknown): NativePhase[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const phases: NativePhase[] = [];
  for (const [index, item] of value.entries()) {
    const p = object(item), label = text(p?.step ?? p?.content ?? p?.subject), status = state(p?.status);
    if (!label || !status) return undefined;
    phases.push({ id: `plan:${index}:${label}`, label, state: status });
  }
  return phases;
}

/** Only public tool metadata and explicitly named native task fields leave the parser. */
export function codexExecutionEvents(rows: readonly ExecutionRow[], scope?: { nativeId: string; knownAgentStarts?: readonly NativeExecutionEvent[] }): NativeExecutionEvent[] {
  const events: NativeExecutionEvent[] = [], calls = new Map<string, { name: string; phases?: NativePhase[] }>();
  const agents = new Map<string, { callId: string; label: string; sequence: number; ended: boolean }>();
  for (const event of scope?.knownAgentStarts ?? []) if (event.kind === "agent.start" && event.target_native_id && event.call_id) {
    const previous = agents.get(event.target_native_id);
    if (!previous || previous.sequence < event.sequence) agents.set(event.target_native_id, { callId: event.call_id, label: event.label, sequence: event.sequence, ended: false });
  }
  for (const { value, sequence } of rows) {
    const p = object(value.payload); if (!p) continue;
    const type = String(p.type), id = text(p.call_id);
    const emit = (kind: NativeExecutionEvent["kind"], label: string, extra: Partial<NativeExecutionEvent> = {}) => events.push({
      event_id: `codex:${sequence}:${kind}`, sequence, at: timestamp(value.timestamp), kind, label, ...extra,
    });
    if (value.type === "response_item" && ["function_call", "custom_tool_call"].includes(type) && id) {
      const name = toolName(p.name);
      const phases = name === "update_plan" ? plan(parsed(p.arguments ?? p.input)?.plan) : undefined;
      calls.set(id, { name, phases }); emit("call.start", name, { call_id: id });
    } else if (value.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(type) && id) {
      const call = calls.get(id);
      const wrapperStatus = Array.isArray(p.output) ? object(p.output[0])?.text : undefined;
      const failed = typeof p.output === "string" && /^(?:error|failed|denied)\b/i.test(p.output.trim())
        || typeof wrapperStatus === "string" && /^Script failed\b/.test(wrapperStatus);
      emit("call.end", call?.name || "Tool", { call_id: id, outcome: failed ? "failed" : "completed" });
      if (call?.phases && typeof p.output === "string" && /^Plan updated\b/.test(p.output.trim())) emit("plan", "Plan updated", { phases: call.phases });
    } else if (value.type === "event_msg") {
      // These typed items are persisted by the native harness. Never inspect
      // arbitrary tool output/JavaScript to invent underlying tool operations.
      if (type === "item_completed") {
        const item = object(p.item), itemId = text(item?.id);
        if (!scope || p.thread_id !== scope.nativeId || !item || !itemId) continue;
        const start = timestamp(p.started_at_ms), end = timestamp(p.completed_at_ms);
        if (item.type === "CollabAgentToolCall" && item.sender_thread_id === scope.nativeId && item.status === "completed") {
          const targets = Array.isArray(item.receiver_thread_ids) ? [...new Set(item.receiver_thread_ids.flatMap(id => nativeUuid(id) ? [nativeUuid(id)!] : []))].slice(0, 128) : [];
          const states = object(item.agents_states);
          if (item.tool === "spawn_agent") for (const target of targets) if (target !== scope.nativeId) {
            const receiver = Array.isArray(item.receiver_agents) ? item.receiver_agents.map(object).find(r => nativeUuid(r?.thread_id) === target) : undefined;
            const label = text(receiver?.agent_nickname) || "Agent task";
            agents.set(target, { callId: itemId, label, sequence, ended: false });
            emit("agent.start", label, { at: end, call_id: itemId, target_native_id: target });
          }
          if (item.tool === "wait") {
            emit("call.start", "Native wait", { at: start, call_id: itemId });
            emit("call.end", "Native wait", { at: end, call_id: itemId, wait_result_native_ids: targets });
          }
          if (["wait", "close_agent"].includes(String(item.tool))) for (const target of targets) {
            const launch = agents.get(target), status = object(states?.[target]);
            if (launch && !launch.ended && launch.sequence <= sequence && status && (Object.hasOwn(status, "completed") || Object.hasOwn(status, "errored"))) {
              launch.ended = true;
              emit("agent.end", launch.label, { at: end, call_id: launch.callId, target_native_id: target, outcome: Object.hasOwn(status, "errored") ? "failed" : "completed" });
            }
          }
        }
        if (item.type === "CommandExecution" && ["completed", "failed", "declined"].includes(String(item.status))) {
          if (start !== null) emit("run.start", "Native command", { at: start, call_id: itemId });
          emit("run.end", "Native command", { at: end, call_id: itemId,
            outcome: item.status === "declined" ? "cancelled" : item.status === "failed" || typeof item.exit_code === "number" && item.exit_code !== 0 ? "failed" : "completed" });
        }
        const target = text(item.agent_thread_id, 128)?.toLowerCase();
        if (item.type === "SubAgentActivity" && target && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target) && target !== scope.nativeId) {
          if (item.kind === "started") {
            const label = text(item.agent_path)?.split("/").filter(Boolean).at(-1) || "Agent task";
            agents.set(target, { callId: itemId, label, sequence, ended: false });
            emit("agent.start", label, { at: start, call_id: itemId, target_native_id: target });
          } else if (item.kind === "completed") {
            const launch = agents.get(target);
            if (launch && !launch.ended && launch.sequence <= sequence) {
              launch.ended = true;
              emit("agent.end", launch.label, { at: end, call_id: launch.callId, target_native_id: target });
            } else if (!launch) emit("agent.end", "Agent task", { at: end, call_id: `end:${itemId}`, target_native_id: target });
          }
        }
      }
      if (type === "exec_command_begin" && id) emit("run.start", calls.get(id)?.name || "Command", { call_id: id });
      if (type === "exec_command_end" && id) emit("run.end", calls.get(id)?.name || "Command", { call_id: id, outcome: typeof p.exit_code === "number" && p.exit_code !== 0 ? "failed" : "completed" });
      const turn = text(p.turn_id ?? p.task_id);
      if (type === "task_started" && turn) emit("turn.start", "Turn", { call_id: turn });
      if (["task_complete", "turn_aborted"].includes(type) && turn) emit("turn.end", "Turn", { call_id: turn, outcome: type === "turn_aborted" ? "cancelled" : "completed" });
    }
  }
  return events.slice(-1024);
}

export function claudeExecutionEvents(rows: readonly ExecutionRow[], scope: { sessionId: string; primary: boolean; agentId?: string; knownAgentStarts?: readonly NativeExecutionEvent[] }): NativeExecutionEvent[] {
  const events: NativeExecutionEvent[] = [];
  const calls = new Map<string, { name: string; input?: Json; agentType?: string }>();
  const launched = new Map<string, { nativeId: string; label: string; ended: boolean }>();
  for (const event of scope.knownAgentStarts ?? []) if (event.kind === "agent.start" && event.call_id && event.target_native_id) {
    launched.set(event.call_id, { nativeId: event.target_native_id, label: event.label, ended: false });
  }
  for (const { value, sequence } of rows) {
    if (value.sessionId !== scope.sessionId || (scope.primary ? value.isSidechain === true : value.isSidechain !== true || value.agentId !== scope.agentId)
      || value.isMeta === true || value.isSynthetic === true || value.isCompactSummary === true || value.isVisible === false) continue;
    if (value.type === "queue-operation" && value.operation === "enqueue" && typeof value.content === "string" && value.content.trimStart().startsWith("<task-notification>")) {
      // Queue records are harness events. User/assistant copies of their XML
      // are deliberately ignored, and result bodies never leave this parser.
      const header = value.content.slice(0, 2048);
      const nativeId = /<task-id>([A-Za-z0-9_-]{1,128})<\/task-id>/.exec(header)?.[1];
      const callId = /<tool-use-id>([^<>\r\n]{1,256})<\/tool-use-id>/.exec(header)?.[1];
      const status = /<status>(completed|failed|stopped|cancelled|killed)<\/status>/.exec(header)?.[1];
      const launch = callId ? launched.get(callId) : undefined;
      if (launch && !launch.ended && launch.nativeId === nativeId && status) {
        launch.ended = true;
        const seq = sequence * 1024;
        events.push({ event_id: `claude:${seq}:agent.end`, sequence: seq, at: timestamp(value.timestamp), kind: "agent.end", label: launch.label,
          call_id: callId, target_native_id: nativeId, outcome: status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled" });
      }
      continue;
    }
    const message = object(value.message);
    if (!["assistant", "user"].includes(String(value.type)) || !Array.isArray(message?.content)) continue;
    for (const [index, part] of message.content.slice(0, 1000).entries()) {
      const p = object(part); if (!p) continue;
      const seq = sequence * 1024 + index;
      const emit = (kind: NativeExecutionEvent["kind"], label: string, extra: Partial<NativeExecutionEvent> = {}) => events.push({
        event_id: `claude:${seq}:${kind}`, sequence: seq, at: timestamp(value.timestamp), kind, label, ...extra,
      });
      if (value.type === "assistant" && p.type === "tool_use") {
        const id = text(p.id), name = text(p.name); if (!id || !name) continue;
        calls.set(id, { name, input: ["TaskCreate", "TaskUpdate", "TodoWrite"].includes(name) ? object(p.input) : undefined,
          agentType: ["Agent", "Task"].includes(name) ? text(object(p.input)?.subagent_type) : undefined });
        emit("call.start", name, { call_id: id });
      } else if (value.type === "user" && p.type === "tool_result") {
        const id = text(p.tool_use_id); if (!id) continue;
        const call = calls.get(id), success = p.is_error !== true;
        emit("call.end", call?.name || "Tool", { call_id: id, outcome: success ? "completed" : "failed" });
        const native = object(value.toolUseResult);
        const nativeId = text(native?.agentId, 128);
        if (success && call && ["Agent", "Task"].includes(call.name) && native?.isAsync === true && native.status === "async_launched" && nativeId && /^[A-Za-z0-9_-]+$/.test(nativeId)) {
          const label = call.agentType || "Sub-agent";
          launched.set(id, { nativeId, label, ended: false });
          emit("agent.start", label, { call_id: id, target_native_id: nativeId });
        }
        if (!success || !call?.input) continue;
        const output = typeof p.content === "string" ? p.content : "";
        const nativeTask = object(native?.task);
        const createdId = call.name !== "TaskCreate" ? undefined : native
          ? text(nativeTask?.id, 128)
          : /^Task #([A-Za-z0-9_-]{1,128}) created successfully:/.exec(output)?.[1];
        const subject = text(call.input.subject);
        if (createdId && subject && (!native || text(nativeTask?.subject) === subject)) emit("phase", subject, { phase: { id: createdId, label: subject, state: "pending" } });
        const taskId = text(call.input.taskId, 128);
        const nativeChange = object(native?.statusChange);
        const updated = native ? native.success === true && native.taskId === taskId && (!nativeChange || !call.input.status || nativeChange.to === call.input.status) : output.startsWith(`Updated task #${taskId} `);
        if (call.name === "TaskUpdate" && taskId && updated) {
          const status = state(call.input.status), dependencies = Array.isArray(call.input.addBlockedBy) ? call.input.addBlockedBy.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128).slice(0, 64) : undefined;
          if (status || subject || dependencies) emit("phase", subject || "Task updated", { phase: { id: taskId, ...(subject ? { label: subject } : {}), ...(status ? { state: status } : {}), ...(dependencies ? { depends_on: dependencies } : {}) } });
        }
        if (call.name === "TodoWrite") {
          const phases = plan(call.input.todos); if (phases) emit("plan", "Plan updated", { phases });
        }
      }
    }
  }
  return events.slice(-1024);
}
