import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import * as manager from "../dist/hooks/hookManager.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-zcode-"));
  const env = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, SESSIONBAR_ZCODE_HOME: process.env.SESSIONBAR_ZCODE_HOME };
  process.env.KIMI_CODE_HOME = join(root, "kimi");
  process.env.SESSIONBAR_ZCODE_HOME = join(root, "zcode");
  mkdirSync(process.env.KIMI_CODE_HOME);
  mkdirSync(join(process.env.SESSIONBAR_ZCODE_HOME, "cli"), { recursive: true });
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { kimi: join(process.env.KIMI_CODE_HOME, "config.toml"), zcode: join(process.env.SESSIONBAR_ZCODE_HOME, "cli", "config.json") };
}

test("Kimi uses official user TOML rules and restores unrelated bytes on teardown", t => {
  assert.equal(typeof manager.setupKimiCodeHooks, "function");
  const { kimi } = fixture(t);
  const original = '# keep comments\nmodel = "my-provider/my-model"\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo custom"\n\n[providers.custom]\nbase_url = "https://example.invalid"\n';
  writeFileSync(kimi, original);
  const first = manager.setupKimiCodeHooks(true, "/test with spaces/report.sh");
  assert.ok(first.added >= 7);
  const installed = readFileSync(kimi, "utf8");
  const config = parse(installed);
  assert.equal(config.model, "my-provider/my-model");
  assert.equal(config.providers.custom.base_url, "https://example.invalid");
  assert.ok(config.hooks.some(h => h.command === "echo custom"));
  const ours = config.hooks.filter(h => h.command.includes("--sessionbar-harness"));
  assert.equal(ours.length, first.added);
  assert.ok(ours.every(h => Object.keys(h).every(k => ["event", "matcher", "command", "timeout"].includes(k))));
  assert.ok(ours.every(h => h.timeout <= 5 && h.command.includes("nativeHarnessBridge.js")));
  assert.ok(ours.some(h => h.event === "TurnStarted"));
  assert.ok(ours.some(h => h.event === "PermissionResult"));
  assert.equal(manager.setupKimiCodeHooks(true, "/test with spaces/report.sh").added, 0);
  assert.equal(readFileSync(kimi, "utf8"), installed);
  assert.equal(manager.teardownKimiCodeHooks(true), ours.length);
  assert.equal(readFileSync(kimi, "utf8"), original);
  assert.equal(manager.teardownKimiCodeHooks(true), 0);
});

test("Kimi never overwrites malformed TOML or writes ignored project hooks", t => {
  assert.equal(typeof manager.setupKimiCodeHooks, "function");
  const { kimi } = fixture(t);
  writeFileSync(kimi, '[broken = "');
  assert.equal(manager.setupKimiCodeHooks(true, "/test/report.sh").added, 0);
  assert.equal(readFileSync(kimi, "utf8"), '[broken = "');
  assert.equal(manager.teardownKimiCodeHooks(true), 0);
  rmSync(kimi);
  assert.equal(manager.setupKimiCodeHooks(false, "/test/report.sh").added, 0);
  assert.equal(existsSync(kimi), false);
});

test("Kimi refuses to delete user configuration added inside its managed block", t => {
  const { kimi } = fixture(t);
  manager.setupKimiCodeHooks(true, "/test/report.sh");
  const content = readFileSync(kimi, "utf8").replace("# <<< SessionBar Kimi hooks <<<", '[providers.user_added]\nbase_url = "https://keep.invalid"\n# <<< SessionBar Kimi hooks <<<');
  writeFileSync(kimi, content);
  assert.equal(manager.teardownKimiCodeHooks(true), 0);
  assert.equal(readFileSync(kimi, "utf8"), content);
  assert.equal(manager.setupKimiCodeHooks(true, "/test/report.sh").added, 0);
  assert.equal(readFileSync(kimi, "utf8"), content);
});

test("Kimi teardown accepts CRLF markers and preserves the surrounding CRLF bytes", t => {
  const { kimi } = fixture(t);
  const original = '# Windows config\nmodel = "custom"\n';
  writeFileSync(kimi, original);
  const installed = manager.setupKimiCodeHooks(true, "/test/report.sh").added;
  writeFileSync(kimi, readFileSync(kimi, "utf8").replaceAll("\n", "\r\n"));
  assert.equal(manager.teardownKimiCodeHooks(true), installed);
  assert.equal(readFileSync(kimi, "utf8"), original.replaceAll("\n", "\r\n"));
});

