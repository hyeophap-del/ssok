import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRelayServer } from '../src/relay-server.js';
import { WsConnection } from '../src/ws.js';
import { FRAME } from '../public/relay.js';
import { RoomPeer } from '../public/room-core.js';

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

const roomUrl = () => `${base.replace('http', 'ws')}/ws/room`;
const enter = (cookie, options) => RoomPeer.open(roomUrl(), { ...options, headers: cookie ? { cookie } : undefined });

/** 받은 메시지를 모아 두는 방 기기 */
async function member(cookie, options) {
  const peer = await enter(cookie, options);
  peer.got = [];
  peer.onFrame = (from, type, id, payload) => peer.got.push({ from, type, id, payload: payload.slice() });
  peer.changes = [];
  peer.onMembers = (list, change) => change && peer.changes.push(change);
  return peer;
}
const textsOf = (peer) => peer.got.filter((f) => f.type === FRAME.TEXT).map((f) => JSON.parse(new TextDecoder().decode(f.payload)).text);

test('입장권(쿠키) 없이는 방을 만들 수 없고, 암호를 바꾸면 예전 입장권은 무효가 된다', async () => {
  await assert.rejects(enter(null, { create: true, device: 'PC' }));
  const cookie = (await login('4821')).headers.get('set-cookie').split(';')[0];
  const peer = await enter(cookie, { create: true, device: 'PC' });
  assert.match(peer.code, /^\d{6}$/);
  peer.close();
  relay.setWebPin('5932');
  await assert.rejects(enter(cookie, { create: true, device: 'PC' }), undefined, '암호를 바꾸면 다시 넣어야 한다');
  assert.equal((await login('4821')).status, 401);
});

test('여러 기기가 한 방에서 모두에게, 또는 한 기기에게만 보낸다 (중계 서버는 내용을 볼 수 없다)', async () => {
  const cookie = (await login('5932')).headers.get('set-cookie').split(';')[0];
  const pc = await member(cookie, { create: true, device: 'Windows PC' });
  assert.match(pc.url, new RegExp(`/#${pc.code}$`));
  assert.match(pc.qrSvg, /^<svg/);
  await assert.rejects(enter(cookie, { code: pc.code === '000000' ? '111111' : '000000', device: 'x' }), (err) => err.code === 'no-room');

  const iphone = await member(cookie, { code: pc.code, device: 'iPhone' });
  const galaxy = await member(cookie, { code: pc.code, device: 'Galaxy' });
  await Promise.all([iphone.keyed, galaxy.keyed]); // 방 열쇠를 건네받았다
  await waitFor(() => pc.members.size === 3 && iphone.members.size === 3);
  assert.deepEqual(galaxy.memberList().map((m) => m.device), ['Windows PC', 'iPhone', 'Galaxy']);

  // 모두에게
  await pc.send(0, FRAME.TEXT, 1, { text: `${MARKER}모두 안녕` });
  await waitFor(() => textsOf(iphone).length && textsOf(galaxy).length);
  assert.deepEqual(textsOf(iphone), [`${MARKER}모두 안녕`]);
  assert.equal(iphone.got[0].from, pc.you, '보낸 기기 번호는 중계 서버가 붙인다');

  // 한 기기에게만: 아이폰 → PC로 파일
  const photo = Buffer.concat([Buffer.from(MARKER), crypto.randomBytes(150_000)]);
  await iphone.send(pc.you, FRAME.FILE_HEAD, 7, { name: '사진.jpg', size: photo.length, type: 'image/jpeg' });
  for (let at = 0; at < photo.length; at += 64 * 1024) await iphone.send(pc.you, FRAME.FILE_DATA, 7, photo.subarray(at, at + 64 * 1024));
  await iphone.send(pc.you, FRAME.FILE_END, 7, {});
  await waitFor(() => pc.got.some((f) => f.type === FRAME.FILE_END));
  assert.deepEqual(Buffer.concat(pc.got.filter((f) => f.type === FRAME.FILE_DATA).map((f) => f.payload)), photo);
  assert.equal(galaxy.got.some((f) => f.type === FRAME.FILE_DATA), false, '고르지 않은 기기에는 가지 않는다');

  assert.equal(Buffer.concat(relayed).includes(Buffer.from(MARKER)), false, '중계 서버를 지나간 바이트에 내용이 보이면 안 된다');
  assert.equal(relay.webOverview().connected, 3);

  // 방을 만든 PC가 나가도 방은 남고, 새로 들어온 기기는 남아 있는 기기에게서 방 열쇠를 받는다
  pc.close();
  await waitFor(() => iphone.changes.some((c) => c.left?.device === 'Windows PC'));
  const ipad = await member(cookie, { code: iphone.code, device: 'iPad' });
  await ipad.keyed;
  await galaxy.send(0, FRAME.TEXT, 2, { text: '갤럭시가 모두에게' });
  await waitFor(() => textsOf(ipad).length && textsOf(iphone).length === 2);
  assert.deepEqual(textsOf(ipad), ['갤럭시가 모두에게']);
  for (const p of [iphone, galaxy, ipad]) p.close();
});

