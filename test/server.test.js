import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp, deviceLabel } from '../src/app.js';
import { Store } from '../src/store.js';
import { APP_NAME } from '../src/brand.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token_123';
const XRW = { 'X-Requested-With': 'ssok' };

// 서버는 하나만 띄우고, 접속하는 쪽 주소로 PC와 휴대폰을 구분한다 (실제와 같은 방식).
// 127.0.0.1에서 오면 PC, 127.0.0.2에서 오면 같은 Wi-Fi의 휴대폰으로 본다.
let tmp;
let app;
const host = { localAddress: '127.0.0.1' };
const remote = { localAddress: '127.0.0.2' };
let store;
let receivedDir;
let outboxDir;
const opened = [];

async function start() {
  app = createApp({
    token: TOKEN,
    receivedDir,
    outboxDir,
    store,
    publicDir: path.join(ROOT, 'public'),
    isHostAddress: (addr) => addr.replace(/^::ffff:/, '') === '127.0.0.1',
    lanAddresses: () => [{ address: '192.168.0.32', iface: 'Wi-Fi' }],
    opener: { open: (p) => opened.push(['open', p]), reveal: (p) => opened.push(['reveal', p]) },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  host.port = remote.port = app.server.address().port;
}

function request(target, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: target.port, localAddress: target.localAddress, method, path: urlPath, headers: { Host: `127.0.0.1:${target.port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json;
          try {
            json = JSON.parse(buf.toString('utf8'));
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const cookie = { Cookie: `ssok=${TOKEN}` };

function upload(target, name, content, headers = {}, extraQuery = '') {
  const body = Buffer.from(content);
  return request(target, {
    method: 'POST',
    path: `/api/upload?name=${encodeURIComponent(name)}${extraQuery}`,
    headers: { ...XRW, 'Content-Length': body.length, ...headers },
    body,
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-server-'));
  receivedDir = path.join(tmp, 'received');
  outboxDir = path.join(tmp, 'outbox');
  fs.mkdirSync(receivedDir);
  fs.mkdirSync(outboxDir);
  store = new Store(path.join(tmp, 'items.json')).load();
  await start();
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ping은 인증 없이 응답한다 (중복 실행 확인용)', async () => {
  const res = await request(remote, { path: '/api/ping' });
  assert.equal(res.status, 200);
  assert.equal(res.json.app, 'ssok');
});

test('토큰 없는 휴대폰은 API를 쓸 수 없다', async () => {
  assert.equal((await request(remote, { path: '/api/session' })).status, 401);
  assert.equal((await request(remote, { path: '/api/items' })).status, 401);
  assert.equal((await upload(remote, 'x.txt', 'hi')).status, 401);
  const wrong = await request(remote, { path: '/api/session', headers: { Cookie: 'ssok=wrong' } });
  assert.equal(wrong.status, 401);
});

test('QR 주소(?k=토큰)로 들어오면 쿠키를 받고 이후 인증된다', async () => {
  const page = await request(remote, { path: `/?k=${TOKEN}` });
  assert.equal(page.status, 200);
  assert.match(page.headers['set-cookie'][0], new RegExp(`^ssok=${TOKEN}; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax`));
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);

  const session = await request(remote, { path: '/api/session', headers: cookie });
  assert.equal(session.status, 200);
  assert.equal(session.json.isHost, false);
  assert.equal(session.json.addresses, undefined, '휴대폰에는 접속 주소(토큰)를 알려 주지 않는다');
});

test('화면 파일에는 프로그램 이름이 채워져서 나간다', async () => {
  const page = await request(remote, { path: '/' });
  const script = await request(remote, { path: '/app.js' });
  const manifest = await request(remote, { path: '/manifest.webmanifest' });
  for (const res of [page, script, manifest]) {
    const text = res.body.toString('utf8');
    assert.ok(!text.includes('{{APP_'), '자리표시가 남지 않는다');
    assert.equal(Number(res.headers['content-length']), res.body.length);
  }
  assert.match(page.body.toString('utf8'), new RegExp(`<title>${APP_NAME}</title>`));
  assert.equal(JSON.parse(manifest.body.toString('utf8')).name, APP_NAME);
});

test('PC 화면에는 QR 코드와 접속 주소를 준다', async () => {
  const res = await request(host, { path: '/api/session' });
  assert.equal(res.status, 200);
  assert.equal(res.json.isHost, true);
  assert.equal(res.json.receivedDir, receivedDir);
  assert.equal(res.json.addresses[0].url, `http://192.168.0.32:${host.port}/?k=${TOKEN}`);
  assert.match(res.json.addresses[0].qrSvg, /^<svg /);
});

test('PC라도 다른 웹사이트가 보낸 요청은 막는다', async () => {
  const res = await request(host, { path: '/api/items', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(res.status, 401);
});

test('낯선 도메인 이름(DNS 리바인딩)으로 온 요청은 막는다', async () => {
  const res = await request(host, { path: '/api/items', headers: { Host: `evil.example:${host.port}` } });
  assert.equal(res.status, 421);
});

test('쓰기 요청에는 X-Requested-With 헤더가 필요하다 (CSRF 방지)', async () => {
  const body = JSON.stringify({ text: 'hi' });
  const res = await request(remote, {
    method: 'POST',
    path: '/api/text',
    headers: { ...cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  assert.equal(res.status, 403);
  const crossOrigin = await request(remote, {
    method: 'POST',
    path: '/api/text',
    headers: { ...cookie, ...XRW, Origin: 'http://evil.example', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  assert.equal(crossOrigin.status, 403);
});

test('휴대폰이 보낸 파일은 받은 폴더에 원래 이름·날짜로 저장된다', async () => {
  const lastModified = Date.UTC(2025, 6, 1, 12, 0, 0);
  const res = await upload(remote, '여행/사진:1.jpg', 'JPEGDATA', { ...cookie, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; K) Mobile' }, `&lastModified=${lastModified}`);
  assert.equal(res.status, 201);
  assert.equal(res.json.name, '사진_1.jpg');
  assert.equal(res.json.from, 'remote');
  assert.equal(res.json.device, '휴대폰');
  assert.equal(res.json.path, undefined, '서버 경로는 노출하지 않는다');

  const saved = path.join(receivedDir, '사진_1.jpg');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'JPEGDATA');
  assert.equal(fs.statSync(saved).mtimeMs, lastModified);

  const again = await upload(remote, '사진:1.jpg', 'SECOND', cookie);
  assert.equal(again.json.name, '사진_1 (1).jpg', '같은 이름은 덮어쓰지 않는다');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'JPEGDATA');
  assert.deepEqual(fs.readdirSync(receivedDir).filter((n) => n.endsWith('.ssok-part')), []);
});

test('PC가 올린 파일은 휴대폰이 내려받을 수 있다 (이어받기 Range 포함)', async () => {
  const res = await upload(host, '문서.pdf', '0123456789');
  assert.equal(res.status, 201);
  const { id } = res.json;
  assert.ok(fs.existsSync(path.join(outboxDir, id, '문서.pdf')));

  const full = await request(remote, { path: `/api/files/${id}`, headers: cookie });
  assert.equal(full.status, 200);
  assert.equal(full.body.toString(), '0123456789');
  assert.equal(full.headers['content-type'], 'application/pdf');
  assert.match(full.headers['content-disposition'], /^attachment; .*filename\*=UTF-8''%EB%AC%B8%EC%84%9C\.pdf$/);

  const part = await request(remote, { path: `/api/files/${id}`, headers: { ...cookie, Range: 'bytes=3-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), '345');
  assert.equal(part.headers['content-range'], 'bytes 3-5/10');

  const suffix = await request(remote, { path: `/api/files/${id}`, headers: { ...cookie, Range: 'bytes=-4' } });
  assert.equal(suffix.body.toString(), '6789');

  const bad = await request(remote, { path: `/api/files/${id}`, headers: { ...cookie, Range: 'bytes=20-' } });
  assert.equal(bad.status, 416);

  const head = await request(remote, { method: 'HEAD', path: `/api/files/${id}`, headers: cookie });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '10');
});

test('HTML 파일은 미리보기를 요청해도 격리된 채로 내려받게 한다', async () => {
  const { json } = await upload(host, 'page.html', '<script>alert(1)</script>');
  const res = await request(remote, { path: `/api/files/${json.id}?inline=1`, headers: cookie });
  assert.match(res.headers['content-disposition'], /^attachment;/);
  assert.match(res.headers['content-security-policy'], /^sandbox/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  const img = await upload(host, 'a.png', 'PNG');
  const inline = await request(remote, { path: `/api/files/${img.json.id}?inline=1`, headers: cookie });
  assert.match(inline.headers['content-disposition'], /^inline;/);
});

test('텍스트를 주고받고, 목록에서 지울 수 있다', async () => {
  const body = JSON.stringify({ text: '안녕\r\nhttps://example.com' });
  const res = await request(remote, {
    method: 'POST',
    path: '/api/text',
    headers: { ...cookie, ...XRW, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.text, '안녕\nhttps://example.com');

  const list = await request(host, { path: '/api/items' });
  assert.equal(list.json.items[0].id, res.json.id, '최신 항목이 맨 앞');

  const del = await request(host, { method: 'DELETE', path: `/api/items/${res.json.id}`, headers: XRW });
  assert.equal(del.status, 204);
  const after = await request(host, { path: '/api/items' });
  assert.ok(!after.json.items.some((i) => i.id === res.json.id));

  const empty = JSON.stringify({ text: '   ' });
  const bad = await request(host, {
    method: 'POST',
    path: '/api/text',
    headers: { ...XRW, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(empty) },
    body: empty,
  });
  assert.equal(bad.status, 400);
});

test('PC가 올린 파일을 지우면 임시 사본도 지우고, 받은 파일은 남겨 둔다', async () => {
  const sent = await upload(host, 'temp.bin', 'x');
  const sentDir = path.join(outboxDir, sent.json.id);
  assert.ok(fs.existsSync(sentDir));
  await request(remote, { method: 'DELETE', path: `/api/items/${sent.json.id}`, headers: { ...cookie, ...XRW } });
  assert.equal(fs.existsSync(sentDir), false);

  const got = await upload(remote, 'keep.txt', 'keep', cookie);
  await request(host, { method: 'DELETE', path: `/api/items/${got.json.id}`, headers: XRW });
  assert.equal(fs.readFileSync(path.join(receivedDir, 'keep.txt'), 'utf8'), 'keep');
});

test('열기·폴더 보기는 PC에서만 된다', async () => {
  const { json } = await upload(remote, 'open-me.txt', 'x', cookie);
  const fromPhone = await request(remote, { method: 'POST', path: `/api/items/${json.id}/reveal`, headers: { ...cookie, ...XRW } });
  assert.equal(fromPhone.status, 403);
  const fromPc = await request(host, { method: 'POST', path: `/api/items/${json.id}/reveal`, headers: XRW });
  assert.equal(fromPc.status, 204);
  assert.deepEqual(opened.at(-1), ['reveal', path.join(receivedDir, 'open-me.txt')]);
});

test('보내다 끊긴 파일은 흔적 없이 정리된다', async () => {
  const before = store.list().length;
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: remote.port,
      localAddress: remote.localAddress,
      method: 'POST',
      path: '/api/upload?name=big.mp4',
      headers: { Host: `127.0.0.1:${remote.port}`, ...cookie, ...XRW, 'Content-Length': 1_000_000 },
    });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(1000));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 100);
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(store.list().length, before);
  assert.deepEqual(fs.readdirSync(receivedDir).filter((n) => n.includes('big') || n.endsWith('.ssok-part')), []);
});

test('실시간 알림(SSE)으로 목록과 새 항목을 받는다', async () => {
  const events = [];
  const req = http.get({
    host: '127.0.0.1',
    port: host.port,
    localAddress: host.localAddress,
    path: '/api/events',
    headers: { Host: `127.0.0.1:${host.port}` },
  });
  const res = await new Promise((resolve) => req.on('response', resolve));
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  let buffer = '';
  const gotAdd = new Promise((resolve) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event) events.push({ event, data: JSON.parse(data) });
        if (event === 'add') resolve();
      }
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  await upload(remote, 'live.txt', 'live', cookie);
  await gotAdd;
  req.destroy();

  assert.equal(events[0].event, 'snapshot');
  assert.ok(Array.isArray(events[0].data.items));
  const add = events.find((e) => e.event === 'add');
  assert.equal(add.data.name, 'live.txt');
  assert.equal(add.data.from, 'remote');
});

test('목록은 파일로 저장되고 다시 읽을 수 있다', async () => {
  store.saveNow();
  const reloaded = new Store(path.join(tmp, 'items.json')).load();
  assert.deepEqual(
    reloaded.list().map((i) => i.id),
    store.list().map((i) => i.id),
  );
});

test('접속한 기기 이름을 실제 브라우저 UA로 구분한다', () => {
  const samsungInternet =
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36';
  const chromeAndroid =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const galaxyTab = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  assert.equal(deviceLabel(samsungInternet), '휴대폰');
  assert.equal(deviceLabel(chromeAndroid), '휴대폰');
  assert.equal(deviceLabel(galaxyTab), '태블릿');
  assert.equal(deviceLabel(iphone), 'iPhone');
  assert.equal(deviceLabel(windows), '다른 PC');
  assert.equal(deviceLabel(undefined), '다른 기기');
});

test('예전 이름(Galaxy File) 때 저장된 휴대폰 쿠키로도 접속된다', async () => {
  const res = await request(remote, { path: '/api/session', headers: { Cookie: `gf=${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.equal(res.json.isHost, false);
  const wrong = await request(remote, { path: '/api/session', headers: { Cookie: 'gf=wrong' } });
  assert.equal(wrong.status, 401);
});

test('설정·끄기는 PC 화면에서만 된다', async () => {
  assert.equal((await request(remote, { path: '/api/settings', headers: cookie })).status, 403);
  const quit = await request(remote, { method: 'POST', path: '/api/quit', headers: { ...cookie, ...XRW } });
  assert.equal(quit.status, 403);
});

test('아이폰 단축어: 주소에 접속 코드를 담아 이름 없이 보내도 받는다', async () => {
  const shortcut = { 'User-Agent': 'BackgroundShortcutRunner/1.0 CFNetwork/1568.200.51 Darwin/24.1.0' };
  const photo = await request(remote, {
    method: 'POST',
    path: `/api/upload?k=${TOKEN}`,
    headers: { ...shortcut, 'Content-Type': 'image/heic', 'Content-Length': 4 },
    body: Buffer.from('HEIC'),
  });
  assert.equal(photo.status, 201, '단축어는 X-Requested-With 헤더를 붙이지 않아도 된다');
  assert.match(photo.json.name, /^iPhone \d{4}-\d\d-\d\d \d{6}\.heic$/);
  assert.equal(photo.json.device, 'iPhone');
  assert.equal(fs.readFileSync(path.join(receivedDir, photo.json.name), 'utf8'), 'HEIC');

  const text = await request(remote, {
    method: 'POST',
    path: `/api/upload?k=${TOKEN}`,
    headers: { ...shortcut, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength('공유한 링크 https://example.com') },
    body: '공유한 링크 https://example.com',
  });
  assert.equal(text.status, 201);
  assert.equal(text.json.kind, 'text');
  assert.equal(text.json.text, '공유한 링크 https://example.com');

  const wrong = await request(remote, { method: 'POST', path: '/api/upload?k=nope', headers: { 'Content-Length': 1 }, body: 'x' });
  assert.equal(wrong.status, 401);

  const session = await request(remote, { path: '/api/session', headers: cookie });
  assert.equal(session.json.shortcutUrl, `http://127.0.0.1:${remote.port}/api/upload?k=${TOKEN}`);
});
