import assert from "node:assert/strict";
import test from "node:test";
import { TextAttributes } from "@opentui/core";
import {
  buildDetailScopeBarChunks,
  buildSessionSidebarLine,
  buildSessionDetailContent,
  detailTabByNumber,
  nextDetailTab,
  sessionFingerprint,
  sessionHandle,
  updateUnreadSessionState,
} from "../dist/sessions/sessionInspector.js";

const baseSession = {
  session_id: "codex-019ed3a2-a7ab-7a90-a6da-c1535a35afd0__Vision-Dash",
  session_type: "Codex",
  status: "working",
  task_name: "running: npm run build",
  activity_tail: ["tool: npm run build", "done: apply patch"],
  context_percent: 72,
  tokens: 1700000,
  turns: 34,
  timestamp: 1_700_000_000_000,
  project: "Vision-Dash",
  project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
};

test("session handles are compact and stable for sidebar use", () => {
  assert.equal(sessionHandle(baseSession, 18), "019ed3a2-a7...afd0");
  assert.equal(sessionHandle({ ...baseSession, session_id: "claude-demo-abc123__Vision-Dash" }, 12), "demo-abc123");
});

test("unread state ignores initial load, marks changed unselected sessions, and clears focused session", () => {
  const initial = updateUnreadSessionState({
    previousFingerprints: new Map(),
    previousUnread: new Set(),
    initialized: false,
    sessions: [baseSession],
    selectedSessionId: baseSession.session_id,
  });
  assert.equal(initial.initialized, true);
  assert.deepEqual([...initial.unreadSessionIds], []);

  const changed = { ...baseSession, task_name: "running: npm test", timestamp: baseSession.timestamp + 1 };
  const marked = updateUnreadSessionState({
    previousFingerprints: initial.fingerprints,
    previousUnread: initial.unreadSessionIds,
    initialized: initial.initialized,
    sessions: [changed],
    selectedSessionId: null,
  });
  assert.equal(marked.unreadSessionIds.has(baseSession.session_id), true);

  const cleared = updateUnreadSessionState({
    previousFingerprints: marked.fingerprints,
    previousUnread: marked.unreadSessionIds,
    initialized: marked.initialized,
    sessions: [changed],
    selectedSessionId: baseSession.session_id,
  });
  assert.deepEqual([...cleared.unreadSessionIds], []);
});

test("session sidebar line is a compact monitor summary, not a repeated table row", () => {
  const line = buildSessionSidebarLine(baseSession, {
    selected: true,
    unread: false,
    width: 42,
    now: baseSession.timestamp + 37_000,
  });
  assert.equal(line, "> WORK Vision-Dash 37s");
  assert.doesNotMatch(line, /019ed3a2|Codex|running:|Project|Agent|Status/);
  assert.ok(line.length <= 42);
});

test("session sidebar prefers an explicit session name over the project", () => {
  const line = buildSessionSidebarLine({ ...baseSession, session_name: "Refactor dashboard" }, {
    selected: true,
    unread: false,
    width: 42,
    now: baseSession.timestamp + 37_000,
  });
  assert.equal(line, "> WORK Refactor dashboard 37s");
});

test("overview renders compact current state without activity history or workflow graph", () => {
  const content = buildSessionDetailContent(baseSession, "overview", 58, baseSession.timestamp + 37_000);
  assert.match(content, /Overview \| Activity \| Usage \| Flow \| Raw/);
  assert.match(content, /NOW/);
  assert.match(content, /running: npm run build/);
  assert.match(content, /last done: done: apply patch/);
  assert.match(content, /PRESSURE/);
  assert.match(content, /\|\s+Context\s+\|\s+72%\s+\|/);
  assert.match(content, /\|\s+Age\s+\|\s+37s\s+\|/);
  assert.doesNotMatch(content, /WORKFLOW CHAIN|CURRENT ACTIVITY|RECENT TAIL|Session path|session_start|tool_start/);
});

