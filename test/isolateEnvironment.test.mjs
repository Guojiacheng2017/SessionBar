import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("test preload replaces user paths, removes inherited account settings, and cleans its temporary home", t => {
  const directory = mkdtempSync(join(tmpdir(), "sessionbar-isolation-canary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requestedHome = join(directory, "user-home");
  mkdirSync(requestedHome);
  const canary = join(requestedHome, "untouched");
  writeFileSync(canary, "fixture user data");
  const preload = fileURLToPath(new URL("./isolateEnvironment.mjs", import.meta.url));
  const source = `
    import { existsSync } from 'node:fs';
    import { homedir } from 'node:os';
    const pathKeys = ['HOME', 'SESSIONBAR_HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'WORKBUDDY_HOME', 'KIMI_CODE_HOME'];
    const secretKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'MINIMAX_TOKEN_PLAN_KEY', 'KIMI_ACCESS_TOKEN', 'XAI_MANAGEMENT_API_KEY', 'GH_TOKEN', 'SESSIONBAR_WORKBUDDY_BALANCE_COMMAND', 'SESSIONBAR_CODEX_BIN', 'HTTPS_PROXY'];
    console.log(JSON.stringify({
      home: homedir(),
      paths: Object.fromEntries(pathKeys.map(key => [key, process.env[key]])),
      pathsExist: pathKeys.every(key => existsSync(process.env[key] || '')),
      inheritedSecretPresent: secretKeys.some(key => process.env[key] !== undefined),
      poll: process.env.SESSIONBAR_PROVIDER_POLL,
      grok: process.env.SESSIONBAR_GROK_BILLING,
    }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--import", preload, "--input-type=module", "-e", source], {
    encoding: "utf8",
    env: {
      ...process.env, HOME: requestedHome, SESSIONBAR_HOME: requestedHome, CODEX_HOME: requestedHome,
      XDG_CONFIG_HOME: requestedHome, WORKBUDDY_HOME: requestedHome, KIMI_CODE_HOME: requestedHome,
      OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture", DEEPSEEK_API_KEY: "fixture",
      MINIMAX_TOKEN_PLAN_KEY: "fixture", KIMI_ACCESS_TOKEN: "fixture", XAI_MANAGEMENT_API_KEY: "fixture", GH_TOKEN: "fixture",
      SESSIONBAR_WORKBUDDY_BALANCE_COMMAND: "fixture-command", SESSIONBAR_CODEX_BIN: "fixture-command", HTTPS_PROXY: "http://fixture.invalid",
      SESSIONBAR_PROVIDER_POLL: "1", SESSIONBAR_GROK_BILLING: "1",
    },
  }));
  assert.notEqual(result.home, requestedHome);
  assert.equal(result.home, result.paths.HOME);
  assert.equal(result.pathsExist, true);
  assert.equal(Object.values(result.paths).every(path => path === result.home || path.startsWith(`${result.home}/`)), true);
  assert.equal(result.inheritedSecretPresent, false);
  assert.equal(result.poll, "0");
  assert.equal(result.grok, "0");
  assert.equal(existsSync(result.home), false);
  assert.equal(readFileSync(canary, "utf8"), "fixture user data");
});
