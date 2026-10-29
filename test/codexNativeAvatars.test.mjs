import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexAvatarSource } from '../dist/agents/codexNativeAvatars.js';

const UUIDS = [
  ['01a176f7-3f9f-7a70-83c8-20c00a508f8f', 23],
  ['01a176fb-2cbb-75e0-8d18-0bbae3dcea9f', 21],
  ['01a176f6-c3da-74c1-822c-d4f7a5c2ebc8', 21],
  ['01a176da-b032-7881-9f99-d9d65645e149', 23],
  ['01a176df-6e9e-7350-853b-c33f0a368321', 26],
];
const svg = (index, theme) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect id="${theme}-${index}" width="16" height="16" fill="${theme === 'dark' ? '#123456' : '#abcdef'}"/></svg>`;

function sources() {
  const files = {};
  const pairs = Array.from({ length: 28 }, (_, index) => ({ dark: `d$${index}`, light: `l$${index}` }));
  const declarations = pairs.flatMap((pair, index) => Object.entries(pair).map(([theme, symbol]) => {
    const body = svg(index, theme);
    if (theme === 'dark' && index % 2) {
      files[`avatar-${index}.svg`] = body;
      return `${symbol}=\`\`+new URL(\`avatar-${index}.svg\`,import.meta.url).href;`;
    }
    return `${symbol}=\`data:image/svg+xml,${encodeURIComponent(body)}\`;`;
  })).join('');
  files['app-initial-fixture.js'] = `${declarations}function Avatar(e){({seed:i,className:n,palette:a,...r}=e);let o=a===void 0?\`codex\`:a,s=isDark()===!0,c=o===\`chatgpt\`?10:Palette.length,l=Palette[select(i,c)],u=s?l.dark:l.light;return u}function select(e,t){let n=0;for(let t=0;t<e.length;t+=1)n=(n*31+e.charCodeAt(t))%Modulus;return n%t}Palette=[${pairs.map(pair => `{dark:${pair.dark},light:${pair.light}}`).join(',')}],Modulus=2147483647;export{Avatar as av};`;
  files['subagent-panel-fixture.js'] = 'import{av as d}from"./app-initial-fixture.js";function Row(n){return(0,r.jsx)(d,{className:`size-6`,palette:n.avatarPalette,seed:n.avatarSeed})}';
  files['local-conversation-subagents-panel-tab-fixture.js'] = 'import{panel as p}from"./subagent-panel-fixture.js";function row(e){return{avatarSeed:e.conversationId,id:e.conversationId,label:e.displayName}}';
  return files;
}

function asar(files, mutateHeader = () => {}) {
  let offset = 0;
  const entries = {}, bodies = [];
  for (const [name, body] of Object.entries(files)) {
    const bytes = Buffer.from(body);
    entries[name] = { size: bytes.length, offset: String(offset) };
    bodies.push(bytes);
    offset += bytes.length;
  }
  const header = { files: { webview: { files: { assets: { files: entries } } } } };
  mutateHeader(entries, header);
  const json = Buffer.from(JSON.stringify(header));
  const padding = (4 - json.length % 4) % 4;
  const size = json.length + padding + 8;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(size, 4);
  prefix.writeUInt32LE(size - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padding), ...bodies]);
}

async function fixture(t, files = sources(), mutateHeader) {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-avatar-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'app.asar');
  await writeFile(path, asar(files, mutateHeader));
  return { path, source: createCodexAvatarSource({ archives: [path] }) };
}

test('the five observed native UUIDs resolve their original selected artwork, including shared avatars', async t => {
  const { source } = await fixture(t);
  const results = [];
  for (const [id, index] of UUIDS) {
    const avatar = await source.forAgent(id);
    assert.ok(avatar, id);
    assert.equal(avatar.kind, 'asset');
    assert.match(avatar.asset_id, /^codex-native-[a-f0-9]{64}$/);
    for (const theme of ['light', 'dark']) assert.equal(await source.getAsset(avatar.asset_id, theme), svg(index, theme));
    results.push(avatar.asset_id);
  }
  assert.equal(results[0], results[3]);
  assert.equal(results[1], results[2]);
  assert.notEqual(results[0], results[1]);
  assert.notEqual(results[0], results[4]);
  assert.deepEqual(await source.forAgent(UUIDS[0][0].toUpperCase()), await source.forAgent(UUIDS[0][0]));
});