test("overview uses boxes for state and a table for pressure", () => {
  const content = buildSessionDetailContent(baseSession, "overview", 58, baseSession.timestamp + 37_000);
  assert.match(content, /\+[- ]+NOW[- ]+\+/);
  assert.match(content, /\|\s+WORK running: npm run build/);
  assert.match(content, /\+[- ]+PRESSURE[- ]+\+/);
  assert.match(content, /\|\s+Metric\s+\|\s+Value\s+\|/);
  assert.match(content, /\|\s+Context\s+\|\s+72%\s+\|/);
  assert.match(content, /\|\s+Tokens\s+\|\s+1\.7M\s+\|/);
});

test("overview does not expose wireframe structure labels", () => {
  const content = buildSessionDetailContent(baseSession, "overview", 88, baseSession.timestamp + 37_000);
  assert.doesNotMatch(content, /^Header:/m);
  assert.doesNotMatch(content, /^Scope:/m);
  assert.doesNotMatch(content, /PRIMARY STAGE/);
  assert.doesNotMatch(content, /PRIORITY RAIL/);
});

test("overview does not invent synthetic lifecycle events", () => {
  const content = buildSessionDetailContent(baseSession, "overview", 88, baseSession.timestamp + 37_000);
  assert.doesNotMatch(content, /session_start|tool_start/);
  assert.match(content, /running: npm run build/);
  assert.match(content, /last done: done: apply patch/);
});

test("wide overview keeps pressure table readable without truncation", () => {
  const content = buildSessionDetailContent(
    { ...baseSession, session_id: "codex-demo__Vision-Dash" },
    "overview",
    88,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /\|\s+Context\s+\|\s+72%\s+\|/);
  assert.match(content, /\|\s+Tokens\s+\|\s+1\.7M\s+\|/);
  assert.match(content, /\|\s+Turns\s+\|\s+34\s+\|/);
  assert.match(content, /\|\s+Age\s+\|\s+37s\s+\|/);
  assert.doesNotMatch(content, /\.\.\./);
  for (const line of content.split("\n")) {
    assert.ok(line.length <= 88, `line exceeds target width: ${line}`);
  }
});

test("alerts render as overview attention without a priority rail", () => {
  const content = buildSessionDetailContent(
    { ...baseSession, status: "error", task_name: "TypeScript build failed" },
    "overview",
    88,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /ATTENTION/);
  assert.match(content, /ERR TypeScript build failed/);
  assert.doesNotMatch(content, /PRIORITY RAIL|HISTORY EVENTS|CURRENT ACTIVITY|RECENT TAIL/);
});

test("activity renders short history and deterministic plan signal without session path", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      plan_signal: [
        { state: "now", text: "refine Details tab design", age: "open" },
        { state: "next", text: "write spec after approval" },
      ],
    },
    "activity",
    58,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /PLAN SIGNAL/);
  assert.match(content, /\|\s+now\s+\|\s+refine Details tab design\s+\|\s+open\s+\|/);
  assert.match(content, /HISTORY EVENTS/);
  assert.match(content, /\|\s+run\s+\|\s+running: npm run build\s+\|\s+37s\s+\|/);
  assert.match(content, /\|\s+done\s+\|\s+apply patch\s+\|\s+--\s+\|/);
  assert.doesNotMatch(content, /CURRENT ACTIVITY|RECENT TAIL|Session path|start|tool done/);
});

test("activity renders plan and history as compact tables", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      plan_signal: [{ state: "now", text: "refine Details tab design", age: "open" }],
    },
    "activity",
    58,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /\+[- ]+PLAN SIGNAL[- ]+\+/);
  assert.match(content, /\|\s+State\s+\|\s+Signal\s+\|\s+Age\s+\|/);
  assert.match(content, /\+[- ]+HISTORY EVENTS[- ]+\+/);
  assert.match(content, /\|\s+Kind\s+\|\s+Event\s+\|\s+Age\s+\|/);
});

