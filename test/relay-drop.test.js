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
import { DropBook } from '../src/drops.js';
import { createRelayServer } from '../src/relay-server.js';
import { startRelayClient } from '../src/relay-client.js';
import { WsConnection } from '../src/ws.js';
import { RelayClient, fromHex } from '../public/relay.js';
import { APP_ID } from '../src/brand.js';

// 받기 링크: 쏙이 없는 사람이 링크로 이 PC에 보낸다. 보내기만 되고, 목록·받기·설정은 막힌다.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PC_ID = 'e5e5e5e5e5e5e5e5';
const RELAY_KEY = 'relay-key-for-drop-test';
const MARKER = 'DROP-LINK-SECRET-CONTENT-';
const XRW = { 'X-Requested-With': APP_ID };
let tmp;
let relay;
let relayBase;
let app;
let drops;
let store;
let client;
const relayed = [];
const realSend = WsConnection.prototype.send;

function local(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const port = app.server.address().port;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const host = (method, urlPath, data) => {
  const body = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
  return local(method, urlPath, { headers: { ...XRW, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) }, body });
};

/** 받기 링크 주소로 받는 사람 쪽 통로를 연다 (브라우저의 drop.js와 같은 방법) */
function openLink(url) {
  const u = new URL(url);
  const pcId = /^\/d\/([0-9a-f]{16})$/.exec(u.pathname)[1];
  const [linkId, secret] = u.hash.slice(1).split('.');
  return RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${pcId}`, fromHex(secret), { kid: `d:${linkId}` });
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-drop-'));
  WsConnection.prototype.send = function (data) {
    relayed.push(Buffer.from(data));
    return realSend.call(this, data);
  };
  relay = createRelayServer({ dataDir: path.join(tmp, 'relay'), publicDir: path.join(ROOT, 'public'), version: 'test' });
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  relayBase = `http://127.0.0.1:${relay.server.address().port}`;

  fs.mkdirSync(path.join(tmp, 'received'));
  fs.mkdirSync(path.join(tmp, 'outbox'));
  store = new Store(path.join(tmp, 'items.json')).load();
  drops = new DropBook(path.join(tmp, 'drops.json')).load();
  app = createApp({
    token: 'drop-test-token',
    receivedDir: path.join(tmp, 'received'),
    outboxDir: path.join(tmp, 'outbox'),
    store,
    publicDir: path.join(ROOT, 'public'),
    isHostAddress: () => true, // 이 PC 화면에서 온 요청 (중계 표시가 있으면 바깥 요청)
    self: { id: PC_ID, name: '거실 PC' },
    relayKey: RELAY_KEY,
    relayUrl: () => relayBase,
    drops,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));

  const statuses = [];
  client = startRelayClient({
    relayUrl: relayBase,
    pcId: PC_ID,
    pcAuth: 'pc-auth-for-drop-test-0123456789',
    invite: relay.createInvite('나').code,
    secret: crypto.randomBytes(32),
    name: '거실 PC',
    version: 'test',
    localPort: app.server.address().port,
    cookie: `${APP_ID}=drop-test-token`,
    relayKey: RELAY_KEY,
    dropLookup: (id) => {
      const link = drops.active(id);
      return link ? { secret: Buffer.from(link.secret, 'hex') } : null;
    },
    onStatus: (s) => statuses.push(s),
  });
  await waitFor(() => statuses.some((s) => s.state === 'connected'));
});

