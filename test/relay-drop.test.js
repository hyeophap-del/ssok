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
import { DropBook, cleanLinkName } from '../src/drops.js';
import { createRelayServer } from '../src/relay-server.js';
import { startRelayClient } from '../src/relay-client.js';
import { WsConnection } from '../src/ws.js';
import { RelayClient } from '../public/relay.js';
import { APP_ID } from '../src/brand.js';

// 링크로 주고받기: 쏙이 없는 사람이 ssok.example.com/minsu + 비밀번호로 웹에서 이 PC와 주고받는다.
// 그 사람은 보내기와, 이 PC가 그 사람에게 보낸 것 받기만 할 수 있다.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PC_ID = 'e5e5e5e5e5e5e5e5';
const TOKEN = 'drop-test-token';
const RELAY_KEY = 'relay-key-for-drop-test';
const MARKER = 'LINK-SECRET-CONTENT-';
const PIN = 'pin-7391-secret';
const XRW = { 'X-Requested-With': APP_ID };
let tmp;
let relay;
let relayBase;
let app;
let drops;
let store;
let client;
let clock = Date.now();
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
        resolve({ status: res.statusCode, json, body: Buffer.concat(chunks) });
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

/** 링크 화면(drop.js)과 같은 방법: 이름으로 찾고, ECDH 통로를 열고, 비밀번호는 암호화된 첫 메시지로 */
async function openLink(name, pin) {
  const res = await fetch(`${relayBase}/api/link/${name}`);
  if (!res.ok) throw Object.assign(new Error('없는 링크'), { status: res.status });
  const { pcId, linkId } = await res.json();
  return RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${pcId}`, 'ecdh', { kid: `d:${linkId}`, auth: { pin } });
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-link-'));
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
  drops = new DropBook(path.join(tmp, 'drops.json'), { now: () => clock }).load();
  app = createApp({
    token: TOKEN,
    receivedDir: path.join(tmp, 'received'),
    outboxDir: path.join(tmp, 'outbox'),
    store,
    publicDir: path.join(ROOT, 'public'),
    isHostAddress: () => true, // 이 PC 화면에서 온 요청 (중계 표시가 있으면 바깥 요청)
    self: { id: PC_ID, name: '거실 PC' },
    relayKey: RELAY_KEY,
    relayUrl: () => relayBase,
    drops,
    relayLinks: { claim: (name, id) => client.claimLink(name, id), release: (name) => client.releaseLink(name) },
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
    cookie: `${APP_ID}=${TOKEN}`,
    relayKey: RELAY_KEY,
    dropLookup: (id) => drops.active(id),
    links: () => drops.list().map((l) => ({ name: l.name, linkId: l.id })),
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

test('링크 이름은 주소에 쓸 수 있는 것만 받는다', () => {
  assert.equal(cleanLinkName('minsu'), 'minsu');
  assert.equal(cleanLinkName(' Mom-2 '), 'mom-2');
  assert.equal(cleanLinkName('ab'), null, '너무 짧다');
  assert.equal(cleanLinkName('민수'), null, '한글은 주소에서 깨지기 쉬워 받지 않는다');
  assert.equal(cleanLinkName('-minsu'), null);
  assert.equal(cleanLinkName('min--su'), null);
  assert.equal(cleanLinkName('api'), null, '중계 서버가 쓰는 이름');
});

test('PC 화면에서 이름과 비밀번호로 링크를 만든다 (중계 서버 안에서 이름이 겹치면 안 된다)', async () => {
  const made = await host('POST', '/api/drops', { label: '민수', name: 'minsu', pin: PIN, days: 7 });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.url, `${relayBase}/minsu`);
  assert.equal(made.json.pin, PIN);
  const lookup = await (await fetch(`${relayBase}/api/link/minsu`)).json();
  assert.equal(lookup.pcId, PC_ID);
  assert.equal(lookup.linkId, made.json.id);

  // 이름을 비우면 자동으로 짧은 이름을 정한다
  const auto = await host('POST', '/api/drops', { label: '엄마', name: '', pin: '1234', days: 0 });
  assert.equal(auto.status, 201);
  assert.match(auto.json.name, /^[a-z2-9]{6}$/);
  assert.equal(auto.json.expiresAt, null, '끌 때까지 쓰는 링크');

  assert.equal((await host('POST', '/api/drops', { name: 'minsu', pin: '1234' })).status, 409, '이 PC에서 이미 쓰는 이름');
  assert.equal((await host('POST', '/api/drops', { name: 'Bad Name!', pin: '1234' })).status, 400);
  assert.equal((await host('POST', '/api/drops', { name: 'short-pin', pin: '12' })).status, 400);

  // 같은 중계 서버를 쓰는 다른 PC가 같은 이름을 쓰려 하면 거절된다
  const other = new WebSocket(`${relayBase.replace('http', 'ws')}/ws/pc`);
  const replies = [];
  other.onmessage = (e) => replies.push(JSON.parse(String(e.data)));
  await new Promise((r) => (other.onopen = r));
  other.send(JSON.stringify({ t: 'register', id: 'ffffeeeeddddcccc', auth: 'other-pc-auth-0123456789abcdef', invite: relay.createInvite('지인').code, name: '지인 PC' }));
  await waitFor(() => replies.some((m) => m.t === 'ok'));
  other.send(JSON.stringify({ t: 'link-claim', rid: 1, name: 'minsu', linkId: 'aaaaaaaaaaaaaaaa' }));
  await waitFor(() => replies.some((m) => m.t === 'link-claim'));
  assert.equal(replies.find((m) => m.t === 'link-claim').ok, false);
  other.close();
});

test('링크를 연 사람은 비밀번호를 넣고 보내고, 이 PC가 보내 준 것만 받아 간다', async () => {
  const link = (await host('GET', '/api/drops')).json.links.find((l) => l.name === 'minsu');
  const minsu = await openLink('minsu', PIN);
  const info = await minsu.request('GET', '/api/drop-info');
  assert.equal(info.status, 200);
  assert.equal((await info.json()).name, '거실 PC');
  assert.deepEqual((await (await minsu.request('GET', '/api/drop-items')).json()).items, []);

  // 민수 → PC
  const content = Buffer.concat([Buffer.from(MARKER), crypto.randomBytes(150_000)]);
  const up = await minsu.request('POST', `/api/upload?name=${encodeURIComponent('민수 사진.jpg')}`, {
    headers: { 'x-requested-with': APP_ID, 'content-type': 'image/jpeg' },
    body: new Blob([content]),
  });
  assert.equal(up.status, 201);
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'received', '민수 사진.jpg')), content);
  assert.equal(store.list().find((i) => i.name === '민수 사진.jpg').device, '민수 · 링크');

  // PC → 민수 (파일, 텍스트)
  const gift = Buffer.concat([Buffer.from(MARKER), crypto.randomBytes(80_000)]);
  const sent = await local('POST', `/api/upload?name=${encodeURIComponent('민수에게.pdf')}&to=${link.id}`, { headers: { ...XRW, 'Content-Length': gift.length }, body: gift });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.to, link.id);
  assert.equal((await host('POST', '/api/text', { text: `${MARKER}메모`, to: link.id })).status, 201);
  // 휴대폰에서 보낸 것 (민수에게 보이면 안 된다)
  await local('POST', '/api/text', { headers: { ...XRW, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '내 휴대폰으로 보낸 것' }) });

  const items = (await (await minsu.request('GET', '/api/drop-items')).json()).items;
  assert.deepEqual(items.map((i) => i.name ?? i.text).sort(), [`${MARKER}메모`, '민수에게.pdf'].sort());
  const file = await minsu.request('GET', `/api/drop-files/${sent.json.id}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.bytes()), gift);
  const mine = store.list().find((i) => i.text === '내 휴대폰으로 보낸 것');
  assert.equal((await minsu.request('GET', `/api/drop-files/${mine.id}`)).status, 404);

  // 그 밖의 것은 막힌다
  for (const [method, p] of [
    ['GET', '/api/items'],
    ['GET', '/api/session'],
    ['GET', `/api/files/${sent.json.id}`],
    ['GET', '/api/events'],
    ['GET', '/api/drops'],
  ]) {
    assert.equal((await minsu.request(method, p, { headers: { 'x-requested-with': APP_ID } })).status, 403, `${method} ${p}`);
  }
  minsu.close();

  // 내 휴대폰(중계로 온 휴대폰)에는 민수에게 보낸 것이 섞이지 않는다
  const phone = { 'x-ssok-relay': RELAY_KEY, Cookie: `${APP_ID}=${TOKEN}` };
  const phoneItems = (await local('GET', '/api/items', { headers: phone })).json.items;
  assert.equal(phoneItems.some((i) => i.to), false);
  assert.equal((await local('GET', `/api/files/${sent.json.id}`, { headers: phone })).status, 404);
  // PC 화면에는 보인다
  assert.ok((await local('GET', '/api/items')).json.items.some((i) => i.to === link.id));

  // 중계 서버는 내용도 비밀번호도 볼 수 없다
  const everything = Buffer.concat(relayed);
  assert.equal(everything.includes(Buffer.from(MARKER)), false);
  assert.equal(everything.includes(Buffer.from(PIN)), false);
});

