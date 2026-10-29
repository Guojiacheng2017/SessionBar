import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const adapterUrl = new URL("../dist/sessions/codexAppServer.js", import.meta.url).href;
const runtimeUrl = new URL("../dist/runtime/networkRuntime.js", import.meta.url).href;

async function runFixture(stubborn) {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-codex-discovery-"));
  const command = join(home, "fake-codex.mjs");
  const log = join(home, "messages.jsonl");
  const pidFile = join(home, "fixture.pid");
  writeFileSync(command, `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (${stubborn}) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ message, marker: process.env.SESSIONBAR_FIXTURE_MARKER, proxy: process.env.ALL_PROXY }) + '\\n');
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
  if (message.method === 'thread/list' && !${stubborn}) process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ id: 'fixture-thread' }] } }) + '\\n');
});
`);
  chmodSync(command, 0o700);
  const driver = `
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const { readCodexThreads } = await import(${JSON.stringify(adapterUrl)});
const { closeProviderNetwork } = await import(${JSON.stringify(runtimeUrl)});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = readCodexThreads({ command: ${JSON.stringify(command)} });
let pid;
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(${JSON.stringify(log)}) && readFileSync(${JSON.stringify(log)}, 'utf8').includes('thread/list')) break;
    await pause(10);
  }
  pid = Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8'));
  ${stubborn ? "await closeProviderNetwork(); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });" : "assert.deepEqual(await pending, [{ id: 'fixture-thread' }]); await closeProviderNetwork();"}
  assert.deepEqual(await pending, ${stubborn ? "[]" : "[{ id: 'fixture-thread' }]"});
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const records = readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.message.method), ['initialize', 'initialized', 'thread/list']);
  assert.equal(records[2].message.params.useStateDbOnly, true);
  assert.ok(records.every(record => record.marker === 'inherited-fixture' && record.proxy === 'socks5://fixture.invalid:9'));
  console.log(JSON.stringify({ methods: records.map(record => record.message.method), childExited: true }));
} finally {
  // This is the executable created above, never an installed Codex process.
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await pending.catch(() => {});
  await closeProviderNetwork();
}
`;
  try {
    const result = await exec(process.execPath, ["--input-type=module", "--eval", driver], {
      cwd: home, timeout: 8_000,
      env: { HOME: home, PATH: process.env.PATH, SESSIONBAR_FIXTURE_MARKER: "inherited-fixture", ALL_PROXY: "socks5://fixture.invalid:9" },
    });
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("Codex discovery inherits its environment and sends only read-only protocol methods", { timeout: 10_000 }, async () => {
  const result = await runFixture(false);
  assert.equal(result.childExited, true);
});

test("Relay shutdown reaps an in-flight Codex discovery child that ignores SIGTERM", { timeout: 10_000 }, async () => {
  const result = await runFixture(true);
  assert.equal(result.childExited, true);
});
