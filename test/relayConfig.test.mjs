import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordRelayConfig, readRelayConfigMatch, relayConfigId } from '../dist/runtime/relayConfig.js';

function privateHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'sessionbar-relay-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('startup config identity is canonical and ignores view and injected launcher state', () => {
  const env = { HTTPS_PROXY: 'http://proxy.example:8000', SESSIONBAR_KIMI_API_KEY: 'fake-key', PATH: '/test/bin' };
  assert.equal(relayConfigId(env), relayConfigId({ PATH: env.PATH, SESSIONBAR_KIMI_API_KEY: env.SESSIONBAR_KIMI_API_KEY, HTTPS_PROXY: env.HTTPS_PROXY }));
  assert.equal(relayConfigId(env), relayConfigId({ ...env, SESSIONBAR_PORT: '0', SESSIONBAR_WEB: '1', SESSIONBAR_BUN_REEXEC: '1', SESSIONBAR_TUI_REFRESH_MS: '500', TERM: 'xterm', UNRELATED_SECRET: 'ignored' }));
  assert.equal(relayConfigId({}), relayConfigId({ HTTPS_PROXY: undefined }));
});

test('provider, network, credential, and discovery environment changes are detectable', () => {
  const keys = [
    'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    'HOME', 'PATH', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'WORKBUDDY_HOME',
    'SESSIONBAR_PROVIDER_POLL', 'SESSIONBAR_PROVIDER_POLL_MS', 'SESSIONBAR_GROK_BIN', 'SESSIONBAR_GROK_BILLING',
    'SESSIONBAR_KIMI_ACCESS_TOKEN', 'DEEPSEEK_API_KEY', 'SESSIONBAR_XAI_MANAGEMENT_API_KEY',
    'SESSIONBAR_ANTHROPIC_BASE_URL', 'SESSIONBAR_OPENAI_LABEL', 'SESSIONBAR_MINIMAX_TARGET',
  ];
  for (const key of keys) assert.notEqual(relayConfigId({}), relayConfigId({ [key]: 'changed' }), key);
  assert.notEqual(relayConfigId({ HTTPS_PROXY: 'http://user:old@proxy.example' }), relayConfigId({ HTTPS_PROXY: 'http://user:new@proxy.example' }));
  assert.notEqual(relayConfigId({ HTTPS_PROXY: 'http://proxy.example' }), relayConfigId({ HTTPS_PROXY: 'http://proxy.example', https_proxy: '' }));
});

test('public revision contains no configuration-derived identifier and private state is restricted', t => {
  const home = privateHome(t);
  const env = { HTTPS_PROXY: 'http://user:fake-password@proxy.example', SESSIONBAR_KIMI_API_KEY: 'fake-key' };
  const first = recordRelayConfig(home, env, 101);
  const firstRaw = readFileSync(join(home, 'startup-config.json'), 'utf8');
  assert.deepEqual(Object.keys(first), ['revision']);
  assert.match(first.revision, /^[a-f0-9-]{36}$/);
  assert.equal(firstRaw.includes('fake-password'), false);
  assert.equal(firstRaw.includes('fake-key'), false);
  assert.equal(firstRaw.includes('proxy.example'), false);
  assert.equal(readRelayConfigMatch(home, env, 101, first.revision), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(home, 'startup-config.json')).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);
  }
  const second = recordRelayConfig(home, env, 202);
  assert.notEqual(second.revision, first.revision);
  assert.equal(JSON.parse(firstRaw).fingerprint, JSON.parse(readFileSync(join(home, 'startup-config.json'), 'utf8')).fingerprint);
  assert.equal(readRelayConfigMatch(home, env, 101, first.revision), undefined);
});

test('an attaching client can detect changed configuration without overwriting the Relay snapshot', t => {
  const home = privateHome(t);
  const env = { HTTP_PROXY: 'http://proxy.example:8000', KIMI_ACCESS_TOKEN: 'fake-original' };
  const { revision } = recordRelayConfig(home, env, 101);
  const before = readFileSync(join(home, 'startup-config.json'), 'utf8');
  env.KIMI_ACCESS_TOKEN = 'fake-updated';
  assert.equal(readRelayConfigMatch(home, env, 101, revision), false);
  assert.equal(readFileSync(join(home, 'startup-config.json'), 'utf8'), before);
  assert.equal(readRelayConfigMatch(home, { ...env, KIMI_ACCESS_TOKEN: 'fake-original' }, 101, revision), true);
});

test('missing, corrupt, unsupported, and differently owned records are unknown', t => {
  const home = privateHome(t);
  const path = join(home, 'startup-config.json');
  assert.equal(readRelayConfigMatch(home, {}, 101, 'revision'), undefined);
  const { revision } = recordRelayConfig(home, {}, 101);
  assert.equal(readRelayConfigMatch(home, {}, 202, revision), undefined);
  assert.equal(readRelayConfigMatch(home, {}, 101, 'different'), undefined);
  assert.equal(readRelayConfigMatch(home, {}, 101, ''), undefined);
  for (const contents of ['bad json', 'null', '{}', JSON.stringify({ version: 2, pid: 101, revision, fingerprint: relayConfigId({}) }), JSON.stringify({ version: 1, pid: 101, revision, fingerprint: 'bad' })]) {
    writeFileSync(path, contents);
    assert.equal(readRelayConfigMatch(home, {}, 101, revision), undefined);
  }
  assert.throws(() => recordRelayConfig(home, {}, -1), /Invalid Relay PID/);
});
