import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { ExecutionSnapshot, ExecutionSpan } from "../src/shared/executionTrace.js";
import { verifyCodexAutoRun } from "../scripts/calibration/verify-codex-auto-run.ts";
import { verifyCodexLiveRun, type CliEvent, type SessionRow, type TaskEvidence } from "../scripts/calibration/verify-codex-live-run.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const ids = [1, 2, 3].map(id => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`);

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function writeRows(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
}

// Entirely synthetic recorder artifacts. No harness, account, network, or
// production Relay is involved; the test runner supplies an isolated TMPDIR.
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sessionbar-calibration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = {
    dir, threadId: ids[0], model: "synthetic-model", url: "http://example.invalid/flow",
    commands: ["prepare.py", "left.py", "right.py", "join.py"],
    entry: "ordinary codex exec, no trace", production: { source: "synthetic" },
    codexHome: join(dir, "codex-home"), hookRoot: join(dir, "hooks"),
  };
  const tasks: TaskEvidence[] = [
    { task: "prepare", pid: 100, startedAt: 1000, endedAt: 2000, alive: false, lastTick: 2000 },
    { task: "left", pid: 101, startedAt: 3000, endedAt: 43000, alive: false, lastTick: 43000 },
    { task: "right", pid: 102, startedAt: 4000, endedAt: 49000, alive: false, lastTick: 49000 },
    { task: "join", pid: 103, startedAt: 50000, endedAt: 51000, alive: false, lastTick: 51000 },
  ];
  const summary = {
    replay: false, timedOut: false, code: 0, activeMs: 60000, totalActiveMs: 131201,
    allFourTasksCompleted: true, nativeId: ids[0], tasks,
  };
  const stdout: CliEvent[] = [
    { type: "thread.started", thread_id: ids[0] },
    ...ids.slice(1).map(id => ({ type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", receiver_thread_ids: [id] } })),
    { type: "item.started", item: { type: "collab_tool_call", tool: "wait", receiver_thread_ids: ids.slice(1) } },
    { type: "item.completed", item: { type: "collab_tool_call", tool: "wait", receiver_thread_ids: [] } },
    ...ids.slice(1).map(id => ({ type: "item.completed", item: { type: "collab_tool_call", tool: "close_agent", status: "completed", receiver_thread_ids: [id] } })),
  ];
  const sessions: SessionRow[][] = ids.map(() => [{ type: "turn_context", payload: { model: manifest.model, multi_agent_version: "v1" } }]);
  tasks.forEach((task, index) => sessions[index === 1 ? 1 : index === 2 ? 2 : 0].push({
    type: "event_msg", payload: {
      type: "item_completed", started_at_ms: task.startedAt, completed_at_ms: task.endedAt,
      item: { type: "CommandExecution", id: `command-${task.task}`, command: ["/bin/sh", "-c", manifest.commands[index]], exit_code: 0, status: "completed" },
    },
  }));
  sessions[0].push({ type: "event_msg", payload: { type: "item_completed", item: {
    type: "CollabAgentToolCall", id: "native-wait", tool: "wait", command: "", exit_code: 0, status: "completed",
  } } });

  const agents: ExecutionSpan[] = ids.slice(1).map((id, index) => ({
    span_id: `agent-${index}`, agent_id: id, kind: "agent", label: index ? "Right" : "Left",
    started_at: tasks[index + 1].startedAt, ended_at: null, state: "open",
  }));
  const wait: ExecutionSpan = {
    span_id: "native-wait", agent_id: ids[0], kind: "call", label: "Native wait",
    started_at: 5000, ended_at: null, state: "open", wait_for_agent_ids: ids.slice(1),
  };
  const view = (at: number, spans: ExecutionSpan[]): ExecutionSnapshot => ({
    schema_version: "sessionbar.execution.v1", kind: "execution", stream_id: "synthetic-stream",
    revision: at, session_id: ids[0], observed_since: 3000, observed_at: at, availability: "available",
    lanes: ids.map((id, index) => ({ agent_id: id, label: ["Coordinator", "Left", "Right"][index], status: "working" })),
    phases: [], spans, max_concurrent_calls: 1, max_parallel_execution: 2, max_parallel_agents: 2, notes: [],
  });
  const activeWorkers = (at: number) => tasks.slice(1, 3).map(task => ({ ...task, alive: true, lastTick: at - 100 }));
  const live = [10000, 12000, 14001].map(at => ({
    processes: { activeWorkers: activeWorkers(at) }, view: view(at, structuredClone([...agents, wait])), matchedSessions: 1,
  }));
  const final = view(52000, [
    ...agents.map((agent, index): ExecutionSpan => ({ ...agent, state: "completed", ended_at: tasks[index + 1].endedAt })),
    { ...wait, state: "completed", ended_at: 49500, wait_result_agent_ids: [] },
    ...tasks.map((task): ExecutionSpan => ({
      span_id: `command-${task.task}`, agent_id: ids[0], kind: "run", label: task.task,
      state: "completed", started_at: task.startedAt, ended_at: task.endedAt,
    })),
  ]);
  const observations = [...live, {
    processes: { activeWorkers: [activeWorkers(45000)[1]] },
    view: view(45000, [{ ...agents[0], state: "completed", ended_at: tasks[1].endedAt }, agents[1], wait]), matchedSessions: 1,
  }, { processes: { activeWorkers: [] }, view: final, matchedSessions: 1 }];
  const cold = { at: 10000, ...live[0] };
  const proofs = [10000, 12000].map(at => ({
    receivedAt: at + 1,
    proof: {
      at, axis: `axis-${at}`, edges: 2, openWaits: 1, toolsClosed: true,
      agents: agents.map(agent => ({ id: agent.span_id, state: "open", title: `duration-${at}`, style: `width:${at / 1000}%` })),
      processes: { activeWorkers: activeWorkers(at) }, execution: { openAgents: 2, waits: [{ requested: 2 }], phaseCount: 0 },
    },
  }));
  const hooks = [{ kind: "wait.start", native_id: ids[0], root_native_id: ids[0], cwd: dir, targets: ids.slice(1), call_id: "native-wait" }];
  const source = [{ kind: "event", event: { kind: "call.start", wait_for_native_ids: ids.slice(1) } }, { kind: "closed" }];
  const app = {
    nativeWait: { durationMs: 10001 }, liveVisibleSamples: [{ axis: "before" }, { axis: "after" }],
    samples: [{ spans: [{}] }, {}],
  };
  const appFile = join(dir, "app-browser-proof.json");
  const save = () => {
    writeJson(join(dir, "manifest.json"), manifest);
    writeJson(join(dir, "summary.json"), summary);
    writeRows(join(dir, "process-events.jsonl"), tasks.flatMap(task => [{ task: task.task, kind: "start" }, { task: task.task, kind: "end" }]));
    writeRows(join(dir, "cli.stdout.jsonl"), stdout);
    writeRows(join(dir, "stdout.jsonl"), stdout);
    sessions.forEach((rows, index) => writeRows(join(manifest.codexHome, "sessions", "synthetic", `${ids[index]}.jsonl`), rows));
    writeRows(join(dir, "observations.jsonl"), observations);
    writeJson(join(dir, "cold-flow.json"), cold);
    writeRows(join(dir, "browser-live-proof.jsonl"), proofs);
    writeRows(join(manifest.hookRoot, `${ids[0]}.jsonl`), hooks);
    writeRows(join(dir, "runtime", "codex-events", "synthetic.jsonl"), source);
    writeJson(appFile, app);
  };
  save();
  return { dir, manifest, summary, stdout, sessions, observations, cold, proofs, hooks, source, app, appFile, save };
}

function cli(name: "live" | "auto", args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", `scripts/calibration/verify-codex-${name}-run.ts`, ...args], {
    cwd: root, encoding: "utf8", env: process.env,
  });
}

