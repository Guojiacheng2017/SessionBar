# Remote Harness Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a remote harness telemetry registry so SessionBar can show user-registered cloud/self-hosted harnesses and their sessions without discovering environments or consuming model tokens.

**Architecture:** Remote harnesses are configured resources, not detected resources. SessionBar persists registrations in `SESSIONBAR_HOME`, accepts lightweight push telemetry from harnesses, derives remote session rows from telemetry, and exposes live harness state through read-only API/CLI surfaces. The protocol stays intentionally smaller than OpenTelemetry, while keeping field names and extension points compatible with future OTLP/OpenTelemetry fan-in.

**Tech Stack:** TypeScript 5.7, Node.js 22 APIs, Express 5, existing Node test runner, JSON persistence with atomic rename, existing SessionPayload/session reducer types.

## Global Constraints

- Remote harnesses must never be marked available by environment probing.
- Remote harness registration is user-driven or automation-driven.
- Telemetry must be metadata-only by default: no prompt, response, message body, tool arguments, or model-generated summaries.
- Session identity must be `harnessInstanceId + remoteSessionId`; never rely on global uniqueness of remote session IDs.
- Telemetry ingestion must not call model/provider APIs and must not consume tokens.
- Existing `/session/status` hook behavior must remain backward compatible.
- The first implementation should use SessionBar-local JSON files, not add a database.
- Secrets must not be stored in JSON; store only secret references or auth mode.

---

## Research Notes

Current ecosystem direction:

- OpenTelemetry is the center of gravity. The OpenTelemetry Collector is the standard vendor-neutral path for receiving, processing, batching, retrying, filtering, and exporting telemetry.
- GenAI-specific semantic conventions exist for attributes like provider, operation, model, conversation/session identifiers, token counts, agent invocation, and tool execution. Input/output messages and tool arguments are explicitly sensitive and opt-in.
- LangSmith, Phoenix/OpenInference, OpenLLMetry/Traceloop, Langfuse, and Vercel AI SDK all converge on OpenTelemetry-compatible tracing, often with GenAI-specific helper layers.

SessionBar implication:

- Do not implement full trace ingestion first. SessionBar needs live operational telemetry, not prompt debugging traces.
- Use a narrow protocol: registry, heartbeat, session delta/snapshot, stale timeout.
- Leave an OTLP bridge for later: future adapter can map OTLP spans/events into the same internal telemetry schema.

Primary sources reviewed:

- OpenTelemetry Collector: https://opentelemetry.io/docs/collector/
- OpenTelemetry GenAI attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
- OpenTelemetry GenAI spans source: https://github.com/open-telemetry/semantic-conventions/blob/main/model/gen-ai/spans.yaml
- LangSmith OpenTelemetry tracing: https://docs.langchain.com/langsmith/trace-with-opentelemetry
- Phoenix/OpenInference OTEL setup: https://www.arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-using-phoenix-otel
- OpenInference repository: https://github.com/Arize-ai/openinference
- OpenLLMetry introduction: https://docs.traceloop.com/docs/openllmetry/introduction
- Traceloop OTEL collector integration: https://docs.traceloop.com/docs/openllmetry/integrations/traceloop
- Langfuse OTEL SDK overview: https://langfuse.com/docs/observability/sdk/overview
- Vercel AI SDK telemetry: https://vercel-ai.mintlify.app/ai-sdk-core/telemetry

## File Structure

- Create `harnessRegistry.ts`: pure types, validation, load/save for remote harness registrations.
- Create `harnessTelemetry.ts`: pure telemetry schemas, reducer, stale timeout, conversion to `SessionPayload`.
- Create `test/harnessRegistry.test.mjs`: persistence, validation, no-secret storage, idempotent registration tests.
- Create `test/harnessTelemetry.test.mjs`: heartbeat/session delta reducer and stale timeout tests.
- Modify `types.ts`: add `origin`, `harness_instance_id`, `remote_session_id`, and `source: "remote_telemetry"` support to `SessionPayload`.
- Modify `server.ts`: add `/harnesses/register`, `/harnesses/telemetry`, `/harnesses/live`; merge derived remote sessions into `/sessions/live`.
- Modify `hookManager.ts`: replace remote availability wording with registry-backed configured counts.
- Modify `cli.ts`: add `sessionbar harness remote list|add|remove` and update `sessionbar harnesses` display.
- Modify `README.md`: document remote telemetry contract and privacy boundary.

