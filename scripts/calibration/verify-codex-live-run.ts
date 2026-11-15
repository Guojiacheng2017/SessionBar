import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionSnapshot } from "../../src/shared/executionTrace.js";

export interface TaskEvidence {
  task: string;
  pid: number;
  startedAt: number;
  endedAt: number;
  alive: boolean;
  lastTick: number;
}

export interface CliEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; tool: string; receiver_thread_ids: string[]; status?: string };
}

export interface SessionRow {
  type: string;
  timestamp?: string;
  payload?: {
    type?: string;
    model?: string;
    multi_agent_version?: string;
    started_at_ms?: number;
    completed_at_ms?: number;
    output?: unknown;
    item?: {
      type: string;
      id: string;
      tool?: string;
      command: string | string[];
      exit_code: number;
      status: string;
    };
  };
}

export interface Observation {
  processes: { activeWorkers: TaskEvidence[] };
  view?: ExecutionSnapshot;
  matchedSessions?: number;
}

export type ExecutionObservation = Observation & { view: ExecutionSnapshot };

export interface CommandEvidence {
  id: string;
  command: string | undefined;
  exitCode: number;
  status?: string;
  start?: number;
  end?: number;
}

interface LiveManifest {
  dir: string;
  threadId: string;
  commands: string[];
  model: string;
  url: string;
}

interface LiveSummary {
  replay: boolean;
  timedOut: boolean;
  code: number;
  activeMs: number;
  allFourTasksCompleted: boolean;
  tasks: TaskEvidence[];
}

interface BrowserProof {
  at: number;
  axis: string;
  edges: number;
  agents: { id: string; state: string; title: string; style: string }[];
  openWaits: number;
  processes: { activeWorkers: TaskEvidence[] };
  execution: { openAgents: number; waits: { requested: number }[]; phaseCount: number };
  toolsClosed: boolean;
}

interface StreamRow {
  kind: string;
  event?: { kind: string; wait_for_native_ids?: string[] };
}

// Artifact types describe the recorder format; assertions below retain the
// original evidence checks rather than treating parsed JSON as verification.
export function readJson<Value>(file: string): Value {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Value;
}

export function readRows<Row>(file: string): Row[] {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as Row);
}

export function hasExecutionView(row: Observation): row is ExecutionObservation {
  return !!row.view?.spans;
}