test('비밀번호가 틀리면 열리지 않고, 10번 틀리면 10분 동안 막힌다', async () => {
  const wrong = await openLink('minsu', 'not-the-pin');
  const res = await wrong.request('GET', '/api/drop-info');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'wrong');
  for (let i = 0; i < 9; i++) await wrong.request('GET', '/api/drop-info');
  wrong.close();
  const right = await openLink('minsu', PIN);
  const locked = await right.request('GET', '/api/drop-info');
  assert.equal(locked.status, 401);
  assert.equal((await locked.json()).code, 'locked');
  clock += 11 * 60_000;
  assert.equal((await right.request('GET', '/api/drop-info')).status, 200, '10분이 지나면 다시 된다');
  right.close();
});

test('PC 쪽 중계 연결을 건너뛰어도 쏙 서버가 한 번 더 막는다', async () => {
  const link = (await host('GET', '/api/drops')).json.links.find((l) => l.name === 'minsu');
  const asLink = { ...XRW, 'x-ssok-relay': RELAY_KEY, 'x-ssok-drop': link.id, 'x-ssok-pin': encodeURIComponent(PIN) };
  assert.equal((await local('GET', '/api/items', { headers: asLink })).status, 403);
  assert.equal((await local('GET', '/api/drops', { headers: asLink })).status, 403);
  assert.equal((await local('POST', '/api/quit', { headers: asLink })).status, 403);
  const noPin = { ...XRW, 'x-ssok-relay': RELAY_KEY, 'x-ssok-drop': link.id };
  assert.equal((await local('GET', '/api/drop-info', { headers: noPin })).status, 401);
});