test("activity omits plan signal when deterministic plan data is absent", () => {
  const content = buildSessionDetailContent(baseSession, "activity", 58, baseSession.timestamp + 37_000);
  assert.doesNotMatch(content, /PLAN SIGNAL/);
  assert.match(content, /HISTORY EVENTS/);
});

test("usage renders one compact metric detail table", () => {
  const content = buildSessionDetailContent(baseSession, "usage", 58, baseSession.timestamp + 37_000);
  assert.match(content, /\+[- ]+USAGE[- ]+\+/);
  assert.match(content, /\|\s+Metric\s+\|\s+Value\s+\|\s+Detail\s+\|/);
  assert.match(content, /\|\s+Context\s+\|\s+72%\s+\|\s+\[[#-]+\]\s+\|/);
  assert.match(content, /\|\s+Tokens\s+\|\s+1\.7M\s+\|\s+in -- out --\s+\|/);
  assert.match(content, /\|\s+Turns\s+\|\s+34\s+\|\s+rate --\s+\|/);
  assert.match(content, /\|\s+Cache\s+\|\s+--\s+\|\s+read -- write --\s+\|/);
  assert.match(content, /\|\s+Quota\s+\|\s+--\s+\|\s+reset --\s+\|/);
  assert.doesNotMatch(content, /^USAGE$/m);
  for (const line of content.split("\n")) {
    assert.ok(line.length <= 58, `line exceeds target width: ${line}`);
  }
});

test("usage renders canonical rich token, cache, rate, and quota fields", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      input_tokens: 48200,
      output_tokens: 12800,
      cache_read_tokens: 1400000,
      cache_write_tokens: 185000,
      token_rate: 17000,
      quota_percent: 65,
      quota_reset: "5h38m",
    },
    "usage",
    72,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /\|\s+Tokens\s+\|\s+1\.7M\s+\|\s+in 48\.2k out 12\.8k\s+\|/);
  assert.match(content, /\|\s+Turns\s+\|\s+34\s+\|\s+rate 17k\/m\s+\|/);
  assert.match(content, /\|\s+Cache\s+\|\s+1\.6M\s+\|\s+read 1\.4M write 185k\s+\|/);
  assert.match(content, /\|\s+Quota\s+\|\s+65%\s+\|\s+reset 5h38m\s+\|/);
});

test("usage renders API balance beside provider plan percentage", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      agent_signals: [{
        signal: "api_balance",
        source: "provider_api",
        kind: "balance",
        scope: "account",
        remaining: 12.4,
        limit: 100,
        unit: "USD",
        status: "ok",
        used_percent: 65,
        label: "Codex API",
      }],
    },
    "usage",
    72,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /PROVIDER SIGNALS/);
  assert.match(content, /\|\s+Source\s+\|\s+Value\s+\|\s+Usage\s+\|\s+Reset\s+\|/);
  assert.match(content, /\|\s+Codex API\s+\|\s+12\.40 USD\s+\|\s+65% used\s+\|\s+--\s+\|/);
});

test("usage renders generic provider quota and health signals", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      agent_signals: [
        {
          signal: "provider_quota",
          kind: "quota",
          source: "provider_api",
          scope: "account",
          used: 65,
          limit: 100,
          unit: "%",
          status: "ok",
          label: "Codex quota",
        },
        {
          signal: "provider_health",
          kind: "service_health",
          source: "provider_api",
          scope: "account",
          status: "degraded",
          error_code: "429",
          label: "Codex API",
        },
      ],
    },
    "usage",
    72,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /\|\s+Codex quota\s+\|\s+--\s+\|\s+65\/100 %\s+\|/);
  assert.match(content, /\|\s+Codex API\s+\|\s+degraded \(429\)\s+\|\s+--\s+\|/);
});