## Protocol Draft

Registration:

```ts
type RemoteHarnessRegistration = {
  harnessInstanceId: string;
  harnessType: "claude" | "codex" | "gemini" | "copilot" | "workbuddy" | "custom";
  label: string;
  endpointUrl?: string;
  authType: "none" | "bearer" | "api_key";
  authRef?: string;
  capabilities: Array<"sessions" | "heartbeat" | "resource_usage" | "quota" | "logs_ref">;
  registeredBy: "user" | "automation";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};
```

Telemetry:

```ts
type HarnessTelemetryEnvelope = {
  harnessInstanceId: string;
  sentAt: number;
  status: "online" | "degraded" | "offline";
  sequence?: number;
  heartbeat?: {
    sessionCount: number;
    activeSessionIds: string[];
  };
  sessions?: Array<{
    remoteSessionId: string;
    status: "working" | "idle" | "blocked" | "error";
    project?: string;
    projectPath?: string;
    taskName?: string;
    updatedAt: number;
    startedAt?: number;
    endedAt?: number;
  }>;
};
```

Derived session ID:

```ts
const sessionId = `${harnessInstanceId}:${remoteSessionId}`;
```

### Task 1: Registry Persistence

**Files:**
- Create: `harnessRegistry.ts`
- Test: `test/harnessRegistry.test.mjs`

**Interfaces:**
- Produces: `loadHarnessRegistry(path: string): HarnessRegistry`
- Produces: `saveHarnessRegistry(path: string, registry: HarnessRegistry): void`
- Produces: `upsertRemoteHarness(registry: HarnessRegistry, input: RemoteHarnessRegistrationInput, now?: number): HarnessRegistry`
- Produces: `removeRemoteHarness(registry: HarnessRegistry, harnessInstanceId: string, now?: number): HarnessRegistry`
- Produces: `validateRemoteHarnessRegistration(value: unknown): value is RemoteHarnessRegistrationInput`

- [ ] **Step 1: Write failing tests for registry validation**

```js
test("remote harness registration accepts configured resources and rejects secrets", () => {
  const valid = {
    harnessInstanceId: "rh_codex_vps",
    harnessType: "codex",
    label: "Codex VPS",
    endpointUrl: "https://codex.example.com",
    authType: "bearer",
    authRef: "SESSIONBAR_REMOTE_CODEX_TOKEN",
    capabilities: ["sessions", "heartbeat"],
    registeredBy: "user",
    enabled: true
  };
  assert.equal(validateRemoteHarnessRegistration(valid), true);
  assert.equal(validateRemoteHarnessRegistration({ ...valid, token: "secret" }), false);
  assert.equal(validateRemoteHarnessRegistration({ ...valid, endpointUrl: "file:///tmp/x" }), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/harnessRegistry.test.mjs`
Expected: FAIL because `harnessRegistry.ts` does not exist.

- [ ] **Step 3: Implement registry types and validation**

Create `harnessRegistry.ts` with exact exported types and validators. Reject unknown secret-like fields named `token`, `apiKey`, `secret`, `password`, `authorization`, or `headers`.

- [ ] **Step 4: Write failing tests for atomic persistence and idempotent upsert**

```js
test("registry upsert is idempotent and preserves createdAt", () => {
  const first = upsertRemoteHarness({ version: 1, harnesses: [] }, baseInput, 1000);
  const second = upsertRemoteHarness(first, { ...baseInput, label: "Renamed" }, 2000);
  assert.equal(second.harnesses.length, 1);
  assert.equal(second.harnesses[0].createdAt, 1000);
  assert.equal(second.harnesses[0].updatedAt, 2000);
  assert.equal(second.harnesses[0].label, "Renamed");
});
```

