import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { cleanHostname, findLoginUrl, findTunnelId, routedHostname, lastMeaningful } from '../src/cloudflared.js';
import { createAdminServer } from '../src/relay-admin.js';
import { isRelayExe } from '../src/relay-host.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('중계 서버 주소를 정리한다', () => {
  assert.equal(cleanHostname('ssok.example.com'), 'ssok.example.com');
  assert.equal(cleanHostname(' https://Ssok.Example.com/ '), 'ssok.example.com');
  assert.equal(cleanHostname('ssok.example.co.kr'), 'ssok.example.co.kr');
  assert.equal(cleanHostname('localhost'), null);
  assert.equal(cleanHostname('ssok example.com'), null);
  assert.equal(cleanHostname('ssok.example.com/path'), null);
  assert.equal(cleanHostname(''), null);
});

test('exe 이름에 relay가 들어 있으면 중계 서버로 실행한다', () => {
  assert.equal(isRelayExe('C:\\Users\\a\\Downloads\\Ssok-Relay.exe'), true);
  assert.equal(isRelayExe('C:\\Users\\a\\AppData\\Local\\Programs\\SsokRelay\\SsokRelay.exe'), true);
  assert.equal(isRelayExe('C:\\Users\\a\\Downloads\\Ssok-Relay (1).exe'), true);
  assert.equal(isRelayExe('C:\\Users\\a\\AppData\\Local\\Programs\\Ssok\\Ssok.exe'), false);
});

test('cloudflared 출력에서 필요한 값을 찾는다', () => {
  assert.equal(
    findLoginUrl('Please open the following URL and log in with your Cloudflare account:\n\nhttps://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc\n'),
    'https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc',
  );
  assert.equal(findTunnelId('Created tunnel ssok-relay with id 6ff42ae2-765d-4adf-8112-31c55c1551ef'), '6ff42ae2-765d-4adf-8112-31c55c1551ef');
  assert.equal(
    routedHostname('2026-11-21T08:53:48Z INF Added CNAME ssok.hyeophap.com which will route to this tunnel tunnelID=6ff42ae2-765d-4adf-8112-31c55c1551ef'),
    'ssok.hyeophap.com',
  );
  // 로그인할 때 다른 도메인을 고르면 그 도메인 뒤에 붙는다 → 알아챌 수 있어야 한다
  assert.equal(routedHostname('INF Added CNAME ssok.hyeophap.com.other.net which will route to this tunnel'), 'ssok.hyeophap.com.other.net');
  assert.equal(routedHostname('2026-11-21T08:53:48Z INF ssok.hyeophap.com is already configured to route to your tunnel tunnelID=x'), 'ssok.hyeophap.com');
  assert.equal(
    lastMeaningful('2026-11-21T08:53:48Z INF starting\n2026-11-21T08:53:49Z ERR Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.\n'),
    'Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.',
  );
});

/** 비어 있는 포트 하나 (관리 화면은 Host 헤더를 확인하려고 포트를 미리 알아야 한다) */
function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function call(port, { method = 'GET', path: urlPath, host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('관리 화면은 이 PC에서, 이 화면이 보낸 요청만 받는다', async () => {
  const invites = [];
  const port = await freePort();
  const admin = createAdminServer({
    publicDir: path.join(ROOT, 'public'),
    port,
    ping: () => ({ app: 'ssok-relay' }),
    state: () => ({ invites }),
    actions: {
      createInvite: (label) => {
        const invite = { code: 'ABCD-EFGH', label };
        invites.push(invite);
        return invite;
      },
      setInviteDisabled: (code) => invites.some((i) => i.code === code),
      setup: ({ hostname }) => {
        if (!hostname) throw Object.assign(new Error('주소를 확인해 주세요.'), { status: 400 });
      },
    },
  });
  await new Promise((r) => admin.listen(port, '127.0.0.1', r));
  try {
    assert.equal((await call(port, { path: '/api/ping' })).status, 200);
    assert.equal((await call(port, { path: '/api/state', host: `localhost:${port}` })).status, 200);
    // 다른 주소 이름으로 들어오면 (DNS 리바인딩) 거절
    assert.equal((await call(port, { path: '/api/state', host: `evil.example:${port}` })).status, 403);
    // 이 화면의 표시 헤더가 없으면 바꾸는 요청을 거절 (다른 웹사이트가 몰래 보내는 요청)
    assert.equal((await call(port, { method: 'POST', path: '/api/invites', body: { label: '나' } })).status, 403);
    const made = await call(port, { method: 'POST', path: '/api/invites', body: { label: '나' }, headers: { 'X-Requested-With': 'ssok' } });
    assert.equal(made.status, 201);
    assert.equal(JSON.parse(made.text).label, '나');
    assert.equal((await call(port, { method: 'POST', path: '/api/invites/ZZZZ-ZZZZ', body: { disabled: true }, headers: { 'X-Requested-With': 'ssok' } })).status, 404);
    assert.equal((await call(port, { method: 'POST', path: '/api/invites/ABCD-EFGH', body: { disabled: true }, headers: { 'X-Requested-With': 'ssok' } })).status, 204);
    const bad = await call(port, { method: 'POST', path: '/api/setup', body: {}, headers: { 'X-Requested-With': 'ssok' } });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.text).error, /주소/);
    const page = await call(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.text, /중계 서버/);
    assert.equal((await call(port, { path: '/app.js' })).status, 404, '휴대폰 화면 파일은 관리 화면에서 내주지 않는다');
  } finally {
    admin.close();
  }
});
