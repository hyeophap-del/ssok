import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRelayServer } from '../src/relay-server.js';
import { WsConnection } from '../src/ws.js';
import { SecureSocket, FRAME } from '../public/relay.js';

// 홈페이지에서 바로 주고받기: 암호(숫자 4자리)를 넣은 두 브라우저가 6자리 방 코드로 만나 종단간 암호화로 주고받는다
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'ROOM-SECRET-CONTENT-';
let tmp;
let relay;
let base;
const relayed = [];
const realSend = WsConnection.prototype.send;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-room-'));
  WsConnection.prototype.send = function (data) {
    relayed.push(Buffer.from(data));
    return realSend.call(this, data);
  };
  relay = createRelayServer({ dataDir: path.join(tmp, 'relay'), publicDir: path.join(ROOT, 'public'), version: 'test' });
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${relay.server.address().port}`;
});

after(async () => {
  WsConnection.prototype.send = realSend;
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const login = (pin, headers = {}) =>
  fetch(`${base}/api/web/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ pin }) });

/** 방 웹소켓을 열고 첫 메시지를 보낸다. 받은 글자 메시지를 모아 둔다. */
async function openRoom(cookie, first) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/room`, { headers: cookie ? { cookie } : {} });
  const messages = [];
  ws.onmessage = (e) => typeof e.data === 'string' && messages.push(JSON.parse(e.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('열리지 않음'));
  });
  ws.send(JSON.stringify(first));
  return { ws, messages };
}

const waitFor = async (check, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('기다리던 상태가 되지 않았어요');
};

test('암호를 정하기 전에는 홈페이지 주고받기가 꺼져 있다', async () => {
  const status = await (await fetch(`${base}/api/web/status`)).json();
  assert.deepEqual(status, { enabled: false, authed: false });
  assert.equal((await login('1234')).status, 404);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /room\.js/, '첫 화면은 홈페이지 주고받기 화면');
});

test('암호가 맞아야 들어가고, 한 곳에서 10번 틀리면 잠시 막힌다', async () => {
  relay.setWebPin('4821');
  assert.equal((await login('0000')).status, 401);
  const ok = await login('4821');
  assert.equal(ok.status, 204);
  assert.match(ok.headers.get('set-cookie'), /^ssok_web=.+HttpOnly; SameSite=Strict/);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(`${base}/api/web/status`, { headers: { cookie } })).json(), { enabled: true, authed: true });

  // 다른 주소(Cloudflare 헤더)에서 계속 틀리면 그 주소만 막힌다
  const attacker = { 'cf-connecting-ip': '203.0.113.9' };
  for (let i = 0; i < 9; i++) assert.equal((await login(String(1000 + i), attacker)).status, 401);
  assert.equal((await login('4821', attacker)).status, 204, '9번까지는 맞으면 들어간다');
  assert.equal((await login('1111', attacker)).status, 401);
  assert.equal((await login('4821', attacker)).status, 429, '10번 틀린 뒤에는 맞아도 막힌다');
});

test('입장권(쿠키) 없이는 방을 만들 수 없고, 암호를 바꾸면 예전 입장권은 무효가 된다', async () => {
  await assert.rejects(openRoom(null, { t: 'create' }));
  const cookie = (await login('4821')).headers.get('set-cookie').split(';')[0];
  const { ws } = await openRoom(cookie, { t: 'create' });
  ws.close();
  relay.setWebPin('5932');
  await assert.rejects(openRoom(cookie, { t: 'create' }), undefined, '암호를 바꾸면 다시 넣어야 한다');
  assert.equal((await login('4821')).status, 401);
});

test('방 코드로 만난 두 브라우저가 서로 파일·텍스트를 보낸다 (중계 서버는 내용을 볼 수 없다)', async () => {
  const cookie = (await login('5932')).headers.get('set-cookie').split(';')[0];
  const host = await openRoom(cookie, { t: 'create', device: 'Windows PC' });
  await waitFor(() => host.messages.some((m) => m.t === 'room'));
  const room = host.messages.find((m) => m.t === 'room');
  assert.match(room.code, /^\d{6}$/);
  assert.match(room.url, new RegExp(`/#${room.code}$`));
  assert.match(room.qrSvg, /^<svg/);

  // 틀린 코드
  const wrong = await openRoom(cookie, { t: 'join', code: room.code === '000000' ? '111111' : '000000' });
  await waitFor(() => wrong.messages.some((m) => m.t === 'error'));
  assert.equal(wrong.messages.find((m) => m.t === 'error').code, 'no-room');

  // 방을 만든 쪽은 'pc', 들어온 쪽은 'phone' 역할로 암호 통로를 연다 (room.js와 같다)
  const hostFrames = [];
  let hostSecure;
  host.ws.onmessage = (e) => {
    const msg = typeof e.data === 'string' ? JSON.parse(e.data) : null;
    if (msg?.t !== 'joined') return;
    assert.equal(msg.peer, 'iPhone');
    hostSecure = new SecureSocket(host.ws, { role: 'pc', secret: 'ecdh', onFrame: (type, id, payload) => hostFrames.push({ type, id, payload: payload.slice() }) });
  };
  const guestFrames = [];
  const guest = await openRoom(cookie, { t: 'join', code: room.code, device: 'iPhone' });
  await waitFor(() => guest.messages.some((m) => m.t === 'joined'));
  assert.equal(guest.messages.find((m) => m.t === 'joined').peer, 'Windows PC');
  const guestSecure = new SecureSocket(guest.ws, { role: 'phone', secret: 'ecdh', onFrame: (type, id, payload) => guestFrames.push({ type, id, payload: payload.slice() }) });
  await guestSecure.start({ device: 'iPhone' });
  await hostSecure.ready;

  // 휴대폰 → PC: 파일
  const photo = Buffer.concat([Buffer.from(MARKER), crypto.randomBytes(200_000)]);
  await guestSecure.send(FRAME.FILE_HEAD, 1, { name: '사진.jpg', size: photo.length, type: 'image/jpeg' });
  for (let at = 0; at < photo.length; at += 64 * 1024) await guestSecure.send(FRAME.FILE_DATA, 1, photo.subarray(at, at + 64 * 1024));
  await guestSecure.send(FRAME.FILE_END, 1, {});
  await waitFor(() => hostFrames.some((f) => f.type === FRAME.FILE_END));
  const head = JSON.parse(new TextDecoder().decode(hostFrames.find((f) => f.type === FRAME.FILE_HEAD).payload));
  assert.equal(head.name, '사진.jpg');
  const received = Buffer.concat(hostFrames.filter((f) => f.type === FRAME.FILE_DATA).map((f) => f.payload));
  assert.deepEqual(received, photo);

  // PC → 휴대폰: 텍스트 (양쪽 모두 보낼 수 있다)
  await hostSecure.send(FRAME.TEXT, 1, { text: `${MARKER}안녕` });
  await waitFor(() => guestFrames.some((f) => f.type === FRAME.TEXT));
  assert.equal(JSON.parse(new TextDecoder().decode(guestFrames.find((f) => f.type === FRAME.TEXT).payload)).text, `${MARKER}안녕`);

  // 방은 두 사람만: 같은 코드로 또 들어올 수 없다
  const third = await openRoom(cookie, { t: 'join', code: room.code });
  await waitFor(() => third.messages.some((m) => m.t === 'error'));

  assert.equal(Buffer.concat(relayed).includes(Buffer.from(MARKER)), false, '중계 서버를 지나간 바이트에 내용이 보이면 안 된다');
  assert.ok(relay.webOverview().bytes > 200_000, '주고받은 양을 센다');
  assert.equal(relay.webOverview().connected, 1);

  // 한쪽이 나가면 다른 쪽도 끝난다
  const closed = new Promise((r) => guest.ws.addEventListener('close', r));
  host.ws.close();
  await closed;
});