test("live calibration CLI verifies synthetic evidence and preserves the default JSON report", t => {
  const input = fixture(t);
  const result = cli("live", [input.dir]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ReturnType<typeof verifyCodexLiveRun>;
  assert.deepEqual(report, verifyCodexLiveRun(input.dir));
  assert.deepEqual(JSON.parse(readFileSync(join(input.dir, "verification.json"), "utf8")), report);
  assert.equal(statSync(join(input.dir, "verification.json")).mode & 0o777, 0o600);
  assert.equal(report.realProcessOverlapMs, 39000);
  assert.equal(report.liveBrowserProofs, 2);
  assert.deepEqual(report.runtimeVersions, ["v1"]);
  assert.deepEqual(report.nativeAgents, ids.slice(1));
  assert.equal(report.final.completedCommands, 4);
});

test("automatic calibration CLI renders source-based DAG evidence with an explicit App proof and report path", t => {
  const input = fixture(t);
  const output = join(input.dir, "custom-report.json");
  const result = cli("auto", [input.dir, output, input.appFile]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ReturnType<typeof verifyCodexAutoRun>;
  assert.deepEqual(report, verifyCodexAutoRun(input.dir, input.appFile));
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), report);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(existsSync(join(input.dir, "verification.json")), false);
  assert.equal(report.totalIncludingAppWaitMs, 141202);
  assert.equal(report.coldFlow.renderedEdges, 2);
  assert.equal(report.liveProductionSamples, 3);
  assert.equal(report.currentApp.targetless, true);
  assert.equal(report.browserNormalParallelDagBeforeWorkerEnd, false);
});