test('한 방에는 10대까지 들어온다', async () => {
  const cookie = (await login('5932')).headers.get('set-cookie').split(';')[0];
  const peers = [await enter(cookie, { create: true, device: '1번' })];
  for (let i = 2; i <= 10; i++) peers.push(await enter(cookie, { code: peers[0].code, device: `${i}번` }));
  await assert.rejects(enter(cookie, { code: peers[0].code, device: '11번' }), (err) => err.code === 'full');
  for (const p of peers) p.close();
});

test('방에서 보일 이름을 바꾸면 다른 기기에도 바로 바뀐다', async () => {
  const cookie = (await login('5932')).headers.get('set-cookie').split(';')[0];
  const a = await member(cookie, { create: true, device: 'Windows PC' });
  const b = await member(cookie, { code: a.code, device: 'Windows PC' });
  await b.keyed;
  a.rename('  민수 노트북  ');
  await waitFor(() => b.changes.some((c) => c.renamed));
  assert.deepEqual(b.changes.find((c) => c.renamed).renamed, { id: a.you, from: 'Windows PC', to: '민수 노트북' });
  assert.deepEqual(b.memberList().map((m) => m.device), ['민수 노트북', 'Windows PC']);
  assert.equal(a.memberList().find((m) => m.me).device, '민수 노트북');
  for (const p of [a, b]) p.close();
});

/** 웹소켓 약속을 손으로 따르는 기기: 신호(ping)에 답하지 않고, 원하면 받기도 멈춘다 (잠든 휴대폰·닫힌 창 흉내) */
async function rawMember(server, cookie, first) {
  const { port } = server.address();
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `GET /ws/room HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`,
  );
  let head = Buffer.alloc(0);
  while (!head.includes('\r\n\r\n')) head = Buffer.concat([head, (await once(socket, 'data'))[0]]);
  assert.match(head.toString(), /^HTTP\/1\.1 101/);
  const body = Buffer.from(JSON.stringify(first));
  const mask = crypto.randomBytes(4);
  const header = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 255]);
  socket.write(Buffer.concat([header, mask, Buffer.from(body.map((byte, i) => byte ^ mask[i % 4]))]));
  return socket;
}
const publicKeyHex = () => crypto.createECDH('prime256v1').generateKeys('hex');