test("formatted Kimi configs deduplicate and uninstall owned rules without losing providers", t => {
  const { kimi } = fixture(t);
  writeFileSync(kimi, '[providers.custom]\nbase_url = "https://keep.invalid"\n');
  const installed = manager.setupKimiCodeHooks(true, "/test/report.sh").added;
  writeFileSync(kimi, stringify(parse(readFileSync(kimi, "utf8"))));
  manager.setupKimiCodeHooks(true, "/test/report.sh");
  assert.equal(parse(readFileSync(kimi, "utf8")).hooks.length, installed);
  writeFileSync(kimi, stringify(parse(readFileSync(kimi, "utf8"))));
  assert.equal(manager.teardownKimiCodeHooks(true), installed);
  const config = parse(readFileSync(kimi, "utf8"));
  assert.equal(config.hooks?.length ?? 0, 0);
  assert.equal(config.providers.custom.base_url, "https://keep.invalid");
});

test("ZCode uses native process argv, user scope and preserves other hooks", t => {
  assert.equal(typeof manager.setupZCodeHooks, "function");
  const { zcode } = fixture(t);
  const custom = { type: "process", command: "custom-tool", args: ["check"] };
  writeFileSync(zcode, JSON.stringify({ model: "custom", hooks: { enabled: true, timeoutMs: 9000, events: { Stop: [{ matcher: "", hooks: [custom] }] } } }));
  assert.equal(manager.setupZCodeHooks(false, "/test/report.sh").added, 0);
  const first = manager.setupZCodeHooks(true, "/test with spaces/report.sh");
  assert.equal(first.added, 7);
  const config = JSON.parse(readFileSync(zcode, "utf8"));
  assert.equal(config.model, "custom");
  assert.equal(config.hooks.enabled, true);
  assert.equal(config.hooks.timeoutMs, 9000);
  const hooks = Object.values(config.hooks.events).flatMap(defs => defs.flatMap(d => d.hooks));
  const ours = hooks.filter(h => h.args?.includes("--sessionbar-harness"));
  assert.equal(ours.length, 7);
  assert.ok(ours.every(h => h.type === "process" && h.command === process.execPath && h.timeoutMs <= 5000));
  assert.ok(ours.every(h => h.args[0] === "/test with spaces/dist/hooks/nativeHarnessBridge.js"));
  assert.equal(config.hooks.events.SessionEnd, undefined, "do not invent an undocumented event");
  assert.equal(manager.setupZCodeHooks(true, "/test with spaces/report.sh").added, 0);
  assert.equal(manager.teardownZCodeHooks(true), 7);
  assert.deepEqual(JSON.parse(readFileSync(zcode, "utf8")), { model: "custom", hooks: { enabled: true, timeoutMs: 9000, events: { Stop: [{ matcher: "", hooks: [custom] }] } } });
});

test("ZCode respects an explicitly disabled hook system and malformed config", t => {
  assert.equal(typeof manager.setupZCodeHooks, "function");
  const { zcode } = fixture(t);
  for (const original of ['{"hooks":{"enabled":false}}', '{"invalid":']) {
    writeFileSync(zcode, original);
    assert.equal(manager.setupZCodeHooks(true, "/test/report.sh").added, 0);
    assert.equal(readFileSync(zcode, "utf8"), original);
    assert.equal(manager.teardownZCodeHooks(true), 0);
  }
});

test("ZCode teardown never removes the user's enabled master switch", t => {
  const { zcode } = fixture(t);
  const original = { hooks: { enabled: true, events: {} }, model: "existing" };
  writeFileSync(zcode, JSON.stringify(original));
  assert.equal(manager.setupZCodeHooks(true, "/test/report.sh").added, 7);
  assert.equal(manager.teardownZCodeHooks(true), 7);
  assert.deepEqual(JSON.parse(readFileSync(zcode, "utf8")), original);
});

test("availability distinguishes Kimi Code and ZCode from provider API integrations", () => {
  const rows = manager.detectHarnessAvailability();
  assert.ok(rows.some(r => r.id === "kimi-code" && r.commands.includes("kimi")));
  assert.ok(rows.some(r => r.id === "zcode" && r.commands.includes("zcode")));
});
