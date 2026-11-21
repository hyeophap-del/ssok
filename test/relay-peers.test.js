import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { PeerBook, peerRelaySecret, cleanRelayUrl, pairChannelSecret, parseRemoteCode, requestJson } from '../src/peers.js';
import { openTunnel } from '../src/relay-tunnel.js';
import { loadIdentity } from '../src/tls.js';
import { createRelayServer } from '../src/relay-server.js';
import { startRelayClient } from '../src/relay-client.js';
import { WsConnection } from '../src/ws.js';
import { RelayClient } from '../public/relay.js';
import { APP_ID } from '../src/brand.js';

// PC 두 대(A, B)를 같은 네트워크에서 연결해 두고, B가 집 밖으로 나간 것처럼 만든 뒤 중계 서버로 보내 본다
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const XRW = { 'X-Requested-With': APP_ID };
const IDS = { A: 'a1a1a1a1a1a1a1a1', B: 'b2b2b2b2b2b2b2b2', C: 'c3c3c3c3c3c3c3c3', D: 'd4d4d4d4d4d4d4d4' };
const MARKER = 'PC-TO-PC-SECRET-CONTENT-';
let tmp;
let relay;
let relayBase;
const pcs = {};
const relayed = [];
const realSend = WsConnection.prototype.send;

async function startPc(letter) {
  const dir = path.join(tmp, letter);
  const receivedDir = path.join(dir, 'received');
  fs.mkdirSync(receivedDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  const store = new Store(path.join(dir, 'items.json')).load();
  const book = new PeerBook(path.join(dir, 'peers.json')).load();
  const identity = loadIdentity(dir, `PC-${letter}`);
  const relayKey = `relay-key-${letter}-${crypto.randomBytes(8).toString('hex')}`;
  const tunnelPorts = new Set();
  const pc = { letter, id: IDS[letter], name: `PC-${letter}`, store, book, receivedDir, relayKey, tunnelPorts };
  // server.js처럼: 연결 코드는 이 PC의 중계 연결에서 받는다
  const relayPairCode = () => (pc.relayClient ? pc.relayClient.requestPairCode() : Promise.reject(Object.assign(new Error('중계 서버 없음'), { status: 409 })));
  const app = createApp({
    token: `token-${letter}`,
    receivedDir,
    outboxDir: path.join(dir, 'outbox'),
    store,
    publicDir: path.join(ROOT, 'public'),
    isHostAddress: (addr) => addr.replace(/^::ffff:/, '') === '127.0.0.1',
    self: { id: IDS[letter], name: `PC-${letter}` },
    tls: identity,
    peerBook: book,
    relayKey,
    relayUrl: () => relayBase,
    relayPairCode,
    tunnelPorts,
    peerOptions: { pairTimeoutMs: 2000, verifyCooldownMs: 0, allowLocalRelay: true },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return Object.assign(pc, { app, port: app.server.address().port });
}

function connectRelay(pc, invite) {
  const statuses = [];
  pc.relayClient = startRelayClient({
    relayUrl: relayBase,
    pcId: pc.id,
    pcAuth: `auth-${pc.letter}-0123456789abcdefghij`,
    invite,
    secret: crypto.randomBytes(32),
    name: pc.name,
    version: 'test',
    localPort: pc.port,
    cookie: `${APP_ID}=token-${pc.letter}`,
    relayKey: pc.relayKey,
    tunnelPorts: pc.tunnelPorts,
    peerLookup: (id) => {
      const peer = pc.book.getPaired(id);
      return peer ? { secret: peerRelaySecret(peer.recvKey), key: peer.recvKey } : null;
    },
    onStatus: (s) => statuses.push(s),
  });
  return statuses;
}

function request(pc, { method = 'GET', path: urlPath = '/', headers = {}, body, secure = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      { host: '127.0.0.1', port: pc.port, localAddress: '127.0.0.1', method, path: urlPath, agent: false, rejectUnauthorized: false, headers: { Host: `127.0.0.1:${pc.port}`, ...headers } },
      (res) => {
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
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const postJson = (pc, urlPath, data) => {
  const body = Buffer.from(JSON.stringify(data));
  return request(pc, { method: 'POST', path: urlPath, headers: { ...XRW, 'Content-Type': 'application/json', 'Content-Length': body.length }, body });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(30);
  }
  assert.fail('기다리던 상태가 되지 않았어요');
}

/** PC 화면처럼 실시간 알림에서 한 가지를 기다린다 */
function waitForEvent(pc, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: pc.port, localAddress: '127.0.0.1', path: '/api/events', headers: { Host: `127.0.0.1:${pc.port}` } });
    const timer = setTimeout(() => (req.destroy(), reject(new Error(`'${event}' 알림이 오지 않았어요`))), timeout);
    req.on('error', () => {});
    req.on('response', (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (/^event: (.+)$/m.exec(block)?.[1] === event) {
            clearTimeout(timer);
            req.destroy();
            resolve(JSON.parse(/^data: (.+)$/m.exec(block)[1]));
          }
        }
      });
    });
  });
}

