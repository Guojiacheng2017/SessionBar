import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pollProvider } from "../dist/providers/providerAdapters.js";
import { fetchWorkBuddyDesktopCredits } from "../dist/providers/workbuddyCreditsAdapter.js";
import { closeProviderNetwork } from "../dist/runtime/networkRuntime.js";

test("Relay shutdown cancels default provider HTTP and reaps a local provider command", { timeout: 8_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "sessionbar-provider-runtime-"));
  const pidPath = join(directory, "child.pid");
  const databasePath = join(directory, "fixture.db");
  const scriptPath = join(directory, "fixture.mjs");
  const executable = join(directory, "fixture-sqlite");
  writeFileSync(databasePath, "");
  writeFileSync(scriptPath, `import { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)}\n`, { mode: 0o700 });

  let requestReceived;
  let childReaped = false;
  const received = new Promise(resolve => { requestReceived = resolve; });
  const server = createServer((_request, _response) => requestReceived());
  t.after(async () => {
    if (!childReaped && existsSync(pidPath)) {
      try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch { /* already reaped */ }
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const request = pollProvider({
    id: "fixture", provider: "deepseek", api_key: "fixture-token", label: "Fixture", target: "*",
    base_url: `http://127.0.0.1:${server.address().port}`,
  });
  const command = fetchWorkBuddyDesktopCredits({ dbPath: databasePath, sqlitePath: executable, balanceCommand: "" });
  await received;
  const deadline = Date.now() + 2_000;
  while (!existsSync(pidPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(pidPath), true, "fixture command did not start");
  const pid = Number(readFileSync(pidPath, "utf8"));

  await closeProviderNetwork();
  let timer;
  const result = await Promise.race([
    Promise.all([request, command]),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), 2_000); }),
  ]);
  clearTimeout(timer);
  assert.notEqual(result, null, "provider work remained live after Relay shutdown");
  assert.equal(result[0].signals[0].status, "error");
  assert.equal(result[1], null);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  childReaped = true;
});