test('링크를 끄거나 기간이 지나면 막히고 이름도 놓아준다', async () => {
  const link = (await host('GET', '/api/drops')).json.links.find((l) => l.name === 'minsu');
  const minsu = await openLink('minsu', PIN);
  assert.equal((await host('DELETE', `/api/drops/${link.id}`)).status, 204);
  assert.equal((await minsu.request('GET', '/api/drop-info')).status, 410, '열려 있던 화면도 바로 막힌다');
  minsu.close();
  await waitFor(async () => (await fetch(`${relayBase}/api/link/minsu`)).status === 404);

  const short = (await host('POST', '/api/drops', { label: '잠깐', name: 'jamkkan', pin: '5555', days: 1 })).json;
  clock += 2 * 86_400_000;
  await assert.rejects(openLink('jamkkan', '5555'), (err) => err.code === 'UNKNOWN_PEER');
  assert.equal((await host('GET', '/api/drops')).json.links.some((l) => l.id === short.id), false);
});

test('중계 서버는 /<링크 이름>으로 링크 화면을 내준다', async () => {
  for (const p of ['/minsu', '/Minsu', '/mom-2/']) {
    const page = await fetch(`${relayBase}${p}`);
    assert.equal(page.status, 200, p);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self' wss:/);
  }
  assert.match(await (await fetch(`${relayBase}/minsu`)).text(), /drop\.js/);
  assert.equal((await fetch(`${relayBase}/drop.html`)).status, 404);
  assert.equal((await fetch(`${relayBase}/drop.js`)).status, 200);
  assert.equal((await fetch(`${relayBase}/api`)).status, 404);
  assert.equal((await local('GET', '/drop.html')).status, 404, 'PC의 쏙은 링크 화면 파일을 내주지 않는다');
});