test("calibration entrypoints return failure for missing arguments and rejected evidence without writing a report", t => {
  const input = fixture(t);
  input.summary.replay = true;
  input.save();
  for (const name of ["live", "auto"] as const) {
    const usage = cli(name, []);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Usage:.*verify-codex-.*-run\.ts/);
    const result = cli(name, [input.dir, join(input.dir, "failed-report.json"), input.appFile]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    assert.equal(existsSync(join(input.dir, "failed-report.json")), false);
  }
});

type Fixture = ReturnType<typeof fixture>;
const liveFailures: [string, (input: Fixture) => void][] = [
  ["150-second budget exceeded", input => { input.summary.activeMs = 150001; }],
  ["workers lack the required overlap", input => { input.summary.tasks[1].endedAt = 20000; }],
  ["wait targets reference a foreign agent", input => { input.stdout.find(row => row.type === "item.started")!.item!.receiver_thread_ids = ["foreign-agent"]; }],
  ["native worker command failed", input => { input.sessions[1][1].payload!.item!.exit_code = 1; }],
  ["native parameter error was recorded", input => { input.sessions[0].push({ type: "response_item", payload: { type: "function_call_output", output: "missing field `target`" } }); }],
  ["runtime is not v1", input => { input.sessions[1][0].payload!.multi_agent_version = "v2"; }],
  ["browser opened after a worker ended", input => { input.proofs[0].receivedAt = 50000; }],
  ["Gantt axis stopped advancing", input => { input.proofs[1].proof.axis = input.proofs[0].proof.axis; }],
  ["live worker heartbeat is stale", input => { input.proofs[0].proof.processes.activeWorkers[0].lastTick = 0; }],
  ["stream did not close", input => { input.source.pop(); }],
  ["temporary credentials remain", input => { writeJson(join(input.manifest.codexHome, "auth.json"), { fixture: true }); }],
];

for (const [reason, mutate] of liveFailures) test(`live calibration rejects synthetic evidence when ${reason}`, t => {
  const input = fixture(t);
  mutate(input);
  input.save();
  assert.throws(() => verifyCodexLiveRun(input.dir));
});

const autoFailures: [string, (input: Fixture) => void][] = [
  ["the shared measured budget changed", input => { input.summary.totalActiveMs = 149999; }],
  ["cold Flow was captured after completion", input => { input.cold.at = 50000; }],
  ["cold Flow contains replayed command history", input => { input.cold.view.spans.push(input.observations.at(-1)!.view.spans.at(-1)!); }],
  ["cold DAG has only one requested edge", input => { input.cold.view.spans.find(span => span.label === "Native wait")!.wait_for_agent_ids = ids.slice(1, 2); }],
  ["production observation clock stopped", input => { input.observations.slice(0, 3).forEach(row => { row.view.observed_at = 10000; }); }],
  ["one observation matched duplicate sessions", input => { input.observations[0].matchedSessions = 2; }],
  ["a timed-out wait lost its requested target set", input => { input.observations.at(-1)!.view.spans.find(span => span.label === "Native wait")!.wait_for_agent_ids = []; }],
  ["a manual trace supplied a span", input => { input.observations.at(-1)!.view.spans[0].span_id = "codex-stream:manual"; }],
  ["hook identity names another session", input => { input.hooks[0].root_native_id = ids[1]; }],
  ["hook start cannot join its native wait completion", input => { input.hooks[0].call_id = "unrelated-call-id"; }],
  ["App browser axis did not advance", input => { input.app.liveVisibleSamples[1].axis = "before"; }],
  ["an explicit dependency was invented for targetless App wait", input => { input.app.samples[0].spans = [{ targets: ids.slice(1) }]; }],
];

for (const [reason, mutate] of autoFailures) test(`automatic calibration rejects synthetic evidence when ${reason}`, t => {
  const input = fixture(t);
  mutate(input);
  input.save();
  assert.throws(() => verifyCodexAutoRun(input.dir, input.appFile));
});
