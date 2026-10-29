import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNetworkPolicy, networkRoute, parseSystemProxy, childNetworkEnv } from '../dist/runtime/networkPolicy.js';

const system = { httpProxy: 'http://system.example:8080', httpsProxy: 'http://secure.example:8081', bypass: ['*.local', '10.*', '172.16.0.0/12'], excludeSimpleHostnames: true };
test('explicit environment takes precedence as one configuration without mutation', () => {
  const env = { https_proxy: 'http://env.example:9000', HTTPS_PROXY: 'http://ignored.example:9000', NO_PROXY: '.skip.example' };
  const policy = resolveNetworkPolicy(env, system);
  assert.equal(policy.source, 'environment');
  assert.equal(networkRoute('https://api.example', policy).proxyUrl, env.https_proxy);
  assert.equal(networkRoute('http://api.example', policy).mode, 'direct');
  assert.equal(networkRoute('https://a.skip.example', policy).mode, 'direct');
  assert.equal(env.HTTPS_PROXY, 'http://ignored.example:9000');
});
test('absent overrides follow existing system proxies, bypass patterns, CIDR and simple names', () => {
  const policy = resolveNetworkPolicy({}, system);
  assert.equal(policy.source, 'system');
  assert.equal(networkRoute('https://api.example', policy).proxyUrl, system.httpsProxy);
  for (const host of ['printer', 'host.local', '10.2.3.4', '172.20.1.1']) assert.equal(networkRoute(`https://${host}`, policy).mode, 'direct', host);
  assert.equal(networkRoute('https://172.32.1.1', policy).mode, 'proxy');
});
test('loopback always bypasses outbound proxies; NO_PROXY honors target ports', () => {
  const policy = resolveNetworkPolicy({ ALL_PROXY: 'http://proxy.example:8000', NO_PROXY: 'api.example:8443' });
  for (const url of ['http://localhost:8000', 'http://127.5.1.2:8000', 'http://[::1]:8000', 'http://[::ffff:127.0.0.1]:8000']) assert.equal(networkRoute(url, policy).mode, 'direct');
  assert.equal(networkRoute('https://api.example:8443', policy).mode, 'direct');
  assert.equal(networkRoute('https://api.example:8444', policy).mode, 'proxy');
});
test('explicit empty environment proxy means direct, not fallback to system', () => {
  assert.equal(networkRoute('https://api.example', resolveNetworkPolicy({ HTTPS_PROXY: '' }, system)).mode, 'direct');
});
test('PAC and invalid explicit proxies are reported, never silently bypassed', () => {
  const policy = resolveNetworkPolicy({}, { ...system, autoConfig: true });
  assert.deepEqual(networkRoute('https://api.example', policy), { mode: 'unsupported', reason: 'system-pac-unsupported' });
  assert.equal(networkRoute('https://localhost', policy).mode, 'direct');
  const invalid = resolveNetworkPolicy({ HTTPS_PROXY: 'ftp://user:secret@proxy.example' });
  const route = networkRoute('https://api.example', invalid);
  assert.equal(route.mode, 'unsupported');
  assert.equal(JSON.stringify(route).includes('secret'), false);
});
test('system SOCKS5 and ALL_PROXY support SOCKS remote DNS', () => {
  assert.equal(networkRoute('https://api.example', resolveNetworkPolicy({}, { socksProxy: 'socks5://proxy.example:1080' })).proxyUrl, 'socks5://proxy.example:1080');
  assert.equal(networkRoute('https://api.example', resolveNetworkPolicy({ ALL_PROXY: 'socks5h://proxy.example:1080' })).proxyUrl, 'socks5://proxy.example:1080');
});
test('system parser reads global configuration and ignores scoped overrides', () => {
  const parsed = parseSystemProxy(`<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 8822
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ExcludeSimpleHostnames : 1
  ExceptionsList : <array> {
    0 : *.local
    1 : 10.0.0.0/8
  }
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : ignored.example
      HTTPPort : 9999
    }
  }
}`);
  assert.equal(parsed.httpProxy, 'http://127.0.0.1:8822');
  assert.equal(parsed.httpsProxy, undefined);
  assert.deepEqual(parsed.bypass, ['*.local', '10.0.0.0/8']);
  assert.equal(parsed.excludeSimpleHostnames, true);
});
test('child configuration preserves inherited overrides and only projects existing system proxies', () => {
  const env = { PATH: '/bin', HTTPS_PROXY: 'http://env.example:9000', NO_PROXY: 'custom.example' };
  assert.deepEqual(childNetworkEnv(env, resolveNetworkPolicy(env, system)), env);
  const inherited = { PATH: '/bin' };
  const child = childNetworkEnv(inherited, resolveNetworkPolicy(inherited, system));
  assert.equal(child.HTTPS_PROXY, system.httpsProxy);
  assert.equal(child.HTTP_PROXY, system.httpProxy);
  assert.ok(child.NO_PROXY.includes('localhost'));
  assert.deepEqual(inherited, { PATH: '/bin' });
});

test('SOCKS5H normalization is case insensitive', () => {
  assert.equal(networkRoute('https://api.example', resolveNetworkPolicy({ ALL_PROXY: 'SOCKS5H://127.0.0.1:1080' })).proxyUrl, 'socks5://127.0.0.1:1080');
});
test('scoped-only system proxy is explicit unsupported, never misrepresented as direct', () => {
  const system = parseSystemProxy(`<dictionary> {
  __SCOPED__ : <dictionary> {
    utun0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : 127.0.0.1
      HTTPPort : 8123
    }
  }
}`);
  assert.equal(networkRoute('https://api.example', resolveNetworkPolicy({}, system)).mode, 'unsupported');
});

test('an observed unsupported system configuration replaces an earlier usable configuration', async () => {
  const { createNetworkRuntime } = await import('../dist/runtime/networkRuntime.js');
  let settings = { httpProxy: 'http://proxy.example:8080' };
  const runtime = createNetworkRuntime({ env: {}, readSystemProxy: async () => settings });
  try {
    await runtime.refresh();
    const previous = runtime.status().revision;
    settings = { error: 'system-scoped-proxy-unsupported' };
    await runtime.refresh();
    assert.equal(runtime.status().state, 'unsupported');
    assert.ok(runtime.status().revision > previous);
    assert.throws(() => runtime.childEnv(), /system-scoped-proxy-unsupported/);
  } finally { await runtime.close(); }
});