test("usage keeps missing metrics aligned in narrow panels", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      context_percent: undefined,
      tokens: undefined,
      turns: undefined,
    },
    "usage",
    38,
    baseSession.timestamp + 37_000,
  );
  assert.match(content, /\|\s+Context\s+\|\s+--\s+\|\s+\[-+\]\s+\|/);
  assert.match(content, /\|\s+Tokens\s+\|\s+--\s+\|\s+in -- out --\s+\|/);
  assert.match(content, /\|\s+Turns\s+\|\s+--\s+\|\s+rate --\s+\|/);
  for (const line of content.split("\n\n").at(-1).split("\n")) {
    assert.ok(line.length <= 38, `line exceeds target width: ${line}`);
  }
});

test("flow renders structured edges when available and does not mirror activity history", () => {
  const graph = buildSessionDetailContent(
    {
      ...baseSession,
      flow: {
        nodes: [
          { id: "user_turn", label: "user turn" },
          { id: "tool_start", label: "tool start" },
          { id: "tool_done", label: "tool done" },
        ],
        edges: [
          { from: "user_turn", to: "tool_start" },
          { from: "tool_start", to: "tool_done" },
        ],
      },
    },
    "flow",
    58,
    baseSession.timestamp + 37_000,
  );
  assert.match(graph, /FLOW GRAPH/);
  assert.match(graph, /\+[- ]+FLOW GRAPH[- ]+\+/);
  assert.match(graph, /user turn -> tool start/);
  assert.match(graph, /tool start -> tool done/);

  const fallback = buildSessionDetailContent(baseSession, "flow", 58, baseSession.timestamp + 37_000);
  assert.match(fallback, /FLOW SIGNAL/);
  assert.match(fallback, /no structured flow reported/);
  assert.doesNotMatch(fallback, /EVENT LIST|HISTORY EVENTS|tool: npm run build|done: apply patch/);
});

test("flow renders canonical workflow events as flow data", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      workflow_events: [
        {
          timestamp: baseSession.timestamp + 32_000,
          source: "hook",
          raw_event: "PreCompress",
          canonical_stage_id: "context.compact.before",
          canonical_category: "context",
          canonical_direction: "before",
          mapping_type: "same_concept",
          confidence: "high",
        },
        {
          timestamp: baseSession.timestamp + 35_000,
          source: "hook",
          raw_event: "beforeShellExecution",
          canonical_stage_id: "tool.execute.before",
          canonical_category: "tool",
          canonical_direction: "before",
          mapping_type: "subtype",
          confidence: "high",
          notes: "Tool subtype: shell execution.",
        },
      ],
    },
    "flow",
    88,
    baseSession.timestamp + 37_000,
  );

  assert.match(content, /WORKFLOW EVENTS/);
  assert.match(content, /\|\s+Stage\s+\|\s+Raw\s+\|\s+Age\s+\|/);
  assert.match(content, /\|\s+tool\.execute\.before\s+\|\s+beforeShellExecution\s+\|\s+2s\s+\|/);
  assert.match(content, /\|\s+context\.compact\.before\s+\|\s+PreCompress\s+\|\s+5s\s+\|/);
  assert.doesNotMatch(content, /EVENT LIST|tool: npm run build/);
});

test("structured flow graph takes priority over workflow event buffer", () => {
  const content = buildSessionDetailContent(
    {
      ...baseSession,
      flow: {
        nodes: [
          { id: "prompt", label: "prompt" },
          { id: "tool", label: "tool" },
        ],
        edges: [{ from: "prompt", to: "tool" }],
      },
      workflow_events: [
        {
          timestamp: baseSession.timestamp + 35_000,
          raw_event: "PreCompress",
          canonical_stage_id: "context.compact.before",
          canonical_category: "context",
          canonical_direction: "before",
          mapping_type: "same_concept",
          confidence: "high",
        },
      ],
    },
    "flow",
    88,
    baseSession.timestamp + 37_000,
  );

  assert.match(content, /FLOW GRAPH/);
  assert.match(content, /prompt -> tool/);
  assert.doesNotMatch(content, /WORKFLOW EVENTS|PreCompress/);
});

