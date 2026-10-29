import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --import runs before the test modules (including server module side effects)
// in each Node test worker. Never point default discovery at the user's home.
const testHome = mkdtempSync(join(tmpdir(), "sessionbar-test-home-"));
const accountOrAppSetting = /^(?:SESSIONBAR|SESSION_BAR|AGENTBAR|CODEX|CLAUDE|OPENAI|ANTHROPIC|DEEPSEEK|MINIMAX|KIMI|MOONSHOT|XAI|GROK|GEMINI|GOOGLE|COPILOT|GITHUB|GH|CURSOR|WORKBUDDY|CODEBUDDY|CCSWITCH)(?:_|$)/i;
const networkOrStartupSetting = /^(?:https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_extra_ca_certs|node_options|port)$/i;
for (const key of Object.keys(process.env)) {
  if (accountOrAppSetting.test(key) || networkOrStartupSetting.test(key)) delete process.env[key];
}

const paths = {
  HOME: testHome,
  USERPROFILE: testHome,
  SESSIONBAR_HOME: join(testHome, ".sessionbar"),
  CODEX_HOME: join(testHome, ".codex"),
  XDG_CONFIG_HOME: join(testHome, ".config"),
  XDG_DATA_HOME: join(testHome, ".local", "share"),
  XDG_STATE_HOME: join(testHome, ".local", "state"),
  XDG_CACHE_HOME: join(testHome, ".cache"),
  WORKBUDDY_HOME: join(testHome, ".workbuddy"),
  KIMI_CODE_HOME: join(testHome, ".kimi-code"),
};
for (const [key, path] of Object.entries(paths)) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  process.env[key] = path;
}
Object.assign(process.env, {
  SESSIONBAR_PROVIDER_POLL: "0",
  SESSIONBAR_GROK_BILLING: "0",
  SESSIONBAR_CCSWITCH: "0",
  SESSIONBAR_CODEX_APP_SERVER: "0",
});

// Child fixtures inherit these safe defaults and may explicitly override them.
// Do not use NODE_OPTIONS: it would re-isolate children after their fixture env
// was supplied and break tests that intentionally exercise particular paths.
process.once("exit", () => {
  rmSync(testHome, { recursive: true, force: true });
});