- [ ] **Step 5: Implement load/save/upsert/remove**

Use the same atomic write pattern as `providerUsageHistory.ts`: write `path.tmp`, then `renameSync`.

- [ ] **Step 6: Run registry tests**

Run: `npm run build && node --test test/harnessRegistry.test.mjs`
Expected: PASS.

### Task 2: Telemetry Reducer

**Files:**
- Create: `harnessTelemetry.ts`
- Test: `test/harnessTelemetry.test.mjs`
- Modify: `types.ts`

**Interfaces:**
- Consumes: `RemoteHarnessRegistration` from `harnessRegistry.ts`
- Produces: `validateHarnessTelemetryEnvelope(value: unknown): value is HarnessTelemetryEnvelope`
- Produces: `applyHarnessTelemetry(state: HarnessTelemetryState, envelope: HarnessTelemetryEnvelope, now?: number): HarnessTelemetryState`
- Produces: `remoteSessionsFromTelemetry(registry: HarnessRegistry, state: HarnessTelemetryState, now?: number): SessionPayload[]`

- [ ] **Step 1: Write failing telemetry validation tests**

```js
test("telemetry envelope rejects prompt and output content", () => {
  const valid = {
    harnessInstanceId: "rh_codex_vps",
    sentAt: 1000,
    status: "online",
    heartbeat: { sessionCount: 1, activeSessionIds: ["s1"] },
    sessions: [{ remoteSessionId: "s1", status: "working", taskName: "npm test", updatedAt: 1000 }]
  };
  assert.equal(validateHarnessTelemetryEnvelope(valid), true);
  assert.equal(validateHarnessTelemetryEnvelope({ ...valid, prompt: "secret" }), false);
  assert.equal(validateHarnessTelemetryEnvelope({ ...valid, sessions: [{ ...valid.sessions[0], output: "secret" }] }), false);
});
```

- [ ] **Step 2: Modify `types.ts` for remote session fields**

Add:

```ts
export type SessionSource = "hook" | "codex_jsonl" | "remote_telemetry";
export type SessionOrigin = "local" | "remote";
```

Update `SessionPayload`:

```ts
source?: SessionSource;
origin?: SessionOrigin;
harness_instance_id?: string;
remote_session_id?: string;
```

- [ ] **Step 3: Implement reducer state and validation**

Keep state in memory:

```ts
export interface HarnessTelemetryState {
  harnesses: Record<string, {
    status: "online" | "degraded" | "offline";
    lastSeenAt: number;
    sequence?: number;
    sessions: Record<string, RemoteSessionTelemetry>;
  }>;
}
```

- [ ] **Step 4: Write failing tests for session derivation**

```js
test("remote sessions derive stable global ids without token work", () => {
  const registry = { version: 1, harnesses: [{ ...registeredHarness, enabled: true }] };
  const state = applyHarnessTelemetry(emptyTelemetryState(), envelope, 1000);
  const sessions = remoteSessionsFromTelemetry(registry, state, 1000);
  assert.equal(sessions[0].session_id, "rh_codex_vps:s1");
  assert.equal(sessions[0].origin, "remote");
  assert.equal(sessions[0].source, "remote_telemetry");
  assert.equal(sessions[0].harness_instance_id, "rh_codex_vps");
  assert.equal(sessions[0].remote_session_id, "s1");
});
```

- [ ] **Step 5: Implement stale timeout behavior**

Rules:
- Harness stale after 120 seconds without telemetry: mark `degraded`.
- Harness offline after 300 seconds without telemetry: mark `offline`.
- Session stale after 300 seconds without update: keep row but set `status: "idle"` and `task_name: "Stale remote session"`.

- [ ] **Step 6: Run telemetry tests**

Run: `npm run build && node --test test/harnessTelemetry.test.mjs`
Expected: PASS.

### Task 3: Server API

