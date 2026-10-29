import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import { createNetworkRuntime, localFetch } from '../dist/runtime/networkRuntime.js';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

async function fixture(t, handler = (_req, res) => res.end('fixture')) {
  const requests = [];
  const lookups = [];
  const server = http.createServer((req, res) => { requests.push(req.url); handler(req, res); });
  const port = await listen(t, server);
  // Resolve only this test's reserved name locally. No real DNS or account
  // endpoint is used, even if a routing regression attempts a direct request.
  const original = dns.lookup;
  dns.lookup = function(hostname, options, callback) {
    if (hostname !== 'provider.invalid') return original.apply(this, arguments);
    lookups.push(hostname);
    const done = typeof options === 'function' ? options : callback;
    queueMicrotask(() => options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4));
  };
  t.after(() => { dns.lookup = original; });
  return { port, requests, lookups, url: `http://provider.invalid:${port}/fixture`, local: `http://127.0.0.1:${port}/fixture` };
}

async function proxyFixture(t, targetPort) {
  const targets = [];
  const upstreamSockets = new Set();
  const proxy = http.createServer((_req, res) => res.writeHead(500).end('CONNECT required'));
  proxy.on('connect', (req, client, head) => {
    targets.push(req.url);
    const upstream = net.connect(targetPort, '127.0.0.1');
    upstreamSockets.add(upstream);
    upstream.once('close', () => upstreamSockets.delete(upstream));
    upstream.once('error', () => client.destroy());
    client.once('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  const port = await listen(t, proxy);
  t.after(() => { for (const socket of upstreamSockets) socket.destroy(); });
  return { targets, url: `http://127.0.0.1:${port}` };
}

function runtime(t, options) {
  const value = createNetworkRuntime({ readSystemProxy: async () => ({}), ...options });
  t.after(() => value.close());
  return value;
}

async function socksFixture(t, targetPort) {
  const targets = [];
  const credentials = [];
  const upstreamSockets = new Set();
  const server = net.createServer(socket => {
    let state = 'greeting';
    let buffered = Buffer.alloc(0);
    const receive = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (state === 'greeting') {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
        if (buffered[0] !== 5 || !buffered.subarray(2, 2 + buffered[1]).includes(2)) { socket.destroy(); return; }
        buffered = buffered.subarray(2 + buffered[1]);
        state = 'authentication';
        socket.write(Buffer.from([5, 2])); // Require username/password authentication.
      }
      if (state === 'authentication') {
        if (buffered.length < 2) return;
        const userLength = buffered[1];
        if (buffered.length < 3 + userLength) return;
        const passwordLength = buffered[2 + userLength];
        if (buffered.length < 3 + userLength + passwordLength) return;
        credentials.push({
          username: buffered.subarray(2, 2 + userLength).toString(),
          password: buffered.subarray(3 + userLength, 3 + userLength + passwordLength).toString(),
        });
        buffered = buffered.subarray(3 + userLength + passwordLength);
        state = 'connect';
        socket.write(Buffer.from([1, 0]));
      }
      if (state === 'connect') {
        if (buffered.length < 5) return;
        // The fixture accepts only the domain-name address type, so resolving
        // the provider locally instead of at the proxy cannot silently pass.
        if (buffered[0] !== 5 || buffered[1] !== 1 || buffered[3] !== 3) { socket.destroy(); return; }
        const nameLength = buffered[4];
        if (buffered.length < 7 + nameLength) return;
        targets.push({ hostname: buffered.subarray(5, 5 + nameLength).toString(), port: buffered.readUInt16BE(5 + nameLength), addressType: buffered[3] });
        buffered = buffered.subarray(7 + nameLength);
        state = 'connecting';
        const upstream = net.connect(targetPort, '127.0.0.1');
        upstreamSockets.add(upstream);
        upstream.once('close', () => upstreamSockets.delete(upstream));
        upstream.once('error', () => socket.destroy());
        socket.once('error', () => upstream.destroy());
        socket.once('close', () => upstream.destroy());
        upstream.once('connect', () => {
          socket.removeListener('data', receive);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, (targetPort >> 8) & 255, targetPort & 255]));
          if (buffered.length) upstream.write(buffered);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
      }
    };
    socket.on('data', receive);
  });
  const port = await listen(t, server);
  t.after(() => { for (const socket of upstreamSockets) socket.destroy(); });
  return { port, targets, credentials };
}

test('provider fetch uses a real CONNECT proxy and preserves method, headers, and body', { timeout: 5000 }, async t => {
  const target = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, authorization: req.headers.authorization, body }));
  });
  const proxy = await proxyFixture(t, target.port);
  const network = runtime(t, { env: { HTTP_PROXY: proxy.url }, requestTimeoutMs: 1000 });
  const response = await network.fetch(target.url, { method: 'POST', headers: { authorization: 'Bearer fake-fixture' }, body: 'test-body' });
  assert.deepEqual(await response.json(), { method: 'POST', authorization: 'Bearer fake-fixture', body: 'test-body' });
  assert.deepEqual(proxy.targets, [`provider.invalid:${target.port}`]);
});

