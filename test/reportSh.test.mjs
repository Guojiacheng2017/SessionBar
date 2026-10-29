import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Codex child hooks do not create top-level markers or status reports", t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-codex-child-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nprintf posted > "$SESSIONBAR_CAPTURE"\n', { mode: 0o755 });
  const parent = "11111111-1111-4111-8111-111111111111";
  const child = "22222222-2222-4222-8222-222222222222";
  for (const [name, thread, input, expected] of [
    ["child-env", child, "", false],
    ["child-input", child, JSON.stringify({ session_id: child }) + "\n", false],
    ["parent", parent, "", true],
    ["explicit-other", child, JSON.stringify({ session_id: "other-native-session" }) + "\n", true],
  ]) {
    const state = join(root, name), capture = join(root, name + ".posted");
    execFileSync("bash", ["report.sh", "working", "Probe", "8989"], {
      cwd: new URL("..", import.meta.url), input,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
        SESSIONBAR_HOME: state, SESSIONBAR_PROJECT_DIR: "/fixture/project",
        SESSIONBAR_AGENT: "codex", SESSIONBAR_CAPTURE: capture,
        SESSIONBAR_SESSION_ID: "", AGENTBAR_SESSION_ID: "",
        CODEX_THREAD_ID: thread, CODEX_SESSION_ID: parent },
    });
    assert.equal(existsSync(capture), expected, name + " report");
    assert.equal(existsSync(join(state, "sessions")), expected, name + " marker directory");
  }
});

test('ordinary Codex hooks capture wait metadata with the relay off and ignore stale parent environment IDs',t=>{
 const dir=mkdtempSync(join(tmpdir(),'sessionbar-codex-auto-report-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const root='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222',stale='33333333-3333-4333-8333-333333333333';
 const home=join(dir,'home'),codex=join(home,'.codex'),sessions=join(codex,'sessions'),state=join(home,'.sessionbar');mkdirSync(sessions,{recursive:true});
 const transcript=join(sessions,'root.jsonl');writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:root,cwd:dir,source:'cli'}})+'\n');
 const event={hook_event_name:'PreToolUse',session_id:root,turn_id:stale,transcript_path:transcript,cwd:dir,tool_name:'multi_agent_v1wait_agent',tool_use_id:'exact-native-id',tool_input:{targets:[child],prompt:'PRIVATE'}};
 const env={...process.env,HOME:home,CODEX_HOME:codex,CODEX_THREAD_ID:stale,CODEX_SESSION_ID:stale,SESSIONBAR_HOME:state,AGENTBAR_HOME:'',SESSIONBAR_CODEX_HOOK_EVENTS_DIR:'',SESSIONBAR_AGENT:'codex',SESSIONBAR_PORT:'',SESSION_BAR_PORT:''};
 const result=execFileSync('bash',['report.sh'],{cwd:new URL('..',import.meta.url),input:JSON.stringify(event)+'\n',env,encoding:'utf8'});assert.equal(result,'');
 const saved=readFileSync(join(state,'codex-hooks',root+'.jsonl'),'utf8');assert.match(saved,/exact-native-id/);assert.doesNotMatch(saved,/PRIVATE/);assert.equal(existsSync(join(state,'sessions')),false);
 const bin=join(dir,'bin'),capture=join(dir,'posted');mkdirSync(bin);writeFileSync(join(bin,'curl'),'#!/bin/sh\ntouch "$SESSIONBAR_CAPTURE"\n',{mode:0o755});
 execFileSync('bash',['report.sh','working','Probe','8989'],{cwd:new URL('..',import.meta.url),input:JSON.stringify({...event,agent_id:child})+'\n',env:{...env,PATH:bin+':'+process.env.PATH,SESSIONBAR_CAPTURE:capture}});assert.equal(existsSync(capture),false,'child payload identity suppresses root status even when inherited env is stale');
});