**Files:**
- Modify: `server.ts`
- Test: `test/serverHarnessTelemetry.test.mjs`

**Interfaces:**
- Consumes: registry and telemetry functions from Tasks 1-2.
- Produces: `POST /harnesses/register`
- Produces: `POST /harnesses/telemetry`
- Produces: `GET /harnesses/live`
- Extends: `GET /sessions/live` to include derived remote sessions.

- [ ] **Step 1: Write failing source-level route tests**

```js
test("server exposes remote harness telemetry routes", () => {
  assert.match(serverSource, /app\.post\("\/harnesses\/register"/);
  assert.match(serverSource, /app\.post\("\/harnesses\/telemetry"/);
  assert.match(serverSource, /app\.get\("\/harnesses\/live"/);
});
```

- [ ] **Step 2: Add state constants in `server.ts`**

Add:

```ts
const HARNESS_REGISTRY_PATH = join(HOME, "remote-harnesses.json");
let harnessRegistry = loadHarnessRegistry(HARNESS_REGISTRY_PATH);
let harnessTelemetryState = emptyHarnessTelemetryState();
```

- [ ] **Step 3: Implement `POST /harnesses/register`**

Behavior:
- Validate payload.
- Upsert into registry with `registeredBy` preserved from payload.
- Save registry.
- Broadcast SSE.
- Return `{ ok: true, harness: savedHarness }`.

- [ ] **Step 4: Implement `POST /harnesses/telemetry`**

Behavior:
- Validate payload.
- Reject unknown `harnessInstanceId` with HTTP 404.
- Ignore disabled harnesses with HTTP 202 `{ ok: true, ignored: true }`.
- Apply reducer.
- Broadcast SSE.
- Return `{ ok: true }`.

- [ ] **Step 5: Implement `GET /harnesses/live`**

Return:

```json
{
  "harnesses": [
    {
      "harnessInstanceId": "rh_codex_vps",
      "harnessType": "codex",
      "label": "Codex VPS",
      "enabled": true,
      "status": "online",
      "lastSeenAt": 1000,
      "sessionCount": 1
    }
  ]
}
```

- [ ] **Step 6: Merge remote sessions into `/sessions/live`**

Change:

```ts
res.json(sorted());
```

To:

```ts
res.json(sortedWithRemoteSessions());
```

Implement `sortedWithRemoteSessions()` as local `sorted()` plus `remoteSessionsFromTelemetry(...)`, sorted by existing stable sort.

- [ ] **Step 7: Run server tests**

Run: `npm run build && node --test test/serverHarnessTelemetry.test.mjs test/serverRuntime.test.mjs`
Expected: PASS.

### Task 4: CLI Management Surface

**Files:**
- Modify: `cli.ts`
- Modify: `hookManager.ts`
- Test: `test/cliLifecycle.test.mjs`

**Interfaces:**
- Consumes: `GET /harnesses/live` shape from Task 3.
- Produces: `sessionbar harness remote list`
- Produces: `sessionbar harness remote add --type codex --label "Codex VPS" --url https://codex.example.com`
- Produces: `sessionbar harness remote remove rh_codex_vps`
- Updates: `sessionbar harnesses` to show local installed rows plus remote registered/configurable rows.

- [ ] **Step 1: Write failing CLI source tests**

```js
test("remote harness CLI supports list add and remove", () => {
  assert.match(cliSource, /case "harness":/);
  assert.match(cliSource, /remoteHarnessList/);
  assert.match(cliSource, /remoteHarnessAdd/);
  assert.match(cliSource, /remoteHarnessRemove/);
});
```

- [ ] **Step 2: Implement argument parser helpers**

Add simple helpers:

```ts
function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
```

- [ ] **Step 3: Implement `remoteHarnessAdd`**

Generate deterministic-ish id:

```ts
const harnessInstanceId = `rh_${type}_${Date.now().toString(36)}`;
```

POST to `/harnesses/register`; if server is not running, use `ensureServerRunning()`.

- [ ] **Step 4: Implement `remoteHarnessList`**

