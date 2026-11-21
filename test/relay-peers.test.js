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
import { PeerBook, peerRelaySecret, cleanRelayUrl } from '../src/peers.js';
import { loadIdentity } from '../src/tls.js';
import { createRelayServer } from '../src/relay-server.js';
import { startRelayClient } from '../src/relay-client.js';
import { WsConnection } from '../src/ws.js';
import { RelayClient } from '../public/relay.js';
import { APP_ID } from '../src/brand.js';

// PC 두 대(A, B)를 같은 네트워크에서 연결해 두고, B가 집 밖으로 나간 것처럼 만든 뒤 중계 서버로 보내 본다
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const XRW = { 'X-Requested-With': APP_ID };
const IDS = { A: 'a1a1a1a1a1a1a1a1', B: 'b2b2b2b2b2b2b2b2' };
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
    peerOptions: { pairTimeoutMs: 2000, verifyCooldownMs: 0, allowLocalRelay: true },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const pc = { letter, id: IDS[letter], name: `PC-${letter}`, app, store, book, receivedDir, relayKey, port: app.server.address().port };
  return pc;
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
    peerLookup: (id) => {
      const peer = pc.book.getPaired(id);
      return peer?.kind === 'pc' ? { secret: peerRelaySecret(peer.recvKey), key: peer.recvKey } : null;
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
