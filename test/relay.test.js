import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { createRelayServer } from '../src/relay-server.js';
import { startRelayClient } from '../src/relay-client.js';
import { WsConnection } from '../src/ws.js';
import { RelayClient } from '../public/relay.js';
import { APP_ID } from '../src/brand.js';

// 중계 서버, PC(쏙), 휴대폰(브라우저와 같은 코드)을 한 컴퓨터에 띄워 전체 흐름을 시험한다
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PC_ID = 'a1b2c3d4e5f60718';
const TOKEN = 'relay-test-token';
const MARKER = 'SECRET-PHOTO-CONTENT-'; // 중계 서버를 지나는 바이트에 이 글자가 보이면 안 된다
let tmp;
let relay;
let relayPort;
let app;
let client;
let invite;
const secret = crypto.randomBytes(32);
const relayed = []; // 중계 서버가 내보낸 바이트 (엿보기 시험용)
const realSend = WsConnection.prototype.send;

const phoneUrl = () => `ws://127.0.0.1:${relayPort}/ws/c/${PC_ID}`;
const waitFor = async (check, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('기다리던 상태가 되지 않았어요');
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-relay-'));
  WsConnection.prototype.send = function (data) {
    relayed.push(Buffer.from(typeof data === 'string' ? data : data));
    return realSend.call(this, data);
  };
  relay = createRelayServer({ dataDir: path.join(tmp, 'relay'), publicDir: path.join(ROOT, 'public'), version: 'test' });
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  relayPort = relay.server.address().port;
  invite = relay.createInvite('나').code;

  fs.mkdirSync(path.join(tmp, 'received'));
  fs.mkdirSync(path.join(tmp, 'outbox'));
  app = createApp({
    token: TOKEN,
    receivedDir: path.join(tmp, 'received'),
    outboxDir: path.join(tmp, 'outbox'),
    store: new Store(path.join(tmp, 'items.json')).load(),
    publicDir: path.join(ROOT, 'public'),
    isHostAddress: () => true, // 이 PC에서 온 요청은 모두 PC 화면으로 본다 (중계 표시가 있으면 휴대폰으로)
    relayKey: 'relay-key-for-test',
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
});

after(async () => {
  WsConnection.prototype.send = realSend;
  client?.stop();
  await app.close();
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function startPc(inviteCode, statuses = []) {
  return startRelayClient({
    relayUrl: `http://127.0.0.1:${relayPort}`,
    pcId: PC_ID,
    pcAuth: 'pc-auth-secret-value-1234567890',
    invite: inviteCode,
    secret,
    name: '거실 PC',
    version: 'test',
    localPort: app.server.address().port,
    cookie: `${APP_ID}=${TOKEN}`,
    relayKey: 'relay-key-for-test',
    onStatus: (s) => statuses.push(s),
  });
}

test('PC가 꺼져 있으면(중계 서버에 연결 전) 휴대폰에 알려 준다', async () => {
  await assert.rejects(RelayClient.connect(phoneUrl(), secret), (err) => err.code === 'PC_OFFLINE');
});

test('초대 코드가 틀리면 PC가 중계 서버에 연결하지 못한다', async () => {
  const statuses = [];
  const wrong = startPc('ZZZZ-ZZZZ', statuses);
  await waitFor(() => statuses.some((s) => s.state === 'error'));
  assert.match(statuses.find((s) => s.state === 'error').error, /초대 코드/);
  wrong.stop();
});

test('휴대폰이 중계 서버를 거쳐 PC와 암호화된 통로로 주고받는다', async () => {
  const statuses = [];
  client = startPc(invite, statuses);
  await waitFor(() => statuses.some((s) => s.state === 'connected'));

  const phone = await RelayClient.connect(phoneUrl(), secret, { device: '테스트 휴대폰' });
  const session = await (await phone.request('GET', '/api/session')).json();
  assert.equal(session.isHost, false, '중계로 온 요청은 PC 화면 권한이 없다');

  // 실시간 알림을 받아 둔다
  let events = '';
  const live = await phone.request('GET', '/api/events', { onChunk: (c) => (events += new TextDecoder().decode(c)) });
  assert.equal(live.status, 200);

  // 큰 파일 올리기 (조각 여러 개)
  const content = Buffer.concat([Buffer.from(MARKER), crypto.randomBytes(400_000)]);
  const progress = [];
  const up = await phone.request('POST', `/api/upload?name=${encodeURIComponent('밖에서 찍은 사진.jpg')}&lastModified=1735700000000`, {
    headers: { 'x-requested-with': APP_ID },
    body: new Blob([content]),
    onUploadProgress: (n) => progress.push(n),
  });
  assert.equal(up.status, 201);
  const item = await up.json();
  assert.equal(item.from, 'remote');
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'received', '밖에서 찍은 사진.jpg')), content);
  assert.equal(progress.at(-1), content.length);

  // 내려받기
  const down = await phone.request('GET', `/api/files/${item.id}`);
  assert.equal(down.status, 200);
  assert.deepEqual(Buffer.from(await down.bytes()), content);

  await waitFor(() => events.includes('event: add') && events.includes('밖에서 찍은 사진.jpg'));
  assert.ok(events.startsWith('retry:') || events.includes('event: snapshot'));

  // 중계 서버는 내용을 볼 수 없다
  const everything = Buffer.concat(relayed);
  assert.equal(everything.includes(Buffer.from(MARKER)), false, '중계 서버를 지나간 바이트에 파일 내용이 그대로 보이면 안 된다');
  assert.equal(everything.includes(Buffer.from(TOKEN)), false, '접속 코드도 보이면 안 된다');
  phone.close();
});