after(async () => {
  WsConnection.prototype.send = realSend;
  client?.stop();
  await app.close();
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('PC 화면에서 받기 링크를 만들면 중계 서버 주소로 된 링크가 나온다', async () => {
  const made = await host('POST', '/api/drops', { label: '민수', days: 7 });
  assert.equal(made.status, 201);
  assert.match(made.json.url, new RegExp(`^${relayBase}/d/${PC_ID}#[0-9a-f]{16}\\.[0-9a-f]{64}$`));
  assert.equal(made.json.label, '민수');
  assert.ok(made.json.expiresAt - Date.now() > 6.9 * 86_400_000);
  const session = await local('GET', '/api/session');
  assert.equal(session.json.drops.length, 1);
});

test('링크를 연 사람은 보낼 수만 있다 (내용은 중계 서버가 볼 수 없다)', async () => {
  const link = (await host('GET', '/api/drops')).json.links[0];
  const sender = await openLink(link.url);
  const info = await sender.request('GET', '/api/drop-info');
  assert.equal(info.status, 200);
  assert.equal((await info.json()).name, '거실 PC');

  const content = Buffer.concat([Buffer.from(MARKER), crypto.randomBytes(200_000)]);
  const up = await sender.request('POST', `/api/upload?name=${encodeURIComponent('민수가 보낸 사진.jpg')}`, {
    headers: { 'x-requested-with': APP_ID, 'content-type': 'image/jpeg' },
    body: new Blob([content]),
  });
  assert.equal(up.status, 201);
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'received', '민수가 보낸 사진.jpg')), content);
  const item = store.list().find((i) => i.name === '민수가 보낸 사진.jpg');
  assert.equal(item.device, '민수 · 받기 링크');
  assert.equal(item.from, 'remote');

  const text = await sender.request('POST', '/api/text', { headers: { 'x-requested-with': APP_ID, 'content-type': 'application/json' }, body: JSON.stringify({ text: `${MARKER}안녕` }) });
  assert.equal(text.status, 201);

  // 받은 목록, 파일 받기, 다른 기능은 모두 막힌다
  for (const [method, p] of [
    ['GET', '/api/items'],
    ['GET', '/api/session'],
    ['GET', `/api/files/${item.id}`],
    ['GET', '/api/events'],
    ['POST', '/api/drops'],
    ['GET', '/api/drops'],
  ]) {
    assert.equal((await sender.request(method, p, { headers: { 'x-requested-with': APP_ID } })).status, 403, `${method} ${p}`);
  }
  sender.close();

  const links = (await host('GET', '/api/drops')).json.links;
  assert.equal(links[0].count, 2, 'PC 화면에 이 링크로 받은 횟수가 보인다');
  assert.equal(Buffer.concat(relayed).includes(Buffer.from(MARKER)), false);
});

test('PC 쪽 중계 연결이 실수로 길을 열어도 쏙 서버가 한 번 더 막는다', async () => {
  const link = (await host('GET', '/api/drops')).json.links[0];
  const asDrop = { ...XRW, 'x-ssok-relay': RELAY_KEY, 'x-ssok-drop': link.id };
  assert.equal((await local('GET', '/api/items', { headers: asDrop })).status, 403);
  assert.equal((await local('GET', '/api/drops', { headers: asDrop })).status, 403);
  assert.equal((await local('POST', '/api/quit', { headers: asDrop })).status, 403);
  // 중계 표시 없이 받기 링크 표시만 붙이면 아무 의미가 없다 (이 PC 화면 요청으로 처리되고, 링크 권한도 아님)
  assert.equal((await local('GET', '/api/drop-info', { headers: { 'x-ssok-drop': link.id } })).status, 404);
});

test('링크를 끄거나 기간이 지나면 더 보낼 수 없다', async () => {
  const link = (await host('GET', '/api/drops')).json.links[0];
  const sender = await openLink(link.url);
  assert.equal((await host('DELETE', `/api/drops/${link.id}`)).status, 204);
  // 열려 있던 통로도 바로 막힌다
  assert.equal((await sender.request('GET', '/api/drop-info')).status, 410);
  sender.close();
  await assert.rejects(openLink(link.url), (err) => err.code === 'UNKNOWN_PEER');

  const short = (await host('POST', '/api/drops', { label: '잠깐', days: 1 })).json;
  drops.links.find((l) => l.id === short.id).expiresAt = Date.now() - 1;
  await assert.rejects(openLink(short.url), (err) => err.code === 'UNKNOWN_PEER');
  assert.equal((await host('GET', '/api/drops')).json.links.some((l) => l.id === short.id), false, '기간이 지난 링크는 목록에서 사라진다');
});

test('중계 서버는 받기 링크 화면을 /d/<PC 번호>로만 내준다', async () => {
  const page = await fetch(`${relayBase}/d/${PC_ID}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' wss:/);
  assert.match(await page.text(), /drop\.js/);
  assert.equal((await fetch(`${relayBase}/drop.html`)).status, 404);
  assert.equal((await fetch(`${relayBase}/drop.js`)).status, 200);
  // PC의 쏙은 받기 링크 화면 파일을 내주지 않는다
  assert.equal((await local('GET', '/drop.html')).status, 404);
});
