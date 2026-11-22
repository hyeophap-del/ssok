import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { createRelayServer } from '../src/relay-server.js';
import { startRelayClient } from '../src/relay-client.js';
import { peerRelaySecret } from '../src/peers.js';
import { RelayClient } from '../public/relay.js';
import { APP_ID } from '../src/brand.js';

// 아이폰 단축어: 사진 앱의 공유 → 단축어가 https://<중계 서버>/s/<PC 번호>?k=<열쇠> 로 올리면 중계 서버가 PC로 넘긴다
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PC_ID = 'f6f6f6f6f6f6f6f6';
const TOKEN = 'shortcut-test-token';
const RELAY_KEY = 'relay-key-for-shortcut-test';
const SHORTCUT_KEY = 'shortcut-key-0123456789abcdefghij';
const SHORTCUTS_UA = 'BackgroundShortcutRunner/3607.0.2 CFNetwork/3826.400.120 Darwin/24.3.0';
let tmp;
let relay;
let relayBase;
let app;
let store;
let client;

/** 단축어처럼 중계 서버에 올린다. chunked면 크기를 알리지 않고 조각으로 보낸다. */
function shortcutPost(urlPath, body, { contentType = 'image/jpeg', chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const port = relay.server.address().port;
    const headers = { 'Content-Type': contentType, 'User-Agent': SHORTCUTS_UA, ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': body.length }) };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    if (chunked) {
      req.write(body.subarray(0, 1000));
      req.end(body.subarray(1000));
    } else {
      req.end(body);
    }
  });
}

function local(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = app.server.address().port;
    http
      .get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      })
      .on('error', reject);
  });
}

const waitFor = async (check, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('기다리던 상태가 되지 않았어요');
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-shortcut-'));
  relay = createRelayServer({ dataDir: path.join(tmp, 'relay'), publicDir: path.join(ROOT, 'public'), version: 'test' });
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  relayBase = `http://127.0.0.1:${relay.server.address().port}`;
  fs.mkdirSync(path.join(tmp, 'received'));
  fs.mkdirSync(path.join(tmp, 'outbox'));
  store = new Store(path.join(tmp, 'items.json')).load();
  app = createApp({
    token: TOKEN,
    receivedDir: path.join(tmp, 'received'),
    outboxDir: path.join(tmp, 'outbox'),
    store,
    publicDir: path.join(ROOT, 'public'),
    isHostAddress: () => false, // 이 시험에서는 모든 요청을 휴대폰 쪽으로 본다
    self: { id: PC_ID, name: '거실 PC' },
    relayKey: RELAY_KEY,
    relayUrl: () => relayBase,
    shortcutRelayUrl: () => `${relayBase}/s/${PC_ID}?k=${SHORTCUT_KEY}`,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const statuses = [];
  client = startRelayClient({
    relayUrl: relayBase,
    pcId: PC_ID,
    pcAuth: 'pc-auth-for-shortcut-test-0123456789',
    invite: relay.createInvite('나').code,
    secret: crypto.randomBytes(32),
    name: '거실 PC',
    version: 'test',
    localPort: app.server.address().port,
    cookie: `${APP_ID}=${TOKEN}`,
    relayKey: RELAY_KEY,
    shortcutSecret: () => peerRelaySecret(SHORTCUT_KEY),
    onStatus: (s) => statuses.push(s),
  });
  await waitFor(() => statuses.some((s) => s.state === 'connected'));
});

after(async () => {
  client?.stop();
  await app.close();
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('단축어가 중계 서버로 올린 사진이 PC의 받은 폴더에 들어간다', async () => {
  const photo = crypto.randomBytes(300_000);
  const res = await shortcutPost(`/s/${PC_ID}?k=${SHORTCUT_KEY}`, photo);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.match(res.json.name, /^iPhone .+\.jpg$/, '이름 없이 보내면 기기와 시각으로 이름을 붙인다');
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'received', res.json.name)), photo);
  const item = store.list().find((i) => i.name === res.json.name);
  assert.equal(item.device, 'iPhone');
  assert.equal(item.from, 'remote');
});

test('크기를 알리지 않고 보내도(chunked) 받는다, 짧은 텍스트는 텍스트로', async () => {
  const video = crypto.randomBytes(50_000);
  const res = await shortcutPost(`/s/${PC_ID}?k=${SHORTCUT_KEY}&name=${encodeURIComponent('밖에서 찍은 영상.mov')}`, video, { contentType: 'video/quicktime', chunked: true });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'received', '밖에서 찍은 영상.mov')), video, '바이트가 그대로여야 한다');
  const text = await shortcutPost(`/s/${PC_ID}?k=${SHORTCUT_KEY}`, Buffer.from('https://example.com 링크'), { contentType: 'text/plain' });
  assert.equal(text.status, 200);
  assert.ok(store.list().some((i) => i.kind === 'text' && i.text === 'https://example.com 링크'));
});

test('열쇠가 틀리면 거절하고, PC가 꺼져 있으면 알려 준다', async () => {
  assert.equal((await shortcutPost(`/s/${PC_ID}?k=wrong-key-0123456789abcdefgh`, Buffer.from('x'))).status, 401);
  assert.equal((await shortcutPost(`/s/${PC_ID}?k=short`, Buffer.from('x'))).status, 401);
  assert.equal((await shortcutPost(`/s/${PC_ID}`, Buffer.from('x'))).status, 401);
  const offline = await shortcutPost(`/s/0000000000000000?k=${SHORTCUT_KEY}`, Buffer.from('x'));
  assert.equal(offline.status, 503);
  assert.match(offline.json.error, /꺼져/);
});

test('단축어 통로로는 보내기만 된다 (목록·받기·설정은 막힌다)', async () => {
  const channel = await RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${PC_ID}`, peerRelaySecret(SHORTCUT_KEY), { kid: 'shortcut' });
  for (const p of ['/api/items', '/api/session', '/api/events']) assert.equal((await channel.request('GET', p)).status, 403, p);
  channel.close();
  // PC 쪽 중계 연결을 건너뛰어도 쏙 서버가 막는다
  assert.equal((await local('/api/items', { 'x-ssok-relay': RELAY_KEY, 'x-ssok-shortcut': '1' })).status, 403);
});

test('휴대폰 화면에 단축어 주소를 알려 준다 (중계로 들어온 휴대폰은 어디서나 주소만)', async () => {
  const home = await local('/api/session', { Cookie: `${APP_ID}=${TOKEN}` });
  assert.match(home.json.shortcutUrl, /\/api\/upload\?k=/);
  assert.equal(home.json.shortcutRelayUrl, `${relayBase}/s/${PC_ID}?k=${SHORTCUT_KEY}`);
  const away = await local('/api/session', { Cookie: `${APP_ID}=${TOKEN}`, 'x-ssok-relay': RELAY_KEY });
  assert.equal(away.json.shortcutUrl, undefined, '중계로 들어온 휴대폰은 집 Wi-Fi 주소를 모른다');
  assert.equal(away.json.shortcutRelayUrl, `${relayBase}/s/${PC_ID}?k=${SHORTCUT_KEY}`);
});
