import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