/** 빈 포트 (닫혀 있어서 접속이 거절되는 주소 = 같은 네트워크에서 사라진 PC) */
function deadPort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-relay-peers-'));
  WsConnection.prototype.send = function (data) {
    relayed.push(Buffer.from(data));
    return realSend.call(this, data);
  };
  relay = createRelayServer({ dataDir: path.join(tmp, 'relay'), publicDir: path.join(ROOT, 'public'), version: 'test' });
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  relayBase = `http://127.0.0.1:${relay.server.address().port}`;
  pcs.A = await startPc('A');
  pcs.B = await startPc('B');
});

after(async () => {
  WsConnection.prototype.send = realSend;
  for (const pc of Object.values(pcs)) pc.relayClient?.stop();
  await Promise.all(Object.values(pcs).map((pc) => pc.app.close()));
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('중계 서버 주소는 https만 받는다 (시험용 이 PC 주소는 따로 허용)', () => {
  assert.equal(cleanRelayUrl('https://ssok.example.com'), 'https://ssok.example.com');
  assert.equal(cleanRelayUrl('https://ssok.example.com/'), 'https://ssok.example.com');
  assert.equal(cleanRelayUrl('http://ssok.example.com'), null);
  assert.equal(cleanRelayUrl('http://127.0.0.1:8780'), null);
  assert.equal(cleanRelayUrl('http://127.0.0.1:8780', { allowLocal: true }), 'http://127.0.0.1:8780');
  assert.equal(cleanRelayUrl('https://ssok.example.com/p/x'), null);
  assert.equal(cleanRelayUrl(42), null);
});

test('같은 네트워크에서 연결할 때 서로의 중계 서버 주소를 알려 둔다', async () => {
  const { A, B } = pcs;
  const found = await postJson(A, '/api/peers/connect', { address: `127.0.0.1:${B.port}` });
  assert.equal(found.status, 200);
  const incoming = waitForEvent(B, 'pair-request');
  const started = await postJson(A, `/api/peers/${B.id}/pair`, {});
  assert.equal(started.status, 202);
  const result = waitForEvent(A, 'pair-result');
  const { rid } = await incoming;
  assert.equal((await postJson(B, `/api/pair-requests/${rid}/accept`, {})).status, 204);
  assert.equal((await result).ok, true);
  assert.equal(A.book.getPaired(B.id).relay, relayBase);
  assert.equal(B.book.getPaired(A.id).relay, relayBase);
});

test('같은 네트워크에 없으면 중계 서버로 파일과 텍스트를 보낸다 (내용은 중계 서버가 볼 수 없다)', async () => {
  const { A, B } = pcs;
  const invite = relay.createInvite('나').code;
  const aStatus = connectRelay(A, invite);
  const bStatus = connectRelay(B, invite);
  await waitUntil(() => aStatus.some((s) => s.state === 'connected') && bStatus.some((s) => s.state === 'connected'));

  // B가 집 밖으로 나갔다: A가 알던 주소로는 닿지 않는다
  A.book.moveTo(B.id, '127.0.0.1', await deadPort());
  A.book.lost(B.id);
  assert.equal((await request(A, { method: 'POST', path: '/api/peers/scan', headers: XRW })).status, 204);
  await waitUntil(async () => (await request(A, { path: '/api/peers' })).json.peers.find((p) => p.id === B.id)?.via === 'relay');

  const content = Buffer.concat([Buffer.from(MARKER), crypto.randomBytes(300_000)]);
  const up = await request(A, {
    method: 'POST',
    path: `/api/peers/${B.id}/upload?name=${encodeURIComponent('밖에서 보낸 문서.pdf')}`,
    headers: { ...XRW, 'Content-Length': content.length },
    body: content,
  });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal(up.json.via, 'relay');
  assert.deepEqual(fs.readFileSync(path.join(B.receivedDir, '밖에서 보낸 문서.pdf')), content);
  const item = B.store.list().find((i) => i.name === '밖에서 보낸 문서.pdf');
  assert.equal(item.from, 'peer');
  assert.equal(item.device, 'PC-A');

  const text = await postJson(A, `/api/peers/${B.id}/text`, { text: `${MARKER}텍스트` });
  assert.equal(text.status, 201);
  assert.ok(B.store.list().some((i) => i.kind === 'text' && i.text === `${MARKER}텍스트`));

  // B의 주소가 이 PC(127.0.0.1)로 바뀌면 안 된다 (중계로 온 요청은 이 PC 안에서 전달된 것)
  assert.equal(B.book.getPaired(A.id).port, A.port);

  const everything = Buffer.concat(relayed);
  assert.equal(everything.includes(Buffer.from(MARKER)), false, '중계 서버를 지나간 바이트에 내용이 보이면 안 된다');
  assert.equal(everything.includes(Buffer.from(A.book.getPaired(B.id).sendKey)), false, '키도 보이면 안 된다');
});

test('중계로 들어온 PC는 PC끼리 기능만 쓸 수 있다 (휴대폰처럼 목록을 보거나 받을 수 없다)', async () => {
  const { A, B } = pcs;
  const key = A.book.getPaired(B.id).sendKey;
  const client = await RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${B.id}`, peerRelaySecret(key), { kid: A.id });
  const info = await client.request('GET', '/api/peer/info');
  assert.equal(info.status, 200);
  assert.equal((await info.json()).relay, relayBase);
  assert.equal((await client.request('GET', '/api/items')).status, 403);
  assert.equal((await client.request('GET', '/api/session')).status, 403);
  client.close();

  // 다른 PC 번호를 사칭하면 열쇠가 맞지 않아 통로가 열리지 않는다
  await assert.rejects(RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${B.id}`, peerRelaySecret('wrong-key-0123456789abcdef'), { kid: A.id }));
  await assert.rejects(
    RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${B.id}`, peerRelaySecret(key), { kid: 'ffffffffffffffff' }),
    (err) => err.code === 'UNKNOWN_PEER',
  );
});

test('상대 PC에서 연결을 해제했으면 중계로 보내려 할 때 알려 주고 목록에서 지운다', async () => {
  const { A, B } = pcs;
  B.book.unpair(A.id);
  const res = await postJson(A, `/api/peers/${B.id}/text`, { text: '해제 뒤' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /해제/);
  assert.equal(A.book.getPaired(B.id), null);
});

test('연결 코드를 해석한다 (붙여 쓴 8글자는 PC 이름일 수 있어 코드로 보지 않는다)', () => {
  assert.deepEqual(parseRemoteCode('k7m2-qx9p'), { host: null, code: 'K7M2-QX9P' });
  assert.deepEqual(parseRemoteCode('K7M2 QX9P'), { host: null, code: 'K7M2-QX9P' });
  assert.deepEqual(parseRemoteCode('https://ssok.example.com/K7M2-QX9P'), { host: 'ssok.example.com', code: 'K7M2-QX9P' });
  assert.equal(parseRemoteCode('K7M2QX9P'), null);
  assert.equal(parseRemoteCode('192.168.0.40'), null);
});

test('다른 네트워크에 있는 PC와도 연결 코드로 처음 연결할 수 있다', async () => {
  pcs.C = await startPc('C');
  pcs.D = await startPc('D');
  const { C, D } = pcs;
  const invite = relay.createInvite('지인').code;
  const cStatus = connectRelay(C, invite);
  const dStatus = connectRelay(D, invite);
  await waitUntil(() => cStatus.some((s) => s.state === 'connected') && dStatus.some((s) => s.state === 'connected'));

  // 코드가 없거나 틀리면 찾지 못한다
  assert.equal((await postJson(C, '/api/peers/connect-remote', { code: 'ZZZZ-ZZZZ' })).status, 404);

  // D(받는 쪽)가 코드를 만들고, C에 그 코드를 넣는다
  const made = await postJson(D, '/api/peers/remote-code', {});
  assert.equal(made.status, 200);
  assert.match(made.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const incoming = waitForEvent(D, 'pair-request');
  const started = await postJson(C, '/api/peers/connect-remote', { code: made.json.code.toLowerCase() });
  assert.equal(started.status, 202, JSON.stringify(started.json));
  assert.equal(started.json.id, D.id);
  assert.equal(started.json.name, 'PC-D');
  const asked = await incoming;
  assert.equal(asked.code, started.json.code, '두 화면에 같은 확인 숫자가 뜬다');
  assert.equal(asked.address, '', '중계로 온 요청은 같은 네트워크 주소를 모른다');
  const result = waitForEvent(C, 'pair-result');
  assert.equal((await postJson(D, `/api/pair-requests/${asked.rid}/accept`, {})).status, 204);
  assert.equal((await result).ok, true);

  const dAtC = C.book.getPaired(D.id);
  const cAtD = D.book.getPaired(C.id);
  assert.equal(dAtC.address, '');
  assert.equal(dAtC.relay, relayBase);
  assert.equal(dAtC.port, D.port);
  assert.equal(cAtD.address, '');
  assert.equal(cAtD.relay, relayBase);
  assert.equal((await request(C, { path: '/api/peers' })).json.peers.find((p) => p.id === D.id).via, 'relay');

  // 연결되었으니 바로 중계로 주고받는다 (양쪽 모두)
  const toD = await postJson(C, `/api/peers/${D.id}/text`, { text: '다른 곳에서 처음 연결하고 보냄' });
  assert.equal(toD.status, 201, JSON.stringify(toD.json));
  assert.equal(toD.json.via, 'relay');
  assert.ok(D.store.list().some((i) => i.text === '다른 곳에서 처음 연결하고 보냄' && i.device === 'PC-C'));
  const toC = await postJson(D, `/api/peers/${C.id}/text`, { text: '답장' });
  assert.equal(toC.status, 201, JSON.stringify(toC.json));
  assert.ok(C.store.list().some((i) => i.text === '답장'));
});

test('연결 코드 통로로는 연결 과정만 밟을 수 있다 (PC 화면 권한이 없다)', async () => {
  const { C, D } = pcs;
  const { json } = await postJson(D, '/api/peers/remote-code', {});
  const url = `${relayBase.replace('http', 'ws')}/ws/c/${D.id}`;
  const client = await RelayClient.connect(url, pairChannelSecret(json.code, D.id), { kid: 'pair' });
  // 통로 안의 HTTPS로 PC 화면 전용 기능을 부르면, 이 PC 안에서 온 연결이어도 바깥 요청으로 다룬다
  const peers = await requestJson({ address: '127.0.0.1', port: D.port }, { path: '/api/peers', socket: openTunnel(client) });
  assert.equal(peers.status, 401);
  const settings = await requestJson({ address: '127.0.0.1', port: D.port }, { method: 'POST', path: '/api/quit', socket: openTunnel(client) });
  assert.equal(settings.status, 401);
  // HTTP 요청 전달(휴대폰용)은 쓸 수 없다
  assert.equal((await client.request('GET', '/api/session')).status, 403);
  client.close();

  // 코드를 만들지 않은 PC에는 연결 코드 통로가 열리지 않는다
  await assert.rejects(
    RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${C.id}`, pairChannelSecret(json.code, C.id), { kid: 'pair' }),
    (err) => err.code === 'UNKNOWN_PEER',
  );
});