GET `/harnesses/live`; print label, type, enabled, status, last seen, session count.

- [ ] **Step 5: Implement remove path**

Either:
- Add `DELETE /harnesses/:id` in Task 3 before this step, or
- POST register with `enabled: false`.

Prefer adding `DELETE /harnesses/:id` in Task 3 if implementing this plan strictly.

- [ ] **Step 6: Run CLI lifecycle tests**

Run: `npm run build && node --test test/cliLifecycle.test.mjs`
Expected: PASS.

### Task 5: Documentation and Example Harness Script

**Files:**
- Modify: `README.md`
- Create: `examples/remote-harness-register.sh`
- Create: `examples/remote-harness-telemetry.json`
- Test: `test/readmeContract.test.mjs`

**Interfaces:**
- Documents the protocol from Tasks 1-4.
- Provides copy-paste examples without secrets.

- [ ] **Step 1: Write documentation contract test**

```js
test("README documents remote harness telemetry privacy boundary", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /Remote harness telemetry/);
  assert.match(readme, /SessionBar does not discover remote harnesses/);
  assert.match(readme, /Do not send prompts, responses, tool arguments, or secrets/);
});
```

- [ ] **Step 2: Add README section**

Include:
- Remote registration purpose.
- Manual registration command.
- Automation registration curl.
- Telemetry curl.
- Session identity rule.
- Privacy/token boundary.
- Stale timeout values.

- [ ] **Step 3: Add example registration shell script**

Create `examples/remote-harness-register.sh`:

```sh
#!/usr/bin/env sh
set -eu

SESSIONBAR_URL="${SESSIONBAR_URL:-http://127.0.0.1:8989}"

curl -sS -X POST "$SESSIONBAR_URL/harnesses/register" \
  -H 'content-type: application/json' \
  -d '{
    "harnessInstanceId": "rh_codex_vps",
    "harnessType": "codex",
    "label": "Codex VPS",
    "endpointUrl": "https://codex.example.com",
    "authType": "none",
    "capabilities": ["sessions", "heartbeat"],
    "registeredBy": "automation",
    "enabled": true
  }'
```

- [ ] **Step 4: Add example telemetry JSON**

Create `examples/remote-harness-telemetry.json` with the Protocol Draft telemetry payload.

- [ ] **Step 5: Run docs test**

Run: `npm run build && node --test test/readmeContract.test.mjs`
Expected: PASS.

### Task 6: Full Regression

**Files:**
- No new files.

**Interfaces:**
- Verifies all prior tasks together.

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Manually smoke test local and remote views**

Run:

```sh
node dist/cli/cli.js start
node dist/cli/cli.js harness remote add --type codex --label "Codex VPS" --url https://codex.example.com
curl -sS -X POST http://127.0.0.1:8989/harnesses/telemetry -H 'content-type: application/json' -d @examples/remote-harness-telemetry.json
node dist/cli/cli.js harness remote list
curl -sS http://127.0.0.1:8989/sessions/live
```

Expected:
- Remote harness appears as registered/configured.
- Remote telemetry status appears online.
- `/sessions/live` contains `rh_codex_vps:<remoteSessionId>`.
- No prompt/content fields are accepted or displayed.

- [ ] **Step 3: Commit**

```bash
git add harnessRegistry.ts harnessTelemetry.ts types.ts server.ts cli.ts hookManager.ts README.md examples test
git commit -m "feat: add remote harness telemetry registry"
```

## Self-Review

- Spec coverage: The plan covers remote as user/automation registration, metadata-only telemetry, no environment discovery, no token-consuming provider calls, session identity, stale handling, API/CLI/docs.
- Placeholder scan: No TBD/TODO placeholders remain. Task 4 has an explicit design choice for delete; implementer should prefer adding `DELETE /harnesses/:id` in Task 3.
- Type consistency: `harnessInstanceId`, `remoteSessionId`, `source: "remote_telemetry"`, and `origin: "remote"` are used consistently across tasks.