test('답이 없거나 받지 못하고 막힌 기기는 방에서 빠지고, 나머지 기기는 계속 주고받는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-room-timing-'));
  const logs = [];
  const quick = createRelayServer({
    dataDir: dir,
    publicDir: path.join(ROOT, 'public'),
    version: 'test',
    log: (type, text) => logs.push(String(text)),
    roomTiming: { pingMs: 100, silentMs: 700, stallMs: 300 },
  });
  await new Promise((r) => quick.server.listen(0, '127.0.0.1', r));
  const quickBase = `http://127.0.0.1:${quick.server.address().port}`;
  quick.setWebPin('7310');
  const res = await fetch(`${quickBase}/api/web/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7310' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const url = `${quickBase.replace('http', 'ws')}/ws/room`;
  const open = async (options) => {
    const peer = await RoomPeer.open(url, { ...options, headers: { cookie } });
    peer.changes = [];
    peer.onMembers = (list, change) => change && peer.changes.push(change);
    return peer;
  };
  try {
    const pc = await open({ create: true, device: 'PC' });
    const phone = await open({ code: pc.code, device: '휴대폰' });
    await phone.keyed;

    // 1) 말없이 끊긴 기기 (신호에 답하지 않음): 잠시 뒤 빠져서 인원 수가 맞는다
    const sleepy = await rawMember(quick.server, cookie, { t: 'join', code: pc.code, device: '잠든 폰', e: publicKeyHex() });
    sleepy.resume();
    await waitFor(() => pc.members.size === 3);
    await waitFor(() => pc.changes.some((c) => c.left?.device === '잠든 폰'), 4000);
    assert.equal(pc.members.size, 2);
    assert.ok(logs.some((l) => l.includes('잠든 폰') && l.includes('응답이 없어')));
    sleepy.destroy();

    // 2) 받지 못하고 막힌 기기: 그 기기 때문에 다른 기기에 보내는 것이 멈추지 않는다
    const stuck = await rawMember(quick.server, cookie, { t: 'join', code: pc.code, device: '막힌 창', e: publicKeyHex() });
    await waitFor(() => pc.members.size === 3);
    stuck.pause();
    let received = 0;
    phone.onFrame = (from, type, id, payload) => type === FRAME.FILE_DATA && (received += payload.length);
    const chunk = crypto.randomBytes(64 * 1024);
    const total = 24 * 1024 * 1024;
    for (let sent = 0; sent < total; sent += chunk.length) {
      await pc.send(0, FRAME.FILE_DATA, 1, chunk);
      await pc.drain();
    }
    await waitFor(() => received === total, 8000);
    await waitFor(() => pc.changes.some((c) => c.left?.device === '막힌 창'));
    assert.equal(pc.members.size, 2);
    assert.ok(logs.some((l) => l.includes('막힌 창') && l.includes('오래 막혀')), '받지 못하고 막혀서 빠졌다');
    stuck.destroy();

    // 받는 쪽이 받은 만큼 알리는 메시지(FILE_PROGRESS)도 그대로 전해진다
    let progress = null;
    pc.onFrame = (from, type, id, payload) => type === FRAME.FILE_PROGRESS && (progress = { from, id, n: JSON.parse(new TextDecoder().decode(payload)).n });
    await phone.send(pc.you, FRAME.FILE_PROGRESS, 1, { n: total });
    await waitFor(() => progress);
    assert.deepEqual(progress, { from: phone.you, id: 1, n: total });
    for (const p of [pc, phone]) p.close();
  } finally {
    await quick.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("'모두'에게 보낼 때 받지 못하는 기기를 뺄 수 있고, 빈 목록이면 다시 모두에게 간다", async () => {
  const cookie = (await login('5932')).headers.get('set-cookie').split(';')[0];
  const a = await member(cookie, { create: true, device: 'PC' });
  const b = await member(cookie, { code: a.code, device: '아이폰' });
  const c = await member(cookie, { code: a.code, device: '갤럭시' });
  await Promise.all([b.keyed, c.keyed]);
  await a.skip(new Set([c.you]));
  await a.send(0, FRAME.TEXT, 1, { text: '갤럭시 빼고' });
  await a.skip([]);
  await a.send(0, FRAME.TEXT, 2, { text: '다시 모두' });
  await waitFor(() => textsOf(b).length === 2 && textsOf(c).length === 1);
  assert.deepEqual(textsOf(b), ['갤럭시 빼고', '다시 모두']);
  assert.deepEqual(textsOf(c), ['다시 모두']);
  for (const p of [a, b, c]) p.close();
});