test('native SVGs are preserved byte for byte and asset IDs change when artwork changes', async t => {
  const one = await fixture(t);
  const changed = sources();
  changed['avatar-23.svg'] = svg(23, 'dark').replace('#123456', '#234567');
  const two = await fixture(t, changed);
  const a = await one.source.forAgent(UUIDS[0][0]), b = await two.source.forAgent(UUIDS[0][0]);
  assert.notEqual(a.asset_id, b.asset_id);
  assert.equal(await two.source.getAsset(b.asset_id, 'dark'), changed['avatar-23.svg']);
  assert.equal(await two.source.getAsset(a.asset_id, 'dark'), null);
});

test('concurrent reads share one cached catalog and never require the source archive again', async t => {
  const { source, path } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => source.forAgent(UUIDS[0][0])));
  assert.ok(results.every(value => value.asset_id === results[0].asset_id));
  await unlink(path);
  assert.equal(await source.getAsset(results[0].asset_id, 'dark'), svg(23, 'dark'));
  results[0].asset_id = 'mutated';
  assert.equal((await source.forAgent(UUIDS[0][0])).asset_id, results[1].asset_id);
});

test('invalid identities and resource keys return null without starting the lazy read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-lazy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'app.asar'), source = createCodexAvatarSource({ archives: [path] });
  for (const id of ['', 'not-a-thread', '../secret', `${UUIDS[0][0]}x`]) assert.equal(await source.forAgent(id), null);
  for (const id of ['', '../secret', 'https://outside.test/image.svg', 'codex-native-xx']) assert.equal(await source.getAsset(id, 'dark'), null);
  await writeFile(path, asar(sources()));
  const avatar = await source.forAgent(UUIDS[0][0]);
  assert.ok(avatar);
  assert.equal(await source.getAsset(avatar.asset_id, 'invalid-theme'), null);
  assert.equal(await source.getAsset(`codex-native-${'0'.repeat(64)}`, 'light'), null);
});

test('missing and unsupported applications yield null; later candidates can supply native artwork', async t => {
  const { path } = await fixture(t);
  assert.equal(await createCodexAvatarSource({ archives: [] }).forAgent(UUIDS[0][0]), null);
  assert.equal(await createCodexAvatarSource({ archives: [`${path}.missing`] }).forAgent(UUIDS[0][0]), null);
  const source = createCodexAvatarSource({ archives: [`${path}.missing`, path] });
  assert.ok(await source.forAgent(UUIDS[0][0]));
});

test('multiple supported installations with identical ordered artwork are unambiguous', async t => {
  const first = await fixture(t), second = await fixture(t);
  const source = createCodexAvatarSource({ archives: [first.path, second.path] });
  const avatar = await source.forAgent(UUIDS[0][0]);
  assert.deepEqual(avatar, await first.source.forAgent(UUIDS[0][0]));
  assert.equal(await source.getAsset(avatar.asset_id, 'dark'), svg(23, 'dark'));
});

test('different supported installations fall back instead of guessing the originating app', async t => {
  const first = await fixture(t), changed = sources();
  changed['avatar-23.svg'] = svg(23, 'dark').replace('#123456', '#234567');
  const second = await fixture(t, changed);
  for (const archives of [[first.path, second.path], [second.path, first.path]]) {
    const source = createCodexAvatarSource({ archives });
    for (const [id] of UUIDS) assert.equal(await source.forAgent(id), null);
    const known = await first.source.forAgent(UUIDS[0][0]);
    assert.equal(await source.getAsset(known.asset_id, 'dark'), null);
  }
  assert.ok(await createCodexAvatarSource({ archives: [second.path] }).forAgent(UUIDS[0][0]), 'an explicit single installation remains usable');
});

