import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executionTraceMarkup } from "#app/web/executionViews.js";
import type { ExecutionSnapshot } from "../../src/shared/executionTrace.js";
import {
  hasExecutionView, readJson, readRows,
  type CliEvent, type CommandEvidence, type Observation, type SessionRow, type TaskEvidence,
} from "./verify-codex-live-run.ts";

interface AutoManifest {
  dir: string;
  entry: string;
  production: unknown;
  hookRoot: string;
  codexHome: string;
  commands: string[];
}

interface AutoSummary {
  replay: boolean;
  code: number;
  timedOut: boolean;
  totalActiveMs: number;
  activeMs: number;
  nativeId: string;
  tasks: TaskEvidence[];
}

interface HookStart {
  kind: string;
  native_id: string;
  root_native_id: string;
  cwd: string;
  targets?: string[];
  call_id: string;
}

interface AppBrowserProof {
  nativeWait: { durationMs: number };
  liveVisibleSamples: { axis: string }[];
  samples: { spans?: { targets?: string[] }[] }[];
}

/** Optional proof path keeps synthetic/relocated evidence out of global state.
 * The legacy default remains readable for existing saved calibration commands. */
export function verifyCodexAutoRun(
  runDirectory: string,
  appBrowserProofFile = "/tmp/sessionbar-codex-auto-app-browser.json",
) {
  const dir = path.resolve(runDirectory);
  const manifest = readJson<AutoManifest>(path.join(dir, "manifest.json"));
  const summary = readJson<AutoSummary>(path.join(dir, "summary.json"));
  assert.equal(manifest.dir, dir);
  assert.equal(summary.replay, false);
  assert.equal(summary.code, 0);
  assert.equal(summary.timedOut, false);
  assert.equal(summary.totalActiveMs, 131201);
  assert.ok(summary.totalActiveMs < 150000);
  assert.match(manifest.entry, /ordinary codex/);
  assert.match(manifest.entry, /no trace/);

  const tasks = Object.fromEntries(summary.tasks.map(task => [task.task, task]));
  for (const task of summary.tasks) assert.ok(task.endedAt > task.startedAt && !task.alive);
  assert.notEqual(tasks.left.pid, tasks.right.pid);
  assert.ok(tasks.prepare.endedAt < Math.min(tasks.left.startedAt, tasks.right.startedAt));
  assert.ok(tasks.join.startedAt > Math.max(tasks.left.endedAt, tasks.right.endedAt));

  const cold = readJson<{ at: number; processes: { activeWorkers: TaskEvidence[] }; view: ExecutionSnapshot }>(path.join(dir, "cold-flow.json"));
  assert.equal(cold.processes.activeWorkers.length, 2);
  assert.ok(cold.at < Math.min(tasks.left.endedAt, tasks.right.endedAt));
  assert.equal(cold.view.spans.filter(span => span.kind === "agent" && span.state === "open").length, 2);
  assert.ok(cold.view.spans.some(span => span.label === "Native wait" && span.state === "open" && span.wait_for_agent_ids?.length === 2));
  assert.equal(cold.view.spans.some(span => span.kind === "run"), false);
  assert.equal(cold.view.phases.length, 0);
  const markup = executionTraceMarkup(cold.view);
  assert.match(markup, /Native wait DAG/);
  assert.equal((markup.match(/class="workflow-edge"/g) ?? []).length, 2);

  const observed = readRows<Observation>(path.join(dir, "observations.jsonl")).filter(hasExecutionView);
  const live = observed.filter(row => row.processes.activeWorkers.length === 2
    && row.view.spans.filter(span => span.kind === "agent" && span.state === "open").length === 2
    && row.view.spans.some(span => span.label === "Native wait" && span.state === "open" && span.wait_for_agent_ids?.length === 2));
  assert.ok(live.length > 2);
  assert.ok(live.some(row => row.view.observed_at - live[0].view.observed_at > 2000));
  assert.ok(observed.every(row => row.matchedSessions === 1));
  const final = observed.at(-1)!.view;
  assert.equal(final.spans.filter(span => span.kind === "agent" && span.state === "completed").length, 2);
  assert.equal(final.spans.filter(span => span.kind === "run" && span.state === "completed").length, 4);
  assert.equal(final.max_parallel_execution, 2);
  assert.equal(final.phases.length, 0);
  assert.ok(final.spans.filter(span => span.label === "Native wait")
    .every(span => span.state === "completed" && (span.wait_for_agent_ids?.length ?? 0) > 0));
  assert.ok(final.spans.some(span => span.wait_result_agent_ids?.length === 0 && span.wait_for_agent_ids?.length === 2));
  assert.ok(final.spans.every(span => !span.span_id.includes("codex-stream:")));

  const journal = readRows<HookStart>(path.join(manifest.hookRoot, `${summary.nativeId}.jsonl`));
  const starts = journal.filter(row => row.kind === "wait.start");
  assert.ok(starts.length > 0);
  assert.ok(starts.every(row => row.native_id === summary.nativeId && row.root_native_id === summary.nativeId && row.cwd === dir));
  const stdout = readRows<CliEvent>(path.join(dir, "stdout.jsonl"));
  const children = stdout.filter(row => row.type === "item.completed" && row.item?.tool === "spawn_agent")
    .flatMap(row => row.item!.receiver_thread_ids);
  assert.equal(new Set(children).size, 2);
  assert.ok(starts.every(row => row.targets?.every(id => children.includes(id))));

  const commands: CommandEvidence[] = [];
  const waits: string[] = [];
  const ids = [summary.nativeId, ...children];
  const sessions = path.join(manifest.codexHome, "sessions");
  for (const name of fs.readdirSync(sessions, { recursive: true, encoding: "utf8" })
    .filter(name => name.endsWith(".jsonl") && ids.some(id => name.includes(id)))) {
    for (const row of readRows<SessionRow>(path.join(sessions, name))) {
      const payload = row.payload;
      const item = payload?.item;
      if (payload?.type === "item_completed" && item?.type === "CommandExecution") {
        commands.push({ id: item.id, command: Array.isArray(item.command) ? item.command.at(-1) : item.command, exitCode: item.exit_code });
      }
      if (payload?.type === "item_completed" && item?.type === "CollabAgentToolCall" && item.tool === "wait") waits.push(item.id);
    }
  }
  assert.equal(commands.length, 4);
  for (const expected of manifest.commands) {
    const matches = commands.filter(command => command.command === expected);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].exitCode, 0);
  }
  assert.ok(starts.every(row => waits.includes(row.call_id)));

  const app = readJson<AppBrowserProof>(appBrowserProofFile);
  assert.equal(app.nativeWait.durationMs, 10001);
  assert.ok(app.liveVisibleSamples.length > 1);
  assert.ok(app.liveVisibleSamples.some(sample => sample.axis !== app.liveVisibleSamples[0].axis));
  assert.ok(app.samples.flatMap(sample => sample.spans ?? []).every(span => span.targets === undefined));

  const report = {
    dir, nativeId: summary.nativeId, entry: manifest.entry, productionAtRun: manifest.production,
    normalRunMs: summary.activeMs, externalCliTotalMs: summary.totalActiveMs,
    currentAppNativeWaitMs: app.nativeWait.durationMs,
    totalIncludingAppWaitMs: summary.totalActiveMs + app.nativeWait.durationMs, limitMs: 150000,
    realProcessOverlapMs: Math.min(tasks.left.endedAt, tasks.right.endedAt) - Math.max(tasks.left.startedAt, tasks.right.startedAt),
    coldFlow: {
      at: cold.at, openAgents: 2, openWaits: cold.view.spans.filter(span => span.label === "Native wait").length,
      renderedEdges: 2, millisecondsBeforeFirstWorkerEnd: Math.min(tasks.left.endedAt, tasks.right.endedAt) - cold.at,
      completedHistorySpans: 0,
    },
    liveProductionSamples: live.length,
    final: { completedAgents: 2, completedCommands: 4, commandPeak: 2, nativePhases: 0 },
    currentApp: { liveVisibleSamples: app.liveVisibleSamples.length, targetless: true, axisChanged: true },
    browserNormalParallelDagBeforeWorkerEnd: false,
    browserParallelNote: "Production API and cold Flow were recorded live; ordinary parallel-run browser Flow opened after workers completed. Current App browser independently confirmed automatic live wait timing.",
    commands, replay: false,
  };
  assert.ok(report.totalIncludingAppWaitMs < 150000);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    throw Error("Usage: node --experimental-strip-types scripts/calibration/verify-codex-auto-run.ts /absolute/run-directory [report.json] [app-browser-proof.json]");
  }
  const report = verifyCodexAutoRun(process.argv[2], process.argv[4]);
  fs.writeFileSync(process.argv[3] ?? path.join(report.dir, "verification.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