test('SOCKS5H sends the domain to the proxy and decodes URL-encoded credentials', { timeout: 5000 }, async t => {
  const target = await fixture(t);
  const proxy = await socksFixture(t, target.port);
  const network = runtime(t, {
    env: { ALL_PROXY: `SOCKS5H://user%40example:pa%3Ass%40word@127.0.0.1:${proxy.port}` },
    requestTimeoutMs: 1000,
  });
  assert.equal(await (await network.fetch(target.url)).text(), 'fixture');
  assert.deepEqual(proxy.credentials, [{ username: 'user@example', password: 'pa:ss@word' }]);
  assert.deepEqual(proxy.targets, [{ hostname: 'provider.invalid', port: target.port, addressType: 3 }]);
  assert.deepEqual(target.lookups, [], 'the client must not resolve the provider domain before the SOCKS request');
});

test('local relay fetch stays direct even when the global dispatcher uses a proxy', { timeout: 5000 }, async t => {
  const target = await fixture(t);
  const proxy = await proxyFixture(t, target.port);
  const previous = getGlobalDispatcher();
  const globalProxy = new ProxyAgent(proxy.url);
  setGlobalDispatcher(globalProxy);
  try {
    assert.equal(await (await localFetch(target.local, { signal: AbortSignal.timeout(1000) })).text(), 'fixture');
    assert.deepEqual(proxy.targets, []);
  } finally {
    setGlobalDispatcher(previous);
    await globalProxy.destroy();
  }
});

test('NO_PROXY bypasses the proxy for a non-loopback hostname resolved by the local fixture', { timeout: 5000 }, async t => {
  const target = await fixture(t);
  const proxy = await proxyFixture(t, target.port);
  const network = runtime(t, { env: { HTTP_PROXY: proxy.url, NO_PROXY: 'provider.invalid' }, requestTimeoutMs: 1000 });
  assert.equal(await (await network.fetch(target.url)).text(), 'fixture');
  assert.deepEqual(proxy.targets, []);
  assert.equal(target.requests.length, 1);
});

test('the runtime keeps its startup environment and returned child environments are copies', { timeout: 5000 }, async t => {
  const target = await fixture(t);
  const proxy = await proxyFixture(t, target.port);
  const env = { HTTP_PROXY: proxy.url, EXAMPLE_CHILD_SETTING: 'original' };
  const network = runtime(t, { env, readSystemProxy: async () => ({}), requestTimeoutMs: 1000 });
  env.HTTP_PROXY = 'invalid:changed';
  env.EXAMPLE_CHILD_SETTING = 'changed';
  network.childEnv().HTTP_PROXY = 'invalid:returned-copy';
  await network.refresh();
  assert.equal(network.childEnv().HTTP_PROXY, proxy.url);
  assert.equal(network.childEnv().EXAMPLE_CHILD_SETTING, 'original');
  assert.equal(await (await network.fetch(target.url)).text(), 'fixture');
  assert.equal(proxy.targets.length, 1);
});

