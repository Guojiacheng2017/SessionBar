import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bridge = fileURLToPath(new URL("../scripts/docs/ptyBridge.py", import.meta.url));
const landing = new URL("../dist/cli/landingMenu.js", import.meta.url).href;

async function runCase({ supported, skip = false, rows = 40, loop = false, animate = true, command, cancel = false }) {
  const fixture = `
    import { runLandingMenu } from ${JSON.stringify(landing)};
    await runLandingMenu({
      tty: true, colorEnabled: true, animateLogo: ${animate},
      formatAge: () => '2m', agentName: type => type,
      projectLabel: session => session.project, statusShort: () => 'IDLE',
      statusStyle: () => ({ c: '', icon: 'o', label: 'idle' }),
      ensureAppRunning: async () => true,
      fetchSessions: async () => ({ sessions: [{ session_type: 'Codex', project: 'SessionBar', status: 'idle' }] }),
      fetchWebStatus: async () => true, pidAlive: () => true,
      launchMonitor: async view => { console.log('ACTION:' + view); }, launchSetup: async () => {
        console.log('ACTION:begin');
        await new Promise(resolve => setTimeout(resolve, 600));
        console.log('ACTION:setup');
      },
      launchStatus: async () => {}, launchSettings: async () => {}, launchWeb: async () => {},
      teardownHooks: async () => {}, getPort: () => 8989,
    });
  `;
  const child = spawn("python3", [bridge, String(rows), "84", process.execPath, "--input-type=module", "-e", fixture], {
    env: { ...process.env, NO_COLOR: "", TMUX: "", STY: "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", error = "", replied = false, acted = false, watching = false, idleStable = false, cancelled = false, commandQuit = false;
  let idleTimer, idleCheck, quitTimer;
  let timedOut = false;
  const skipping = skip;
  const send = text => child.stdin.write(`${JSON.stringify(text)}\n`);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`PTY exit ${code}: ${error}`)));
  });
  child.stderr.on("data", chunk => { error += chunk; });
  child.stdout.on("data", chunk => {
    output += chunk;
    const query = /\x1b_Ga=q,i=(\d+)/.exec(output);
    if (query && !replied) {
      replied = true;
      if (supported) send(`\x1b_Gi=${query[1]};OK\x1b\\\x1b[6;28;14t\x1b]11;rgb:ffff/ffff/ffff\x07`);
    }
    if (skip && !acted && /\x1b_Ga=T/.test(output)) { acted = true; send("2"); }
    if (skip && output.includes("ACTION:setup")) { skip = false; quitTimer = setTimeout(() => send("q"), 100); }
    if (command && !acted && output.includes("Commands")) {
      acted = true;
      send(cancel ? ":quit" : `:${command}\r`);
    }
    if (command && cancel && !cancelled && output.includes("> quit_")) {
      cancelled = true;
      send("\x1b");
      quitTimer = setTimeout(() => send("2"), 100);
    }
    if (command && !commandQuit && output.includes(`ACTION:${cancel ? "setup" : command}`)) {
      commandQuit = true;
      quitTimer = setTimeout(() => send("q"), 100);
    }
    if (loop && !acted && output.includes("Commands")) {
      acted = true;
      quitTimer = setTimeout(() => send("q"), 3600);
    }
    if (!skip && !acted && output.includes("Commands")) {
      acted = true;
      watching = true;
    }
    if (watching) {
      clearTimeout(idleTimer); clearTimeout(idleCheck);
      idleTimer = setTimeout(() => {
        const size = output.length;
        idleCheck = setTimeout(() => { idleStable = output.length === size; watching = false; send("q"); }, 200);
      }, 250);
    }
  });
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 6000);
  try { await done; } finally { clearTimeout(timeout); clearTimeout(idleTimer); clearTimeout(idleCheck); clearTimeout(quitTimer); }
  assert.equal(timedOut, false, "menu should exit from its quit key, not a timeout signal");
  if (!skipping && !loop && !command) assert.ok(idleStable, "static menu must stop redrawing");
  assert.match(output, /\x1b\[\?25h/, "cursor is restored on exit");
  return output;
}

test("landing keeps a slow particle loop without redrawing menu panels", async () => {
  const output = await runCase({ supported: true, loop: true });
  const frames = output.match(/\x1b_Ga=T/g) || [];
  // The intro contributes 37 frames; rasterization speed affects how many
  // ambient frames fit before the quit deadline. Any extra frame proves looping.
  assert.ok(frames.length > 37 && frames.length <= 50, `${frames.length} image frames`);
  assert.equal((output.match(/Commands/g) || []).length, 1);
  assert.match(output, /a=d,d=I,i=\d+/);
  assert.doesNotMatch(output, /[\u2801-\u28ff]/);
});

test("menu keys skip particle intro and execute the requested action", async () => {
  const output = await runCase({ supported: true, skip: true });
  assert.match(output, /ACTION:setup/);
  assert.ok((output.match(/\x1b_Ga=T/g) || []).length <= 4);
  assert.doesNotMatch(output.split("ACTION:begin")[1].split("ACTION:setup")[0], /\x1b_Ga=T/);
});

test("disabled animation sends one static particle frame and no loop", async () => {
  const output = await runCase({ supported: true, animate: false });
  assert.equal((output.match(/\x1b_Ga=T/g) || []).length, 1);
});

test("unsupported terminals retain the character wordmark", async () => {
  const output = await runCase({ supported: false });
  assert.match(output, /[\u2801-\u28ff]/);
  assert.doesNotMatch(output, /\x1b_Ga=T/);
});

test("80x24 landing keeps the compact wordmark without graphics probes", async () => {
  const output = await runCase({ supported: false, rows: 24 });
  assert.doesNotMatch(output, /\x1b_G/);
  assert.match(output.replace(/\x1b\[[\d;]*m/g, ""), /SessionBar/);
  assert.ok(output.split("\r\n").length - 1 <= 24, "the command box must fit without scrolling the frame");
});

test("landing command box opens the requested monitor view", async () => {
  const output = await runCase({ supported: false, animate: false, command: "agents" });
  assert.match(output, /ACTION:agents/);
  assert.match(output, /Command/);
});

test("Escape cancels a typed quit command and leaves menu shortcuts usable", async () => {
  const output = await runCase({ supported: false, animate: false, command: "agents", cancel: true });
  assert.match(output, /ACTION:setup/);
});