test("scope tabs cycle and numeric keys map deterministically", () => {
  assert.equal(nextDetailTab("overview", 1), "activity");
  assert.equal(nextDetailTab("raw", 1), "overview");
  assert.equal(nextDetailTab("overview", -1), "raw");
  assert.equal(detailTabByNumber("3"), "usage");
  assert.equal(detailTabByNumber("4"), "flow");
  assert.equal(detailTabByNumber("5"), "raw");
  assert.equal(detailTabByNumber("6"), null);
  assert.equal(detailTabByNumber("9"), null);
});

test("scope bar renders active tab with inverse attributes", () => {
  const chunks = buildDetailScopeBarChunks("usage");
  assert.equal(chunks.map(chunk => chunk.text).join(""), "Overview | Activity | Usage | Flow | Raw");

  const active = chunks.find(chunk => chunk.text === "Usage");
  const inactive = chunks.find(chunk => chunk.text === "Overview");
  assert.ok(active, "active tab chunk is present");
  assert.ok(inactive, "inactive tab chunk is present");
  assert.equal((active.attributes ?? 0) & TextAttributes.INVERSE, TextAttributes.INVERSE);
  assert.equal((active.attributes ?? 0) & TextAttributes.BOLD, TextAttributes.BOLD);
  assert.equal((inactive.attributes ?? 0) & TextAttributes.INVERSE, 0);
});

test("raw tab includes full session id while overview keeps it compact", () => {
  const overview = buildSessionDetailContent(baseSession, "overview", 88, baseSession.timestamp + 37_000);
  const raw = buildSessionDetailContent(baseSession, "raw", 88, baseSession.timestamp + 37_000);
  assert.equal(overview.includes(baseSession.session_id), false);
  assert.equal(raw.includes(baseSession.session_id), true);
});

test("raw tab preserves full session id even in a narrow details panel", () => {
  const raw = buildSessionDetailContent(baseSession, "raw", 58, baseSession.timestamp + 37_000);
  assert.equal(raw.includes(baseSession.session_id), true);
});

test("fingerprints change on deterministic snapshot fields", () => {
  assert.notEqual(
    sessionFingerprint(baseSession),
    sessionFingerprint({ ...baseSession, tokens: baseSession.tokens + 1 }),
  );
});

test("fingerprints change on canonical usage fields", () => {
  const usageSession = {
    ...baseSession,
    input_tokens: 48200,
    output_tokens: 12800,
    cache_read_tokens: 1400000,
    cache_write_tokens: 185000,
    token_rate: 17000,
    quota_percent: 65,
    quota_reset: "5h38m",
  };
  for (const [key, value] of [
    ["input_tokens", 48201],
    ["output_tokens", 12801],
    ["cache_read_tokens", 1400001],
    ["cache_write_tokens", 185001],
    ["token_rate", 17001],
    ["quota_percent", 66],
    ["quota_reset", "5h37m"],
  ]) {
    assert.notEqual(
      sessionFingerprint(usageSession),
      sessionFingerprint({ ...usageSession, [key]: value }),
      `${key} should affect fingerprint`,
    );
  }
});

test("fingerprints change on hook event buffers", () => {
  assert.notEqual(
    sessionFingerprint(baseSession),
    sessionFingerprint({
      ...baseSession,
      unknown_events: [{ timestamp: baseSession.timestamp + 1, source: "hook", raw: { native: "payload" } }],
    }),
  );
  assert.notEqual(
    sessionFingerprint(baseSession),
    sessionFingerprint({
      ...baseSession,
      agent_signals: [{ signal: "provider_limit", timestamp: baseSession.timestamp + 1, used_percent: 65 }],
    }),
  );
  assert.notEqual(
    sessionFingerprint(baseSession),
    sessionFingerprint({
      ...baseSession,
      workflow_events: [{
        timestamp: baseSession.timestamp + 1,
        raw_event: "PreCompress",
        canonical_stage_id: "context.compact.before",
        canonical_category: "context",
        canonical_direction: "before",
        mapping_type: "same_concept",
        confidence: "high",
      }],
    }),
  );
});