test('system proxy refresh changes routes, retains last policy on failure, and can return to direct', { timeout: 5000 }, async t => {
  const target = await fixture(t);
  const first = await proxyFixture(t, target.port);
  const second = await proxyFixture(t, target.port);
  let settings = { httpProxy: first.url };
  const network = runtime(t, { env: {}, readSystemProxy: async () => settings, requestTimeoutMs: 1000 });
  await network.refresh();
  assert.equal(network.status().source, 'system');
  assert.equal(await (await network.fetch(target.url)).text(), 'fixture');
  settings = { httpProxy: second.url };
  await network.refresh();
  assert.equal(await (await network.fetch(target.url)).text(), 'fixture');
  const revision = network.status().revision;
  settings = { error: 'system-proxy-unavailable' };
  await network.refresh();
  assert.equal(network.status().revision, revision);
  assert.equal(network.status().issue, 'system-proxy-unavailable');
  assert.equal(await (await network.fetch(target.url)).text(), 'fixture');
  assert.equal(first.targets.length, 1);
  assert.ok(second.targets.length >= 1, 'requests still use the retained proxy');
  const tunnelCount = first.targets.length + second.targets.length;
  settings = {};
  await network.refresh();
  assert.equal(network.status().source, 'direct');
  assert.equal(await (await network.fetch(target.url)).text(), 'fixture');
  assert.equal(first.targets.length + second.targets.length, tunnelCount);
});

test('an initial system proxy read failure and PAC never silently make external direct requests', { timeout: 5000 }, async t => {
  const target = await fixture(t);
  for (const settings of [{ error: 'system-proxy-unavailable' }, { autoConfig: true }]) {
    const network = runtime(t, { env: {}, readSystemProxy: async () => settings, requestTimeoutMs: 1000 });
    await network.refresh();
    await assert.rejects(network.fetch(target.url));
    assert.equal(network.status().state, 'unsupported');
    assert.equal(target.requests.length, 0);
  }
});

test('request deadlines cover an unfinished response body', { timeout: 5000 }, async t => {
  const target = await fixture(t, (_req, res) => { res.writeHead(200); res.write('unfinished'); });
  const network = runtime(t, { env: {}, requestTimeoutMs: 75 });
  const response = await network.fetch(target.local);
  await assert.rejects(response.text(), /abort|timeout/i);
});

test('closing the runtime aborts live response bodies and rejects further work', { timeout: 5000 }, async t => {
  const target = await fixture(t, (_req, res) => { res.writeHead(200); res.write('unfinished'); });
  const network = runtime(t, { env: {}, requestTimeoutMs: 2000 });
  const response = await network.fetch(target.local);
  const body = response.text();
  const rejected = assert.rejects(body, /abort/i);
  const closing = network.close();
  assert.equal(network.close(), closing);
  await Promise.all([closing, rejected]);
  assert.equal(network.status().state, 'stopped');
  await assert.rejects(network.fetch(target.local), /relay-stopping/);
  assert.throws(() => network.childEnv(), /relay-stopping/);
});

test('shutdown retains a living protocol child, sends TERM then KILL, and reaps only that child', { timeout: 5000 }, async t => {
  const network = runtime(t, { env: {}, childGraceMs: 10 });
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close'));
    }
    return true;
  };
  const release = network.trackChild(child);
  release(); // Protocol complete does not mean the process has actually exited.
  await network.close();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('a child operational error is not mistaken for process exit during shutdown', { timeout: 5000 }, async t => {
  const network = runtime(t, { env: {}, childGraceMs: 10 });
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close'));
    }
    return true;
  };
  network.trackChild(child);
  child.emit('error', Object.assign(new Error('fixture operation failed while child remains alive'), { code: 'EPERM' }));
  await network.close();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('redirect destinations reapply routing and bypass proxies for loopback', { timeout: 5000 }, async t => {
  const target = await fixture(t, (req, res) => {
    if (req.url === '/fixture') res.writeHead(302, { location: `http://127.0.0.1:${req.socket.localPort}/direct` }).end();
    else res.end('redirected');
  });
  const proxy = await proxyFixture(t, target.port);
  const network = runtime(t, { env: { HTTP_PROXY: proxy.url }, requestTimeoutMs: 1000 });
  assert.equal(await (await network.fetch(target.url)).text(), 'redirected');
  assert.deepEqual(proxy.targets, [`provider.invalid:${target.port}`]);
  assert.deepEqual(target.requests, ['/fixture', '/direct']);
});