test('비밀 열쇠가 다르면 연결되지 않는다', async () => {
  await assert.rejects(RelayClient.connect(phoneUrl(), crypto.randomBytes(32)), (err) => err.code === 'BAD_KEY', 'QR을 다시 스캔하라고 알릴 수 있어야 한다');
});

test('중계로 온 휴대폰은 PC 화면 전용 기능(끄기·설정 등)을 쓸 수 없다', async () => {
  const phone = await RelayClient.connect(phoneUrl(), secret);
  const res = await phone.request('POST', '/api/open-folder', { headers: { 'x-requested-with': APP_ID } });
  assert.equal(res.status, 403);
  phone.close();
});

test('초대 코드를 막으면 그 PC의 연결이 끊긴다', async () => {
  relay.setInviteDisabled(invite, true);
  await waitFor(() => client.status().state !== 'connected');
  await assert.rejects(RelayClient.connect(phoneUrl(), secret), (err) => err.code === 'PC_OFFLINE');
  relay.setInviteDisabled(invite, false);
  const overview = relay.overview();
  assert.equal(overview.invites[0].pcs[0].name, '거실 PC');
  assert.ok(overview.invites[0].bytes > 400_000, '초대 코드별로 전송량을 센다');
});

test('PC의 신호(ping)에 중계 서버가 답한다 (말없이 끊긴 연결을 알아채려고)', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/pc`);
  const messages = [];
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: 'register', id: 'ffffeeeeddddcccc', auth: 'another-pc-auth-value-123456', invite, name: '다른 PC', version: 'test' }));
  await waitFor(() => messages.some((m) => m.t === 'ok'));
  ws.send(JSON.stringify({ t: 'ping' }));
  await waitFor(() => messages.some((m) => m.t === 'pong'));
  ws.close();
});

test('공격에 쓰일 만한 이상한 요청에도 중계 서버가 죽거나 엉뚱하게 답하지 않는다', async () => {
  const base = `http://127.0.0.1:${relayPort}`;
  assert.equal((await fetch(`${base}/api/link/%zz`)).status, 404, '깨진 주소는 오류(500)가 아니라 없음');
  assert.equal((await fetch(`${base}/api/link/constructor`)).status, 404, "'constructor'는 링크가 아니다");
  assert.equal((await fetch(`${base}/Relay-Admin.js`)).status, 404, '관리 화면 파일은 대소문자를 바꿔도 내주지 않는다');
});

test('제어 프레임이 크거나 PC가 이상한 링크 목록을 보내도 중계 서버는 계속 일한다', async () => {
  const net = await import('node:net');
  const socket = net.connect(relayPort, '127.0.0.1');
  await new Promise((r) => socket.on('connect', r));
  socket.write(`GET /ws/pc HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let got = Buffer.alloc(0);
  socket.on('data', (d) => (got = Buffer.concat([got, d])));
  await waitFor(() => got.includes('\r\n\r\n'));
  // 1000바이트짜리 ping (가려진 프레임)
  const body = Buffer.alloc(1000, 7);
  const mask = Buffer.from([1, 2, 3, 4]);
  socket.write(Buffer.concat([Buffer.from([0x89, 0x80 | 126, body.length >> 8, body.length & 255]), mask, body.map((b, i) => b ^ mask[i % 4])]));
  await waitFor(() => socket.destroyed || socket.readableEnded || got.length > 4, 3000);
  const afterHandshake = got.subarray(got.indexOf('\r\n\r\n') + 4);
  assert.notEqual(afterHandshake[0], 0x8a, '큰 ping에는 pong으로 답하지 않는다');
  socket.destroy();

  // 연결된 PC가 링크 목록에 null을 섞어 보내도 죽지 않는다
  const pcSock = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/pc`);
  await new Promise((r) => (pcSock.onopen = r));
  pcSock.send(JSON.stringify({ t: 'register', id: 'f0f0f0f0f0f0f0f0', auth: 'auth-for-bad-links-0123456789', invite, name: '이상한\n[가짜 기록] PC', version: 'test' }));
  await new Promise((r) => (pcSock.onmessage = r));
  pcSock.send(JSON.stringify({ t: 'link-sync', links: [null, 3, { name: 'okname', linkId: '0123456789abcdef' }] }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await fetch(`http://127.0.0.1:${relayPort}/api/link/okname`)).status, 200, '멀쩡한 것은 받아들이고 계속 일한다');
  assert.equal(relay.overview().invites.flatMap((i) => i.pcs).find((p) => p.id === 'f0f0f0f0f0f0f0f0')?.name.includes('\n'), false, '이름의 줄바꿈은 뺀다');
  pcSock.close();
});