test("report.sh maps canonical usage env fields into the status payload", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const project = join(root, "atlas");
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

test("report.sh omits runtime when an active hook supplies no explicit metrics", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-no-runtime-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const project = join(root, "atlas");
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

  execFileSync("bash", ["report.sh", "working", "ordinary active hook", "8989"], {
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
      SESSIONBAR_CPU_PERCENT: "",
      SESSIONBAR_GPU_PERCENT: "",
      SESSIONBAR_MEMORY_PERCENT: "",
      SESSIONBAR_MEMORY_BYTES: "",
      SESSIONBAR_PROCESS_COUNT: "",
      AGENTBAR_CPU_PERCENT: "",
      AGENTBAR_GPU_PERCENT: "",
      AGENTBAR_MEMORY_PERCENT: "",
      AGENTBAR_MEMORY_BYTES: "",
      AGENTBAR_PROCESS_COUNT: "",
    },
  });

  const payload = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(payload.runtime, undefined);
});

test("report.sh ignores process roots without sidecars or process lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-process-root-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const project = join(root, "atlas");
  const capture = join(root, "payload.json");
  const processLookup = join(root, "process-lookup.txt");
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
printf 'called\n' > "$SESSIONBAR_PROCESS_LOOKUP"
exit 1
`);
  execFileSync("chmod", ["755", join(bin, "curl")]);
  execFileSync("chmod", ["755", join(bin, "ps")]);

  execFileSync("bash", ["report.sh", "working", "persist process root", "8989"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      SESSIONBAR_CAPTURE: capture,
      SESSIONBAR_PROCESS_LOOKUP: processLookup,
      SESSIONBAR_HOME: join(home, ".sessionbar"),
      SESSIONBAR_AGENT: "codex",
      SESSIONBAR_SESSION_ID: "codex-demo",
      SESSIONBAR_PROJECT_DIR: project,
      SESSIONBAR_PROCESS_PID: "4242",
    },
  });

  const payload = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(payload.process_pid, undefined);

  const markerDir = join(home, ".sessionbar", "sessions");
  const retiredMarkerPrefix = ["sessionbar", "process", ""].join("-");
  const processMarkers = readdirSync(markerDir).filter(file => file.startsWith(retiredMarkerPrefix));
  assert.equal(processMarkers.length, 0);
  assert.equal(readdirSync(root).includes("process-lookup.txt"), false);
});

test("report.sh reuses the hook session id when hook invocations have different parents", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-hook-id-"));
  const home = join(root, "home");
  const project = join(root, "atlas");
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
  const hookInput = `${JSON.stringify({ session_id: "22222222-2222-4222-8222-222222222222" })}\n`;
  const args = ["-c", 'sleep 0.2 & cat | bash "$1" working probe 1', "report-test", fileURLToPath(new URL("../report.sh", import.meta.url))];

  execFileSync("bash", args, { cwd: new URL("..", import.meta.url), env, input: hookInput });
  execFileSync("bash", args, { cwd: new URL("..", import.meta.url), env, input: hookInput });

  const markerDir = join(home, ".sessionbar", "sessions");
  const markers = readdirSync(markerDir).filter(file => file.startsWith("sessionbar-id-"));
  assert.equal(markers.length, 1);
  assert.equal(readFileSync(join(markerDir, markers[0]), "utf8"), "22222222-2222-4222-8222-222222222222__atlas\n");
});

test("report.sh maps Cursor conversation and Grok model metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-report-cursor-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const project = join(root, "project");
  const capture = join(root, "payload.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then shift; printf '%s' "$1" > "$SESSIONBAR_CAPTURE"; exit 0; fi
  shift
done
exit 1
`);
  execFileSync("chmod", ["755", join(bin, "curl")]);

  execFileSync("bash", ["report.sh", "working", "Working", "8989"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      SESSIONBAR_CAPTURE: capture,
      SESSIONBAR_HOME: join(home, ".sessionbar"),
      SESSIONBAR_AGENT: "cursor",
      SESSIONBAR_SESSION_TYPE: "Cursor",
      SESSIONBAR_PROJECT_DIR: project,
    },
    input: `${JSON.stringify({ conversation_id: "cursor-conversation-1", model: "grok-4.7" })}\n`,
  });

  const payload = JSON.parse(readFileSync(capture, "utf8"));
  assert.match(payload.session_id, /^cursor-conversation-1__/);
  assert.equal(payload.model_provider, "grok");
});