for (const [name, change] of [
  ['different selector multiplier', files => files['app-initial-fixture.js'] = files['app-initial-fixture.js'].replace('n*31', 'n*33')],
  ['different selector modulus', files => files['app-initial-fixture.js'] = files['app-initial-fixture.js'].replace('2147483647', '2147483646')],
  ['component uses another selector', files => files['app-initial-fixture.js'] = files['app-initial-fixture.js'].replace('Palette[select(i,c)]', 'Palette[other(i,c)]')],
  ['missing palette item', files => files['app-initial-fixture.js'] = files['app-initial-fixture.js'].replace(',{dark:d$27,light:l$27}', '')],
  ['panel imports another avatar component', files => files['subagent-panel-fixture.js'] = files['subagent-panel-fixture.js'].replace('av as d', 'other as d')],
  ['panel uses another seed', files => files['subagent-panel-fixture.js'] = files['subagent-panel-fixture.js'].replace('seed:n.avatarSeed', 'seed:n.label')],
  ['local panel uses display name', files => files['local-conversation-subagents-panel-tab-fixture.js'] = files['local-conversation-subagents-panel-tab-fixture.js'].replace('avatarSeed:e.conversationId', 'avatarSeed:e.displayName')],
  ['local panel overrides palette', files => files['local-conversation-subagents-panel-tab-fixture.js'] += ';const data={avatarPalette:"chatgpt"}'],
  ['ambiguous main modules', files => files['app-initial-second.js'] = files['app-initial-fixture.js']],
  ['external asset path', files => files['app-initial-fixture.js'] = files['app-initial-fixture.js'].replace('avatar-23.svg', '../../outside.svg')],
  ['missing referenced resource', files => delete files['avatar-23.svg']],
]) {
  test(`unsupported native layout falls back: ${name}`, async t => {
    const files = sources(); change(files);
    const { source } = await fixture(t, files);
    assert.equal(await source.forAgent(UUIDS[0][0]), null);
  });
}

for (const [name, mutate] of [
  ['unpacked resource', entries => entries['avatar-23.svg'].unpacked = true],
  ['symlink resource', entries => entries['avatar-23.svg'].link = '../outside.svg'],
  ['directory resource', entries => entries['avatar-23.svg'].files = {}],
  ['negative offset', entries => entries['avatar-23.svg'].offset = '-1'],
  ['unsafe offset', entries => entries['avatar-23.svg'].offset = '9007199254740991'],
  ['offset beyond archive', entries => entries['avatar-23.svg'].offset = '99999999'],
  ['oversized SVG', entries => entries['avatar-23.svg'].size = 65537],
  ['oversized main module', entries => entries['app-initial-fixture.js'].size = 17 * 1024 * 1024],
  ['linked assets directory', (_entries, header) => header.files.webview.files.assets.link = '../outside'],
]) {
  test(`invalid archive falls back: ${name}`, async t => {
    const { source } = await fixture(t, sources(), mutate);
    assert.equal(await source.forAgent(UUIDS[0][0]), null);
  });
}

test('malformed or oversized ASAR headers return null without large allocation', async t => {
  const { path } = await fixture(t);
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(0xffffffff, 4);
  await writeFile(path, bytes);
  assert.equal(await createCodexAvatarSource({ archives: [path] }).forAgent(UUIDS[0][0]), null);
  await writeFile(path, Buffer.from('not an archive'));
  assert.equal(await createCodexAvatarSource({ archives: [path] }).forAgent(UUIDS[0][0]), null);
});

for (const [name, body] of [
  ['script', '<script>alert(1)</script>'],
  ['event handler', '<rect onload="alert(1)"/>'],
  ['external href', '<image href="https://outside.test/track"/>'],
  ['foreign object', '<foreignObject><div>bad</div></foreignObject>'],
  ['external CSS URL', '<rect fill="url(https://outside.test/track)"/>'],
  ['escaped CSS URL', '<rect fill="u\\rl(https://outside.test/track)"/>'],
  ['HTML entity', '<rect fill="&#x72;ed"/>'],
  ['unexpected style', '<rect style="background:url(https://outside.test/track)"/>'],
  ['processing instruction', '<?xml-stylesheet href="https://outside.test/style"?>'],
  ['unbalanced markup', '<g><rect/></svg>'],
]) {
  test(`active or unsupported SVG falls back: ${name}`, async t => {
    const files = sources();
    files['avatar-23.svg'] = `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    const { source } = await fixture(t, files);
    assert.equal(await source.forAgent(UUIDS[0][0]), null);
  });
}
