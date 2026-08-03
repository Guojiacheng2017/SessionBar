import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("report.sh maps canonical usage env fields into the status payload", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const project = join(root, "Vision-Dash");
  const capture = join(root, "payload.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    printf '%s' "$1" > "$SESSIONBAR_CAPTURE"
    exit 0
  fi
  shift
done
exit 1
`);
  execFileSync("chmod", ["755", join(bin, "curl")]);

  execFileSync("bash", ["report.sh", "working", "running: npm test", "8989"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      SESSIONBAR_CAPTURE: capture,
      SESSIONBAR_HOME: join(home, ".sessionbar"),
      SESSIONBAR_AGENT: "codex",
      SESSIONBAR_SESSION_TYPE: "Codex",
      SESSIONBAR_SESSION_ID: "codex-demo",
      SESSIONBAR_PROJECT_DIR: project,
      SESSIONBAR_CONTEXT_PERCENT: "72",
      SESSIONBAR_TOKENS: "1700000",
      SESSIONBAR_TURNS: "34",
      SESSIONBAR_INPUT_TOKENS: "48200",
      SESSIONBAR_OUTPUT_TOKENS: "12800",
      SESSIONBAR_CACHE_READ_TOKENS: "1400000",
      SESSIONBAR_CACHE_WRITE_TOKENS: "185000",
      SESSIONBAR_TOKEN_RATE: "17000",
      SESSIONBAR_QUOTA_PERCENT: "65",
      SESSIONBAR_QUOTA_RESET: "5h38m",
      SESSIONBAR_HOOK_EVENT: "PreToolUse",
      SESSIONBAR_AGENT_SIGNAL: "api_balance",
      SESSIONBAR_AGENT_SIGNAL_SOURCE: "provider_api",
      SESSIONBAR_AGENT_SIGNAL_SCOPE: "account",
      SESSIONBAR_AGENT_SIGNAL_KIND: "balance",
      SESSIONBAR_AGENT_REMAINING: "12.4",
      SESSIONBAR_AGENT_LIMIT: "100",
      SESSIONBAR_AGENT_UNIT: "USD",
      SESSIONBAR_AGENT_STATUS: "ok",
      SESSIONBAR_AGENT_LABEL: "Codex API",
    },
  });

  const payload = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(payload.context_percent, 72);
  assert.equal(payload.tokens, 1700000);
  assert.equal(payload.turns, 34);
  assert.equal(payload.input_tokens, 48200);
  assert.equal(payload.output_tokens, 12800);
  assert.equal(payload.cache_read_tokens, 1400000);
  assert.equal(payload.cache_write_tokens, 185000);
  assert.equal(payload.token_rate, 17000);
  assert.equal(payload.quota_percent, 65);
  assert.equal(payload.quota_reset, "5h38m");
  assert.equal(payload.hook_event, "PreToolUse");
  assert.deepEqual(payload.agent_signals, [{
    signal: "api_balance",
    source: "provider_api",
    scope: "account",
    kind: "balance",
    remaining: 12.4,
    limit: 100,
    unit: "USD",
    status: "ok",
    label: "Codex API",
  }]);
});
