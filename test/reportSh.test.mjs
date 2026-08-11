import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
      SESSIONBAR_CPU_PERCENT: "23.5",
      SESSIONBAR_GPU_PERCENT: "12",
      SESSIONBAR_MEMORY_PERCENT: "8.25",
      SESSIONBAR_MEMORY_BYTES: "805306368",
      SESSIONBAR_PROCESS_COUNT: "4",
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
  assert.equal(payload.runtime.cpu_percent, 23.5);
  assert.equal(payload.runtime.gpu_percent, 12);
  assert.equal(payload.runtime.memory_percent, 8.25);
  assert.equal(payload.runtime.memory_bytes, 805306368);
  assert.equal(payload.runtime.process_count, 4);
  assert.equal(typeof payload.runtime.sampled_at, "number");
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

test("report.sh persists an overridden process root marker", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-process-root-"));
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

  execFileSync("bash", ["report.sh", "working", "persist process root", "8989"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      SESSIONBAR_CAPTURE: capture,
      SESSIONBAR_HOME: join(home, ".sessionbar"),
      SESSIONBAR_AGENT: "codex",
      SESSIONBAR_SESSION_ID: "codex-demo",
      SESSIONBAR_PROJECT_DIR: project,
      SESSIONBAR_PROCESS_PID: "4242",
    },
  });

  const payload = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(payload.process_pid, 4242);

  const markerDir = join(home, ".sessionbar", "sessions");
  const processMarkers = readdirSync(markerDir).filter(file => file.startsWith("sessionbar-process-"));
  assert.equal(processMarkers.length, 1);
  assert.equal(readFileSync(join(markerDir, processMarkers[0]), "utf8"), "4242\n");
});

test("report.sh omits a process root when no owning agent ancestor is found", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-no-process-root-"));
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
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["755", join(bin, "curl")]);
  execFileSync("chmod", ["755", join(bin, "ps")]);

  execFileSync("bash", ["report.sh", "working", "discover process root", "8989"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      SESSIONBAR_CAPTURE: capture,
      SESSIONBAR_HOME: join(home, ".sessionbar"),
      SESSIONBAR_AGENT: "codex",
      SESSIONBAR_SESSION_ID: "codex-demo",
      SESSIONBAR_PROJECT_DIR: project,
      SESSIONBAR_PROCESS_PID: "",
      AGENTBAR_PROCESS_PID: "",
    },
  });

  const payload = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(payload.process_pid, undefined);

  const markerDir = join(home, ".sessionbar", "sessions");
  assert.equal(readdirSync(markerDir).some(file => file.startsWith("sessionbar-process-")), false);
});

test("report.sh discovers a Codex process root from the complete command line", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-command-process-root-"));
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
  writeFileSync(join(bin, "ps"), `#!/bin/sh
case "$*" in
  *"comm="*) printf '%s\\n' '/Applications/Ch' ;;
  *"command="*) printf '%s\\n' '/Applications/ChatGPT.app/Contents/Resources/CoDeX -c hook-runner' ;;
esac
`);
  execFileSync("chmod", ["755", join(bin, "curl")]);
  execFileSync("chmod", ["755", join(bin, "ps")]);

  execFileSync("bash", ["report.sh", "working", "discover process root", "8989"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      SESSIONBAR_CAPTURE: capture,
      SESSIONBAR_HOME: join(home, ".sessionbar"),
      SESSIONBAR_AGENT: "CoDeX",
      SESSIONBAR_SESSION_ID: "codex-demo",
      SESSIONBAR_PROJECT_DIR: project,
      SESSIONBAR_PROCESS_PID: "",
      AGENTBAR_PROCESS_PID: "",
    },
  });

  const payload = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(payload.process_pid, process.pid);
});

test("report.sh reuses the hook session id when hook invocations have different parents", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-hook-id-"));
  const home = join(root, "home");
  const project = join(root, "Vision-Dash");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    SESSIONBAR_HOME: join(home, ".sessionbar"),
    SESSIONBAR_AGENT: "codex",
    SESSIONBAR_SESSION_TYPE: "Codex",
    SESSIONBAR_PROJECT_DIR: project,
    SESSIONBAR_SERVER_PORT: "1",
  };
  const hookInput = `${JSON.stringify({ session_id: "019fdb88-8209-7b32-8816-cf684186fde1" })}\n`;
  const args = ["-c", "sleep 0.2 & cat | bash /Users/jcus/Documents/Jcus/Vision-Dash/0agentbar/report.sh working probe 1"];

  execFileSync("bash", args, { cwd: new URL("..", import.meta.url), env, input: hookInput });
  execFileSync("bash", args, { cwd: new URL("..", import.meta.url), env, input: hookInput });

  const markerDir = join(home, ".sessionbar", "sessions");
  const markers = readdirSync(markerDir).filter(file => file.startsWith("sessionbar-id-"));
  assert.equal(markers.length, 1);
  assert.equal(readFileSync(join(markerDir, markers[0]), "utf8"), "019fdb88-8209-7b32-8816-cf684186fde1__Vision-Dash\n");
});
