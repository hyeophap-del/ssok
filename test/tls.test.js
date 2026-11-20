import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createSelfSignedCert, fingerprintOf, pinnedTlsOptions, createDualServer, isValidCert } from '../src/tls.js';

function get(options) {
  return new Promise((resolve, reject) => {
    const req = (options.protocol === 'https:' ? https : http).request({ ...options, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, cert: res.socket.getPeerCertificate?.() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('자체 서명 인증서를 만들고 표준 도구로 읽을 수 있다', () => {
  const { key, cert } = createSelfSignedCert('거실 PC');
  const x509 = new crypto.X509Certificate(cert);
  assert.match(x509.subject, /CN=거실 PC/);
  assert.equal(x509.issuer, x509.subject);
  assert.ok(x509.verify(x509.publicKey), '자기 키로 서명되어 있다');
  assert.ok(x509.checkPrivateKey(crypto.createPrivateKey(key)));
  assert.ok(new Date(x509.validTo) > new Date('2049-01-01'));
  assert.match(fingerprintOf(cert), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(isValidCert(cert), true);
  assert.equal(isValidCert('garbage'), false);
});

test('한 포트에서 HTTP와 HTTPS를 함께 받고, 고정한 인증서가 아니면 연결을 거부한다', async () => {
  const mine = createSelfSignedCert('server');
  const other = createSelfSignedCert('impostor');
  const handler = (req, res) => res.end(req.socket.encrypted ? 'secure' : 'plain');
  const front = createDualServer(http.createServer(handler), https.createServer({ key: mine.key, cert: mine.cert }, handler));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const { port } = front.address();
  try {
    const plain = await get({ host: '127.0.0.1', port, path: '/' });
    assert.equal(plain.body, 'plain');

    const pinned = await get({ protocol: 'https:', host: '127.0.0.1', port, path: '/', ...pinnedTlsOptions(mine.cert) });
    assert.equal(pinned.body, 'secure');
    assert.equal(pinned.cert.fingerprint256, fingerprintOf(mine.cert));

    await assert.rejects(get({ protocol: 'https:', host: '127.0.0.1', port, path: '/', ...pinnedTlsOptions(other.cert) }), '다른 인증서로 고정했으면 거부');
    await assert.rejects(get({ protocol: 'https:', host: '127.0.0.1', port, path: '/' }), '기본 설정(공인 인증서만 믿음)으로도 거부');
  } finally {
    await new Promise((r) => front.close(r));
  }
});
