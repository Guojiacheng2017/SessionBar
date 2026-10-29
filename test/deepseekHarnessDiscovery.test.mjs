import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { detectHarnessAvailability } from "../dist/hooks/hookManager.js";
import * as discovery from "../dist/sessions/deepseekHarnessDiscovery.js";

const now = Date.parse("2026-10-26T15:00:00Z");

test("registers DeepSeek Harness separately from the DeepSeek API provider", () => {
  const entry = detectHarnessAvailability().find(item => item.id === "dsh");
  assert.ok(entry);
  assert.equal(entry.name, "DeepSeek Harness");
  assert.ok(entry.commands.includes("dsh"));
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-dsh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "storages", "session_projcache", "sessions");
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}
function snapshot(rows = {}) {
  return { version: 7, record: {
    identity: { formatVersion: 4, createdAt: now - 60_000, cwd: "/work/alpha", isSeeded: false, inheritedEventCount: 0 },
    rows: {
      title: { ver: 1, seq: 10, val: "Implement adapter" },
      turnBoundary: { ver: 2, seq: 10, val: { openTurnStartSeq: null, lastTurn: 3 } },
      sessionStats: { ver: 1, seq: 10, val: { turns: 3 } },
      tokenUsage: { ver: 2, seq: 10, val: { totals: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 30 } } },
      contextPressure: { ver: 5, seq: 10, val: { pressureTokens: 250, contextWindow: 1000 } },
      ...rows,
    },
  } };
}
function write(dir, id, data = snapshot(), time = now - 1000) {
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify(data));
  utimesSync(file, new Date(time), new Date(time));
  return file;
}

test("maps DSH projection counters once without treating it as an API provider", t => {
  const { root, dir } = fixture(t);
  write(dir, "session-one");
  const [session] = discovery.discoverDeepSeekHarnessSessions({ root, now });
  assert.equal(session.session_id, "dsh-session-one__alpha");
  assert.equal(session.session_type, "DeepSeek Harness");
  assert.equal(session.source, "filesystem_snapshot");
  assert.equal(session.project_path, "/work/alpha");
  assert.equal(session.status, "idle");
  assert.equal(session.tokens, 950);
  assert.equal(session.input_tokens, 100);
  assert.equal(session.cache_read_tokens, 800);
  assert.equal(session.cache_write_tokens, 30);
  assert.equal(session.output_tokens, 20);
  assert.equal(session.turns, 3);
  assert.equal(session.context_percent, 25);
  assert.match(session.session_source, /projection/);
  assert.equal(session.model_provider, undefined);
  assert.equal(session.quota_percent, undefined);
});

test("keeps separate sessions in one project and excludes subagents and archived sessions", t => {
  const { root, dir } = fixture(t);
  write(dir, "session-one");
  write(dir, "session-two");
  write(dir, "child", snapshot({ subagent: { ver: 2, seq: 10, val: { identity: { mode: "continuable" } } } }));
  write(dir, "archived");
  writeFileSync(join(root, "storages", "workspace.json"), JSON.stringify({ unit: { name: "workspace", version: 2 }, global: { archivedSessionIds: ["archived"] } }));
  assert.deepEqual(discovery.discoverDeepSeekHarnessSessions({ root, now }).map(s => s.session_id).sort(), ["dsh-session-one__alpha", "dsh-session-two__alpha"]);
});

test("uses explicit open turn and pending questions rather than file freshness alone", t => {
  const { root, dir } = fixture(t);
  write(dir, "working", snapshot({ turnBoundary: { ver: 2, seq: 10, val: { openTurnStartSeq: 0 } } }));
  write(dir, "blocked", snapshot({ userQuestions: { ver: 2, seq: 10, val: { questions: { active: [{}] } } } }));
  write(dir, "old-open", snapshot({ turnBoundary: { ver: 2, seq: 10, val: { openTurnStartSeq: 1 } } }), now - 60_000);
  const states = Object.fromEntries(discovery.discoverDeepSeekHarnessSessions({ root, now }).map(s => [s.session_id.split("__")[0], s.status]));
  assert.deepEqual(states, { "dsh-working": "working", "dsh-blocked": "blocked", "dsh-old-open": "idle" });
});

test("rejects unknown schema, expired snapshots, symlinks and invalid counters", t => {
  const { root, dir } = fixture(t);
  write(dir, "old", snapshot(), now - 31 * 60_000);
  write(dir, "future-schema", { ...snapshot(), version: 100 });
  writeFileSync(join(dir, "partial.json"), "{");
  const outside = join(root, "outside.json");
  writeFileSync(outside, JSON.stringify(snapshot()));
  symlinkSync(outside, join(dir, "linked.json"));
  write(dir, "invalid", snapshot({ tokenUsage: { ver: 2, seq: 10, val: { totals: { uncachedInputTokens: -1 } } } }));
  const sessions = discovery.discoverDeepSeekHarnessSessions({ root, now });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tokens, undefined);
});

test("targeted reads reject paths outside the checkpoint directory", t => {
  const { root, dir } = fixture(t);
  write(dir, "one");
  const two = write(dir, "two");
  const outside = join(root, "outside.json");
  writeFileSync(outside, JSON.stringify(snapshot()));
  assert.deepEqual(discovery.discoverDeepSeekHarnessSessions({ root, now, paths: [two, outside] }).map(s => s.session_id), ["dsh-two__alpha"]);
});

test("Relay discovers DSH at startup and updates through the existing file watcher", async t => {
  const { root, dir } = fixture(t);
  write(dir, "live", snapshot(), Date.now());
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ["dist/server/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOME: root, SESSIONBAR_HOME: join(root, "relay"), SESSIONBAR_DSH_HOME: root,
      CODEX_HOME: join(root, "codex"), WORKBUDDY_HOME: join(root, "workbuddy"), KIMI_CODE_HOME: join(root, "kimi"),
      SESSIONBAR_HOST: "127.0.0.1", SESSIONBAR_PORT: String(port), SESSIONBAR_PROVIDER_POLL: "0", SESSIONBAR_CCSWITCH: "0" },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 1500);
      child.once("close", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
  });
  async function waitForStatus(status) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const data = await fetch(`http://127.0.0.1:${port}/sessions/live`).then(r => r.json());
        const sessions = Array.isArray(data) ? data : Object.values(data);
        const found = sessions.find(s => s.session_id === "dsh-live__alpha");
        if (found?.status === status) return found;
      } catch { /* Relay is starting. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`DSH ${status} state not visible through Relay`);
  }
  assert.equal((await waitForStatus("idle")).tokens, 950);
  write(dir, "live", snapshot({ turnBoundary: { ver: 2, seq: 11, val: { openTurnStartSeq: 10 } } }), Date.now());
  await waitForStatus("working");
});
