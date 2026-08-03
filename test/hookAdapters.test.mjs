import assert from "node:assert/strict";
import test from "node:test";
import { adaptNativeHookPayload } from "../dist/hookAdapters.js";

test("adapts common tool-start payloads into canonical report facts", () => {
  const examples = [
    {
      agent: "Claude Code",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      },
      task: "running: npm test",
    },
    {
      agent: "Gemini CLI",
      raw: {
        eventName: "BeforeTool",
        toolName: "Shell",
        toolArgs: { command: "npm run build" },
      },
      task: "running: npm run build",
    },
    {
      agent: "Pi",
      raw: {
        event: "tool_call",
        tool: { name: "shell", input: { cmd: "cargo test" } },
      },
      task: "running: cargo test",
    },
  ];

  for (const { agent, raw, task } of examples) {
    const adapted = adaptNativeHookPayload(agent, raw);
    assert.equal(adapted.status, "working", agent);
    assert.equal(adapted.task_name, task, agent);
    assert.deepEqual(adapted.activity_tail, [task.replace(/^running:/, "tool:")], agent);
  }
});

test("adapts nested command shapes used by shell and tool hooks", () => {
  const examples = [
    {
      agent: "Kimi Code CLI",
      raw: {
        event: "PreToolUse",
        tool_name: "Bash",
        tool_input: { arguments: { command: "pnpm test" } },
      },
      task: "running: pnpm test",
      activity: "tool: pnpm test",
    },
    {
      agent: "Cursor",
      raw: {
        event: "beforeShellExecution",
        shell: { command: "bun test" },
      },
      task: "running: bun test",
      activity: "tool: bun test",
    },
    {
      agent: "OpenCode",
      raw: {
        event: "tool.execute.before",
        properties: {
          tool: "shell",
          input: { command: "npm run build" },
        },
      },
      task: "running: npm run build",
      activity: "tool: npm run build",
    },
  ];

  for (const { agent, raw, task, activity } of examples) {
    const adapted = adaptNativeHookPayload(agent, raw);
    assert.equal(adapted.status, "working", agent);
    assert.equal(adapted.task_name, task, agent);
    assert.deepEqual(adapted.activity_tail, [activity], agent);
  }
});

test("adapts nested failure payloads without losing the failing command", () => {
  const adapted = adaptNativeHookPayload("Kimi Code CLI", {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { args: { command: "pytest tests/test_hooks.py" } },
    error: { message: "exit status 1" },
  });

  assert.equal(adapted.status, "error");
  assert.equal(adapted.task_name, "failed: pytest tests/test_hooks.py");
  assert.deepEqual(adapted.activity_tail, ["error: exit status 1"]);
});

test("adapts prompt, model, and context lifecycle hook samples", () => {
  assert.deepEqual(adaptNativeHookPayload("GitHub Copilot", {
    event: "userPromptSubmitted",
    payload: { prompt: "add hook adapter samples\nthen run tests" },
  }), {
    hook_event: "userPromptSubmitted",
    status: "working",
    task_name: "user: add hook adapter samples then run tests",
    activity_tail: ["user: add hook adapter samples then run tests"],
  });

  assert.deepEqual(adaptNativeHookPayload("Gemini CLI", { eventName: "BeforeModel" }), {
    hook_event: "BeforeModel",
    status: "working",
    task_name: "Thinking",
  });

  assert.deepEqual(adaptNativeHookPayload("Claude Code", {
    hookEventName: "PostCompact",
    stats: { contextPercent: 43 },
  }), {
    hook_event: "PostCompact",
    context_percent: 43,
    status: "working",
    task_name: "Context compacted",
    activity_tail: ["context: compacted"],
  });
});

test("adapts permission, completion, and failure hooks without model inference", () => {
  assert.deepEqual(adaptNativeHookPayload("OpenCode", { event: "permission.asked" }), {
    hook_event: "permission.asked",
    status: "blocked",
    task_name: "Waiting for permission",
    activity_tail: ["wait: permission"],
  });

  assert.deepEqual(adaptNativeHookPayload("GitHub Copilot", { event: "sessionEnd" }), {
    hook_event: "sessionEnd",
    status: "idle",
    task_name: "Session ended",
    activity_tail: ["session: ended"],
  });

  const failed = adaptNativeHookPayload("Cursor", {
    event: "postToolUseFailure",
    toolName: "shell",
    error: "exit 1",
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.task_name, "failed: shell");
  assert.deepEqual(failed.activity_tail, ["error: exit 1"]);
});

test("adapts session usage aliases but leaves provider quota out of session scope", () => {
  const adapted = adaptNativeHookPayload("Codex", {
    hook_event: "SessionStart",
    usage: {
      inputTokens: 48200,
      output_tokens: 12800,
      cachedInputTokens: 1400000,
      cache_write_tokens: 185000,
      totalTokens: 1646000,
    },
    metrics: {
      turns: 34,
      contextPercent: 72,
      quotaPercent: 65,
    },
  });

  assert.equal(adapted.hook_event, "SessionStart");
  assert.equal(adapted.tokens, 1646000);
  assert.equal(adapted.input_tokens, 48200);
  assert.equal(adapted.output_tokens, 12800);
  assert.equal(adapted.cache_read_tokens, 1400000);
  assert.equal(adapted.cache_write_tokens, 185000);
  assert.equal(adapted.turns, 34);
  assert.equal(adapted.context_percent, 72);
  assert.equal("quota_percent" in adapted, false);
});

test("unmapped native events keep only the raw hook event label", () => {
  assert.deepEqual(adaptNativeHookPayload("Claude Code", { hook_event_name: "DefinitelyNotARealHook" }), {
    hook_event: "DefinitelyNotARealHook",
  });
});
