import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { compareVersions, readManifest, createUpdater } from '../src/update.js';

// GitHub 릴리스 흉내: /latest/download/<파일>은 최신 릴리스로, /download/v<버전>/<파일>은 그 파일로 보낸다
const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const otherKeys = crypto.generateKeyPairSync('ed25519');
let server;
let base;
let tmp;
let release; // { version, files: { name: Buffer } }

function publish(version, exe, { signWith = keys.privateKey, tamperExe = false } = {}) {
  const name = `Ssok-${version}.exe`;
  const manifest = JSON.stringify({
    version,
    notes: `${version}에서 바뀐 점`,
    exe: { name, size: exe.length, sha256: crypto.createHash('sha256').update(exe).digest('hex') },
  });
  const signature = crypto.sign(null, Buffer.from(manifest), signWith).toString('base64');
  release = {
    version,
    files: {
      'latest.json': Buffer.from(manifest),
      'latest.json.sig': Buffer.from(signature),
      [name]: tamperExe ? Buffer.concat([exe.subarray(0, -1), Buffer.from('X')]) : exe,
    },
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssok-update-'));
  server = http.createServer((req, res) => {
    let m;
    if (!release) {
      res.writeHead(404);
      return res.end();
    }
    if ((m = /^\/releases\/latest\/download\/(.+)$/.exec(req.url))) {
      res.writeHead(302, { Location: `/releases/download/v${release.version}/${m[1]}` });
      return res.end();
    }
    if ((m = /^\/releases\/download\/v([\d.]+)\/(.+)$/.exec(req.url)) && m[1] === release.version && release.files[m[2]]) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(release.files[m[2]]);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/releases`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const updater = (currentVersion, changes = []) =>
  createUpdater({ currentVersion, releasesUrl: base, publicKey, downloadDir: path.join(tmp, 'download'), onChange: (s) => changes.push(s) });

test('버전을 숫자로 비교한다', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  assert.equal(compareVersions('2.3.4', '2.3.4'), 0);
});

test('아직 릴리스가 없으면 조용히 넘어간다', async () => {
  release = null;
  const state = await updater('1.0.0').check();
  assert.equal(state.available, null);
  assert.equal(state.error, null);
});

test('서명이 맞는 새 버전이 있으면 알려 주고, 같은 버전이면 알리지 않는다', async () => {
  publish('1.2.0', Buffer.from('NEW-EXE'));
  const changes = [];
  const state = await updater('1.1.0', changes).check();
  assert.deepEqual(state.available, { version: '1.2.0', notes: '1.2.0에서 바뀐 점', size: 7 });
  assert.ok(changes.some((s) => s.checking), 'PC 화면에 확인 중임을 알린다');

  const same = await updater('1.2.0').check();
  assert.equal(same.available, null);
});

test('다른 키로 서명한 업데이트 정보는 받아들이지 않는다', async () => {
  publish('9.9.9', Buffer.from('EVIL'), { signWith: otherKeys.privateKey });
  const state = await updater('1.0.0').check();
  assert.equal(state.available, null);
  assert.match(state.error, /서명/);
  assert.throws(() => readManifest('{"version":"1.0.0"}', 'AAAA', publicKey), /서명/);
});

test('새 exe를 내려받고, 올린 파일과 똑같은지 확인한다', async () => {
  const exe = crypto.randomBytes(300_000);
  publish('1.3.0', exe);
  const u = updater('1.0.0');
  await u.check();
  const file = await u.download();
  assert.equal(path.basename(file), 'Ssok-1.3.0.exe');
  assert.deepEqual(fs.readFileSync(file), exe);
});

test('중간에 바꿔치기된 exe는 지우고 설치하지 않는다', async () => {
  publish('1.4.0', crypto.randomBytes(1000), { tamperExe: true });
  const u = updater('1.0.0');
  await u.check();
  await assert.rejects(u.download(), /올린 파일과 달라요/);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'download')).filter((n) => n.includes('1.4.0')), []);
  assert.match(u.state().error, /달라요/);
  assert.equal(u.state().progress, null);
});