/** Verify saved evidence only. This function never starts a harness or task. */
export function verifyCodexLiveRun(runDirectory: string) {
  const dir = path.resolve(runDirectory);
  const manifest = readJson<LiveManifest>(path.join(dir, "manifest.json"));
  assert.equal(manifest.dir, dir);
  const summary = readJson<LiveSummary>(path.join(dir, "summary.json"));
  assert.equal(summary.replay, false);
  assert.equal(summary.timedOut, false);
  assert.equal(summary.code, 0);
  assert.ok(summary.activeMs <= 150000);
  assert.equal(summary.allFourTasksCompleted, true);

  const processRows = readRows<{ task: string; kind: string }>(path.join(dir, "process-events.jsonl"));
  const tasks = Object.fromEntries(summary.tasks.map(task => [task.task, task]));
  for (const name of ["prepare", "left", "right", "join"]) {
    assert.equal(processRows.filter(row => row.task === name && row.kind === "start").length, 1);
    assert.equal(processRows.filter(row => row.task === name && row.kind === "end").length, 1);
    assert.ok(tasks[name].endedAt > tasks[name].startedAt);
    assert.equal(tasks[name].alive, false);
  }
  assert.notEqual(tasks.left.pid, tasks.right.pid);
  assert.ok(tasks.prepare.endedAt < Math.min(tasks.left.startedAt, tasks.right.startedAt));
  assert.ok(tasks.join.startedAt > Math.max(tasks.left.endedAt, tasks.right.endedAt));
  const overlapMs = Math.min(tasks.left.endedAt, tasks.right.endedAt)
    - Math.max(tasks.left.startedAt, tasks.right.startedAt);
  assert.ok(overlapMs >= 30000);

  const stdout = readRows<CliEvent>(path.join(dir, "cli.stdout.jsonl"));
  const spawned = stdout.filter(row => row.type === "item.completed" && row.item?.tool === "spawn_agent")
    .flatMap(row => row.item!.receiver_thread_ids);
  assert.equal(new Set(spawned).size, 2);
  assert.equal(stdout.find(row => row.type === "thread.started")?.thread_id, manifest.threadId);
  const waits = stdout.filter(row => row.item?.type === "collab_tool_call" && row.item.tool === "wait");
  for (const row of waits.filter(row => row.type === "item.started")) {
    assert.ok(row.item!.receiver_thread_ids.length > 0);
    assert.ok(row.item!.receiver_thread_ids.every(id => spawned.includes(id)));
  }
  assert.ok(waits.some(row => row.type === "item.completed" && row.item!.receiver_thread_ids.length === 0));
  assert.equal(stdout.filter(row => row.type === "item.completed"
    && row.item?.tool === "close_agent" && row.item.status === "completed").length, 2);

  const commands: CommandEvidence[] = [];
  const contexts: { model: string | undefined; multiAgentVersion: string | undefined }[] = [];
  const errors: { type: string | undefined; at: string | undefined }[] = [];
  const sessions = path.join(dir, "codex-home", "sessions");
  for (const file of fs.readdirSync(sessions, { recursive: true, encoding: "utf8" })
    .filter(name => name.endsWith(".jsonl"))) {
    for (const row of readRows<SessionRow>(path.join(sessions, file))) {
      const payload = row.payload;
      if (row.type === "turn_context") {
        contexts.push({ model: payload?.model, multiAgentVersion: payload?.multi_agent_version });
      }
      if (payload?.type === "item_completed" && payload.item?.type === "CommandExecution") {
        const item = payload.item;
        commands.push({
          id: item.id, command: Array.isArray(item.command) ? item.command.at(-1) : item.command,
          exitCode: item.exit_code, status: item.status, start: payload.started_at_ms, end: payload.completed_at_ms,
        });
      }
      if (payload && ["custom_tool_call_output", "function_call_output"].includes(payload.type ?? "")
        && /agent ids must be non-empty|missing field .target.|Script failed|IndexError|prerequisite not finished/.test(JSON.stringify(payload.output))) {
        errors.push({ type: payload.type, at: row.timestamp });
      }
    }
  }
  assert.equal(errors.length, 0);
  assert.equal(commands.length, 4);
  for (const command of manifest.commands) {
    const matches = commands.filter(item => item.command === command);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].exitCode, 0);
    assert.equal(matches[0].status, "completed");
  }
  assert.ok(contexts.length >= 3);
  assert.ok(contexts.every(context => context.model === manifest.model && context.multiAgentVersion === "v1"));

  const proofs = readRows<{ receivedAt: number; proof: BrowserProof }>(path.join(dir, "browser-live-proof.jsonl"));
  assert.ok(proofs.length >= 2);
  const early = proofs[0].proof;
  for (const { receivedAt, proof } of proofs) {
    assert.ok(receivedAt < Math.min(tasks.left.endedAt, tasks.right.endedAt));
    assert.ok(proof.edges >= 2);
    assert.equal(proof.agents.filter(agent => agent.state === "open").length, 2);
    assert.ok(proof.openWaits >= 1);
    assert.equal(proof.processes.activeWorkers.length, 2);
    assert.equal(proof.execution.openAgents, 2);
    assert.ok(proof.execution.waits.some(wait => wait.requested === 2));
    assert.equal(proof.execution.phaseCount, 0);
    assert.equal(proof.toolsClosed, true);
    assert.ok(proof.processes.activeWorkers.every(task => proof.at - task.lastTick < 2500));
  }
  const later = proofs.map(row => row.proof).find(proof => proof.at - early.at >= 1500
    && proof.axis !== early.axis && proof.agents.every(agent => early.agents
      .some(before => agent.id === before.id && agent.title !== before.title && agent.style !== before.style)));
  assert.ok(later, "agent Gantt duration/axis/style updated while both actual processes were alive");

  const observations = readRows<ExecutionObservation>(path.join(dir, "observations.jsonl"));
  assert.ok(observations.some(row => row.processes.activeWorkers.length === 2
    && row.view.spans.filter(span => span.kind === "agent" && span.state === "open").length === 2
    && row.view.spans.some(span => span.label === "Native wait" && span.wait_for_agent_ids?.length === 2)));
  assert.ok(observations.some(row => row.view.spans.filter(span => span.kind === "agent" && span.state === "open").length === 1));
  const final = observations.at(-1)!.view;
  assert.equal(final.spans.filter(span => span.kind === "agent" && span.state === "completed").length, 2);
  assert.equal(final.spans.filter(span => span.kind === "agent" && span.state === "open").length, 0);
  assert.equal(final.spans.filter(span => span.kind === "run" && span.state === "completed").length, 4);
  assert.equal(final.max_parallel_execution, 2);
  assert.equal(final.max_parallel_agents, 2);
  assert.equal(final.phases.length, 0);
  assert.ok(final.spans.filter(span => span.label === "Native wait")
    .every(span => span.state === "completed" && (span.wait_for_agent_ids?.length ?? 0) > 0));

  const eventsDir = path.join(dir, "runtime", "codex-events");
  const streamFile = fs.readdirSync(eventsDir).find(name => name.endsWith(".jsonl"));
  assert.ok(streamFile, "native event stream file is required");
  const source = readRows<StreamRow>(path.join(eventsDir, streamFile));
  assert.ok(source.some(row => row.kind === "event" && row.event?.kind === "call.start"
    && row.event.wait_for_native_ids?.length === 2));
  assert.equal(source.at(-1)?.kind, "closed");
  assert.equal(fs.existsSync(path.join(dir, "codex-home", "auth.json")), false);

  return {
    dir, url: manifest.url, nativeRoot: manifest.threadId, nativeAgents: spawned, model: manifest.model,
    runtimeVersions: [...new Set(contexts.map(context => context.multiAgentVersion))],
    activeMs: summary.activeMs, limitMs: 150000, replay: false, processes: summary.tasks,
    realProcessOverlapMs: overlapMs, commands, parameterErrors: errors.length,
    earlyDag: {
      at: early.at, serverReceivedAt: proofs[0].receivedAt, edges: early.edges, openAgents: 2,
      openWaits: early.openWaits, activeWorkerPids: early.processes.activeWorkers.map(task => task.pid),
      millisecondsBeforeFirstWorkerEnd: Math.min(tasks.left.endedAt, tasks.right.endedAt) - early.at,
    },
    liveGantt: {
      from: early.at, to: later.at, axisFrom: early.axis, axisTo: later.axis,
      titlesFrom: early.agents.map(agent => agent.title), titlesTo: later.agents.map(agent => agent.title),
    },
    liveBrowserProofs: proofs.length,
    final: {
      completedAgents: 2, completedCommands: 4, nativeCommandPeak: final.max_parallel_execution,
      nativeAgentPeak: final.max_parallel_agents, phases: 0,
      waits: final.spans.filter(span => span.label === "Native wait").length,
    },
    temporaryCredentialsRemoved: true,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    throw Error("Usage: node --experimental-strip-types scripts/calibration/verify-codex-live-run.ts /absolute/run-directory [report.json]");
  }
  const report = verifyCodexLiveRun(process.argv[2]);
  fs.writeFileSync(process.argv[3] ?? path.join(report.dir, "verification.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
