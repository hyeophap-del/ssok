import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { PeerBook, parseAddress, cleanName, pairCode, sha256, newNonce } from '../src/peers.js';
import { loadIdentity, fingerprintOf, pemFromDer } from '../src/tls.js';
import { APP_ID } from '../src/brand.js';

// PC 여러 대를 한 컴퓨터에 띄워서 서로 연결해 본다.
// 각 PC의 화면(호스트)은 127.0.0.1에서, 같은 Wi-Fi의 휴대폰은 127.0.0.2에서 접속하는 것으로 본다.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const XRW = { 'X-Requested-With': APP_ID };
const IDS = { A: 'a0a0a0a0a0a0a0a0', B: 'b0b0b0b0b0b0b0b0', C: 'c0c0c0c0c0c0c0c0' };
let tmp;
const pcs = {};
const streams = [];

async function startPc(letter, peerOptions = {}) {
  const dir = path.join(tmp, letter);
  const receivedDir = path.join(dir, 'received');
  const outboxDir = path.join(dir, 'outbox');
  fs.mkdirSync(receivedDir, { recursive: true });
  fs.mkdirSync(outboxDir, { recursive: true });
  const store = new Store(path.join(dir, 'items.json')).load();
  const book = new PeerBook(path.join(dir, 'peers.json')).load();
  const identity = loadIdentity(dir, `PC-${letter}`);
  const app = createApp({
    token: `token-${letter}`,
    receivedDir,
    outboxDir,
    store,
    publicDir: path.join(ROOT, 'public'),
    isHostAddress: (addr) => addr.replace(/^::ffff:/, '') === '127.0.0.1',
    self: { id: IDS[letter], name: `PC-${letter}` },
    tls: identity,
    peerBook: book,
    peerOptions: { pairTimeoutMs: 2000, verifyCooldownMs: 0, ...peerOptions },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { letter, id: IDS[letter], name: `PC-${letter}`, app, store, book, identity, receivedDir, port: app.server.address().port };
}

/** secure: true면 HTTPS(인증서 확인 없이)로 보낸다. 응답에 상대 인증서(cert)를 붙여 준다. */
function request(pc, { method = 'GET', path: urlPath = '/', headers = {}, body, from = '127.0.0.1', secure = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        host: '127.0.0.1',
        port: pc.port,
        localAddress: from,
        method,
        path: urlPath,
        agent: false,
        rejectUnauthorized: false,
        headers: { Host: `127.0.0.1:${pc.port}`, ...headers },
      },
      (res) => {
        const raw = res.socket.getPeerCertificate?.()?.raw;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json, cert: raw ? pemFromDer(raw) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function postJson(pc, urlPath, data, headers = {}, options = {}) {
  const body = Buffer.from(JSON.stringify(data));
  return request(pc, {
    method: 'POST',
    path: urlPath,
    ...options,
    headers: { ...XRW, 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
    body,
  });
}

function postBytes(pc, urlPath, content, headers = {}, options = {}) {
  const body = Buffer.from(content);
  return request(pc, { method: 'POST', path: urlPath, ...options, headers: { ...XRW, 'Content-Length': body.length, ...headers }, body });
}

/** PC 화면처럼 실시간 알림을 받아 둔다 */
function listen(pc) {
  const events = [];
  const waiters = [];
  const req = http.get({ host: '127.0.0.1', port: pc.port, localAddress: '127.0.0.1', path: '/api/events', headers: { Host: `127.0.0.1:${pc.port}` } });
  req.on('error', () => {});
  req.on('response', (res) => {
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        if (!event) continue;
        const e = { event, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) };
        events.push(e);
        for (const w of [...waiters]) {
          if (w.event === event && w.match(e.data)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(e.data);
          }
        }
      }
    });
  });
  const stream = {
    events,
    waitFor(event, match = () => true, timeout = 4000) {
      const found = events.find((e) => e.event === event && match(e.data));
      if (found) return Promise.resolve(found.data);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${pc.name}: '${event}' 알림이 오지 않았어요`)), timeout);
        waiters.push({ event, match, resolve: (d) => (clearTimeout(timer), resolve(d)) });
      });
    },
    close: () => req.destroy(),
  };
  streams.push(stream);
  return stream;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail('기다리던 상태가 되지 않았어요');
}

/** A 화면에서 B를 주소로 찾아 연결하고, B 화면에서 허용한다 */
async function pair(a, b) {
  const aEvents = listen(a);
  const bEvents = listen(b);
  const found = await postJson(a, '/api/peers/connect', { address: `127.0.0.1:${b.port}` });
  assert.equal(found.status, 200);
  const started = await postJson(a, `/api/peers/${b.id}/pair`, {});
  assert.equal(started.status, 202);
  assert.match(started.json.code, /^\d{6}$/);
  const incoming = await bEvents.waitFor('pair-request');
  assert.equal(incoming.code, started.json.code, '두 화면에 같은 확인 숫자가 뜬다');
  const accepted = await postJson(b, `/api/pair-requests/${incoming.rid}/accept`, {});
  assert.equal(accepted.status, 204);
  const result = await aEvents.waitFor('pair-result', (d) => d.id === b.id);
  aEvents.close();
  bEvents.close();
  return { result, incoming, code: started.json.code };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-peers-'));
  pcs.A = await startPc('A');
  pcs.B = await startPc('B');
  pcs.C = await startPc('C', { pairTimeoutMs: 300 });
});

after(async () => {
  for (const s of streams) s.close();
  await Promise.all(Object.values(pcs).map((pc) => pc.app.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('주소 입력을 해석한다', () => {
  assert.deepEqual(parseAddress('192.168.0.40'), { address: '192.168.0.40', port: 8765 });
  assert.deepEqual(parseAddress(' http://192.168.0.40:8766/ '), { address: '192.168.0.40', port: 8766 });
  assert.deepEqual(parseAddress('DESKTOP-ABC'), { address: 'DESKTOP-ABC', port: 8765 });
  assert.equal(parseAddress('a b'), null);
  assert.equal(parseAddress('1.2.3.4:99999'), null);
  assert.equal(parseAddress(''), null);
  assert.equal(cleanName('  거실\u0000 PC‮  '), '거실 PC');
});

test('확인 숫자는 6자리이고, 인증서나 난수 중 하나만 달라도 바뀐다', () => {
  const base = ['AA:BB', 'CC:DD', 'n1', 'n2'];
  const code = pairCode(...base);
  assert.match(code, /^\d{6}$/);
  assert.equal(pairCode(...base), code);
  for (let i = 0; i < base.length; i++) {
    const changed = [...base];
    changed[i] += 'x';
    assert.notEqual(pairCode(...changed), code, `${i}번째 값이 바뀌면 숫자도 바뀐다`);
  }
});

test('ping에 이름과 고유 번호가 나오고, 같은 포트에서 HTTPS로도 응답한다', async () => {
  const plain = await request(pcs.A, { path: '/api/ping', from: '127.0.0.2' });
  assert.deepEqual(plain.json, { app: APP_ID, version: plain.json.version, id: IDS.A, name: 'PC-A', android: plain.json.android, addrs: [] });
  assert.ok(Number.isInteger(plain.json.android), '휴대폰 앱이 새 버전을 알 수 있게 앱 버전 번호를 알려 준다');
  assert.equal(plain.json.exe, undefined, '실행 파일 위치는 이 PC에서 물을 때만 알려 준다');
  const secure = await request(pcs.A, { path: '/api/ping', secure: true });
  assert.equal(secure.json.id, IDS.A);
  assert.equal(fingerprintOf(secure.cert), pcs.A.identity.fingerprint, 'HTTPS는 이 PC의 인증서로 응답한다');
});

test('주소로 다른 PC를 찾고, 상대 화면에서 허용하면 서로 연결된다', async () => {
  const { result, incoming } = await pair(pcs.A, pcs.B);
  assert.deepEqual(result, { id: IDS.B, ok: true, name: 'PC-B' });
  assert.equal(incoming.name, 'PC-A');
  assert.equal(incoming.kind, 'pc');
  assert.equal(incoming.address, '127.0.0.1');

  const aSide = pcs.A.book.getPaired(IDS.B);
  const bSide = pcs.B.book.getPaired(IDS.A);
  assert.equal(aSide.sendKey, bSide.recvKey, 'A가 B에 내미는 키는 B가 만들어 준 것');
  assert.equal(aSide.recvKey, bSide.sendKey);
  assert.equal(fingerprintOf(aSide.cert), pcs.B.identity.fingerprint, 'A는 B의 인증서를 기억한다');
  assert.equal(fingerprintOf(bSide.cert), pcs.A.identity.fingerprint, 'B는 A의 인증서를 기억한다');
  assert.equal(aSide.port, pcs.B.port);

  const list = await request(pcs.A, { path: '/api/peers' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.peers, [{ id: IDS.B, name: 'PC-B', kind: 'pc', address: '127.0.0.1', port: pcs.B.port, paired: true, online: true, via: 'lan', relay: false }]);
  const text = JSON.stringify(list.json);
  assert.ok(!text.includes(aSide.sendKey) && !text.includes('BEGIN CERTIFICATE'), '화면에는 키와 인증서를 보내지 않는다');

  const reloaded = new PeerBook(path.join(tmp, 'A', 'peers.json')).load();
  assert.equal(reloaded.getPaired(IDS.B).sendKey, aSide.sendKey, '연결은 파일에 저장되어 다시 켜도 유지된다');
});

test('연결된 PC로 보낸 파일·텍스트는 상대 PC의 받은 폴더와 목록에 들어간다', async () => {
  const bEvents = listen(pcs.B);
  const lastModified = Date.UTC(2025, 2, 3, 4, 5, 6);
  const res = await postBytes(pcs.A, `/api/peers/${IDS.B}/upload?name=${encodeURIComponent('회의록.pdf')}&lastModified=${lastModified}`, 'PDFDATA');
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, { ok: true, to: 'PC-B', via: 'lan' });

  const saved = path.join(pcs.B.receivedDir, '회의록.pdf');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'PDFDATA');
  assert.equal(fs.statSync(saved).mtimeMs, lastModified, '원래 수정 날짜 유지');
  const added = await bEvents.waitFor('add', (d) => d.name === '회의록.pdf');
  assert.equal(added.from, 'peer');
  assert.equal(added.device, 'PC-A');

  const text = await postJson(pcs.A, `/api/peers/${IDS.B}/text`, { text: '회의 링크 https://example.com' });
  assert.equal(text.status, 201);
  const textItem = pcs.B.store.list().find((i) => i.kind === 'text');
  assert.equal(textItem.text, '회의 링크 https://example.com');
  assert.equal(textItem.from, 'peer');

  assert.equal(pcs.A.store.list().length, 0, '보낸 쪽 목록(휴대폰용)에는 쌓지 않는다');
  assert.deepEqual(fs.readdirSync(pcs.B.receivedDir).filter((n) => n.endsWith(`.${APP_ID}-part`)), []);
});

test('휴대폰이나 연결된 PC는 PC 화면 전용 기능을 쓸 수 없고, 키는 암호화된 연결로만 받는다', async () => {
  const phone = { Cookie: `${APP_ID}=token-A` };
  assert.equal((await request(pcs.A, { path: '/api/peers', headers: phone, from: '127.0.0.2' })).status, 403);
  assert.equal((await postBytes(pcs.A, `/api/peers/${IDS.B}/upload?name=x`, 'x', phone, { from: '127.0.0.2' })).status, 403);

  // A가 받은 키로 B에 들어가면 'PC-A'로만 인정되고, 같은 컴퓨터에서 왔어도 B의 화면 권한은 없다
  const key = pcs.A.book.getPaired(IDS.B).sendKey;
  const asPeer = { Authorization: `Bearer ${key}` };
  assert.equal((await request(pcs.B, { path: '/api/peers', headers: asPeer, secure: true })).status, 403);
  assert.equal((await postJson(pcs.B, '/api/open-folder', {}, asPeer, { secure: true })).status, 403);
  const session = await request(pcs.B, { path: '/api/session', headers: asPeer, secure: true });
  assert.equal(session.json.isHost, false);
  assert.equal(session.json.device, 'PC-A');

  const overPlainHttp = await request(pcs.B, { path: '/api/session', headers: asPeer });
  assert.equal(overPlainHttp.status, 401, '평문(HTTP)으로 온 키는 맞아도 받지 않는다');

  const wrong = await postBytes(pcs.B, '/api/upload?name=x', 'x', { Authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, { secure: true });
  assert.equal(wrong.status, 401, '틀린 키는 같은 컴퓨터에서 와도 거절');
});

test('웹사이트가 몰래 연결 요청을 보내거나, 암호화 없이 연결할 수 없다', async () => {
  const body = JSON.stringify({ id: 'dddddddddddddddd', name: 'evil', kind: 'app', commit: sha256('x') });
  const noHeader = await request(pcs.B, {
    method: 'POST',
    path: '/api/pair/start',
    secure: true,
    headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  assert.equal(noHeader.status, 403);
  const plain = await postJson(pcs.B, '/api/pair/start', JSON.parse(body));
  assert.equal(plain.status, 400, 'HTTP로는 연결 요청을 받지 않는다');
  const bad = await postJson(pcs.B, '/api/pair/start', { id: 'nope', name: 'x', kind: 'pc', commit: 'short' }, {}, { secure: true });
  assert.equal(bad.status, 400);
  const self = await postJson(pcs.B, '/api/pair/start', { id: IDS.B, name: 'me', kind: 'app', commit: sha256('x') }, {}, { secure: true });
  assert.equal(self.status, 400);
});

test('봉인한 값과 다른 난수를 내면 연결 요청이 거절된다', async () => {
  const id = 'e0e0e0e0e0e0e0e0';
  const start = await postJson(pcs.C, '/api/pair/start', { id, name: '가짜', kind: 'app', commit: sha256(newNonce()) }, {}, { secure: true });
  assert.equal(start.status, 200);
  const finish = await postJson(pcs.C, '/api/pair/finish', { id, na: newNonce() }, {}, { secure: true });
  assert.equal(finish.status, 400);
  const again = await postJson(pcs.C, '/api/pair/finish', { id, na: newNonce() }, {}, { secure: true });
  assert.equal(again.status, 409, '한 번 틀리면 요청이 사라진다');
});

test('휴대폰 앱도 같은 방식으로 연결하고, 받은 키로 파일을 보낸다', async () => {
  const cEvents = listen(pcs.C);
  const appId = 'f0f0f0f0f0f0f0f0';
  const na = newNonce();
  const start = await postJson(pcs.C, '/api/pair/start', { id: appId, name: 'Galaxy S24', kind: 'app', commit: sha256(na) }, {}, { secure: true });
  assert.equal(start.status, 200);
  const myCode = pairCode(`app:${appId}`, fingerprintOf(start.cert), na, start.json.nb);

  const finishing = postJson(pcs.C, '/api/pair/finish', { id: appId, na }, {}, { secure: true });
  const incoming = await cEvents.waitFor('pair-request', (d) => d.id === appId);
  assert.equal(incoming.kind, 'app');
  assert.equal(incoming.code, myCode, '앱 화면과 PC 화면의 숫자가 같다');
  await postJson(pcs.C, `/api/pair-requests/${incoming.rid}/accept`, {});
  const finished = await finishing;
  assert.equal(finished.status, 200);

  const sent = await postBytes(pcs.C, '/api/upload?name=photo.jpg', 'JPEG', { Authorization: `Bearer ${finished.json.key}` }, { secure: true });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.device, 'Galaxy S24');
  assert.equal(sent.json.from, 'peer');
  const list = await request(pcs.C, { path: '/api/peers' });
  assert.equal(list.json.peers.find((p) => p.id === appId).kind, 'app');

  assert.equal((await postBytes(pcs.C, `/api/peers/${appId}/upload?name=x`, 'x')).status, 404, '앱으로는 PC에서 보낼 수 없다');
  const bye = await postJson(pcs.C, '/api/peer/unpair', {}, { Authorization: `Bearer ${finished.json.key}` }, { secure: true });
  assert.equal(bye.status, 204, '앱이 스스로 연결을 끊을 수 있다');
  assert.equal(pcs.C.book.getPaired(appId), null);
  cEvents.close();
});

test('상대가 거절하거나 응답하지 않으면 연결되지 않는다', async () => {
  const aEvents = listen(pcs.A);
  const cEvents = listen(pcs.C);
  assert.equal((await postJson(pcs.A, '/api/peers/connect', { address: `127.0.0.1:${pcs.C.port}` })).status, 200);

  await postJson(pcs.A, `/api/peers/${IDS.C}/pair`, {});
  const req1 = await cEvents.waitFor('pair-request', (d) => d.id === IDS.A);
  const pendingView = await request(pcs.C, { path: '/api/peers' });
  assert.equal(pendingView.json.request.rid, req1.rid, '나중에 연 화면에도 대기 중인 요청이 보인다');
  assert.equal((await postJson(pcs.C, `/api/pair-requests/${req1.rid}/deny`, {})).status, 204);
  const denied = await aEvents.waitFor('pair-result', (d) => d.id === IDS.C);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /거절/);

  await postJson(pcs.A, `/api/peers/${IDS.C}/pair`, {});
  const req2 = await cEvents.waitFor('pair-request', (d) => d.id === IDS.A && d.rid !== req1.rid);
  await cEvents.waitFor('pair-request-done', (d) => d.rid === req2.rid && d.decision === 'timeout');
  const timedOut = await aEvents.waitFor('pair-result', (d) => d.id === IDS.C && d.error !== denied.error);
  assert.match(timedOut.error, /응답이 없어/);
  assert.equal((await postJson(pcs.C, `/api/pair-requests/${req2.rid}/accept`, {})).status, 404, '끝난 요청은 허용할 수 없다');

  assert.equal(pcs.A.book.getPaired(IDS.C), null);
  assert.equal(pcs.C.book.getPaired(IDS.A), null);
});

test('연결된 PC의 주소가 바뀌면, 그 PC의 인증서로 확인된 경우에만 새 주소를 쓴다', async () => {
  const peer = pcs.A.book.getPaired(IDS.B);
  // C가 B인 척 "B가 C의 주소로 옮겼다"고 알린다 → C는 B의 인증서(개인 키)가 없으므로 무시된다
  pcs.A.app.peers.discovered({ id: IDS.B, name: 'PC-B', address: '127.0.0.1', port: pcs.C.port });
  await sleep(400);
  assert.equal(peer.port, pcs.B.port, '가짜 알림으로는 주소가 바뀌지 않는다');

  // 진짜로 주소가 바뀐 상황: 저장된 주소가 낡았고, B가 새 주소에서 알림을 보낸다
  peer.port = 1;
  pcs.A.app.peers.discovered({ id: IDS.B, name: 'PC-B', address: '127.0.0.1', port: pcs.B.port });
  await waitUntil(() => peer.port === pcs.B.port);
});

test('저장된 인증서가 아닌 PC로는 파일을 보내지 않는다', async () => {
  const peer = pcs.A.book.getPaired(IDS.B);
  const realPort = peer.port;
  peer.port = pcs.C.port; // B의 주소에 다른 PC(C)가 앉아 있는 상황
  const before = fs.readdirSync(pcs.C.receivedDir).length;
  const res = await postBytes(pcs.A, `/api/peers/${IDS.B}/upload?name=secret.txt`, 'SECRET');
  assert.equal(res.status, 502);
  assert.equal(fs.readdirSync(pcs.C.receivedDir).length, before, '다른 PC에는 한 바이트도 가지 않는다');
  peer.port = realPort;
});

test('보내다 취소하면 상대 PC에 받다 만 파일이 남지 않는다', async () => {
  const before = pcs.B.store.list().length;
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: pcs.A.port,
      localAddress: '127.0.0.1',
      method: 'POST',
      path: `/api/peers/${IDS.B}/upload?name=big.mp4`,
      headers: { Host: `127.0.0.1:${pcs.A.port}`, ...XRW, 'Content-Length': 5_000_000 },
    });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(200_000));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 150);
  });
  await waitUntil(() => fs.readdirSync(pcs.B.receivedDir).every((n) => !n.endsWith(`.${APP_ID}-part`)));
  assert.equal(pcs.B.store.list().length, before);
  assert.ok(!fs.existsSync(path.join(pcs.B.receivedDir, 'big.mp4')));
});

test('한쪽에서 연결을 해제하면 양쪽 모두 해제된다', async () => {
  const res = await request(pcs.A, { method: 'DELETE', path: `/api/peers/${IDS.B}`, headers: XRW });
  assert.equal(res.status, 204);
  assert.equal(pcs.A.book.getPaired(IDS.B), null);
  await waitUntil(() => pcs.B.book.getPaired(IDS.A) === null);
  assert.equal((await postBytes(pcs.A, `/api/peers/${IDS.B}/upload?name=x`, 'x')).status, 404);
});

test('상대 PC가 혼자 연결을 끊었으면 보낼 때 알려 주고 이쪽 연결도 정리한다', async () => {
  await pair(pcs.A, pcs.B);
  pcs.B.book.unpair(IDS.A); // A가 꺼져 있는 동안 B에서 해제한 상황
  const res = await postBytes(pcs.A, `/api/peers/${IDS.B}/text`, JSON.stringify({ text: 'hi' }), { 'Content-Type': 'application/json' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /연결이 해제/);
  assert.equal(pcs.A.book.getPaired(IDS.B), null);
});

test('상대 PC가 꺼져 있으면 보내지 못했다고 알려 준다', async () => {
  await pair(pcs.A, pcs.B);
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  pcs.A.book.getPaired(IDS.B).port = deadPort;

  const res = await postBytes(pcs.A, `/api/peers/${IDS.B}/upload?name=a.txt`, 'hello');
  assert.equal(res.status, 502);
  assert.match(res.json.error, /PC-B에 보내지 못했어요/);
  const list = await request(pcs.A, { path: '/api/peers' });
  assert.equal(list.json.peers.find((p) => p.id === IDS.B).online, false);
});

test('암호화 이전 방식으로 저장된 연결(인증서 없음)은 불러오지 않는다', () => {
  const file = path.join(tmp, 'legacy-peers.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, peers: [{ id: IDS.B, name: 'old', address: '1.2.3.4', port: 8765, sendKey: 'k'.repeat(32), recvKey: 'r'.repeat(32) }] }),
  );
  assert.equal(new PeerBook(file).load().paired.size, 0);
});