test('휴대폰 앱도 연결할 때 받은 키로 중계 서버를 거쳐 보낸다 (앱 전용 기능만)', async () => {
  const { D } = pcs;
  // 앱과 연결된 상태 (연결 과정은 peers.test.js에서 시험한다)
  const appId = 'a9a9a9a9a9a9a9a9';
  const key = 'app-key-0123456789abcdefghijklmn';
  D.book.pair({ id: appId, name: 'Galaxy S24', kind: 'app', recvKey: key });
  const app = await RelayClient.connect(`${relayBase.replace('http', 'ws')}/ws/c/${D.id}`, peerRelaySecret(key), { kid: appId, device: 'Galaxy S24' });
  const info = await app.request('GET', '/api/peer/info');
  assert.equal(info.status, 200);
  assert.equal((await info.json()).relay, relayBase);
  const photo = crypto.randomBytes(120_000);
  const up = await app.request('POST', `/api/upload?name=${encodeURIComponent('앱에서 보낸 사진.jpg')}`, {
    headers: { 'x-requested-with': APP_ID, 'content-type': 'application/octet-stream' },
    body: photo,
  });
  assert.equal(up.status, 201);
  assert.deepEqual(fs.readFileSync(path.join(D.receivedDir, '앱에서 보낸 사진.jpg')), photo);
  const item = D.store.list().find((i) => i.name === '앱에서 보낸 사진.jpg');
  assert.equal(item.device, 'Galaxy S24');
  assert.equal(item.from, 'peer');
  assert.equal((await app.request('GET', '/api/items')).status, 403, '휴대폰 브라우저처럼 목록을 보지는 못한다');
  app.close();
});
