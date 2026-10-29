import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNetworkRuntime } from "../dist/runtime/networkRuntime.js";

test("unsupported system PAC does not block the environment for a local child", async t => {
  const env = { PATH: "/fixture/bin", LOCAL_FIXTURE: "value" };
  const runtime = createNetworkRuntime({ env, readSystemProxy: async () => ({ autoConfig: true }) });
  t.after(() => runtime.close());
  await runtime.refresh();
  assert.throws(() => runtime.childEnv(), /pac/i);
  const childEnv = runtime.childEnv(false);
  assert.deepEqual(childEnv, env);
  childEnv.LOCAL_FIXTURE = "changed";
  assert.equal(runtime.childEnv(false).LOCAL_FIXTURE, "value");
});

test("SQLite collectors request only local environment while user commands retain network policy", t => {
  const directory = mkdtempSync(join(tmpdir(), "sessionbar-local-provider-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  mkdirSync(join(directory, ".cc-switch"));
  writeFileSync(join(directory, ".cc-switch", "cc-switch.db"), "fixture");
  const database = join(directory, "workbuddy.db");
  writeFileSync(database, "fixture");
  const script = join(directory, "sqlite.mjs");
  writeFileSync(script, `
    const query = process.argv.at(-1);
    const rows = query.includes('proxy_request_logs')
      ? [{ day: '2026-10-26', provider_name: 'DeepSeek', model: 'deepseek-chat', tokens: 123 }]
      : query.includes('settings_config')
        ? [{ name: 'DeepSeek', app_type: 'claude', api_key: 'fixture' }]
        : [{ credit_json: '{"request":5}', updated_at: 2000 }];
    console.log(JSON.stringify(rows));
  `);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, "sqlite3"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
  // Replace only the runtime boundary in this subprocess. A projected network
  // environment fails as PAC would, while real collector parsing and exec run.
  const runtimeStub = `
    export const calls = [];
    export function providerChildEnv(network = true) {
      calls.push(network);
      if (network) throw new Error('system-pac-unsupported');
      return { ...process.env };
    }
    export const trackProviderChild = () => () => {};
  `;
  const source = `
    import { registerHooks } from 'node:module';
    const stub = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(runtimeStub)}`)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      return specifier.endsWith('/runtime/networkRuntime.js') ? { url: stub, shortCircuit: true } : nextResolve(specifier, context);
    } });
    const { readCCSwitchDeepSeekConfig } = await import(${JSON.stringify(new URL("../dist/providers/ccSwitchAdapter.js", import.meta.url).href)});
    const { readCCSwitchUsage } = await import(${JSON.stringify(new URL("../dist/providers/ccSwitchUsage.js", import.meta.url).href)});
    const { fetchWorkBuddyDesktopCredits } = await import(${JSON.stringify(new URL("../dist/providers/workbuddyCreditsAdapter.js", import.meta.url).href)});
    const { calls } = await import(stub);
    const config = await readCCSwitchDeepSeekConfig(${JSON.stringify(directory)});
    const usage = await readCCSwitchUsage(${JSON.stringify(directory)});
    const workbuddy = await fetchWorkBuddyDesktopCredits({ dbPath: ${JSON.stringify(database)}, balanceCommand: '' });
    const command = await fetchWorkBuddyDesktopCredits({ dbPath: '/nonexistent/fixture.db', balanceCommand: 'exit 1' });
    console.log(JSON.stringify({ provider: config?.provider, tokens: usage?.deepseek?.['2026-10-26'], used: workbuddy?.used, command, calls }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 5_000,
  }));
  assert.deepEqual(result, { provider: "deepseek", tokens: 123, used: 5, command: null, calls: [false, false, false, true] });
});
