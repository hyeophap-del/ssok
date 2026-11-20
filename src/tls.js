// 암호화(TLS)에 쓰는 이 PC의 인증서 만들기, 상대 인증서 고정(pinning), 한 포트에서 HTTP·HTTPS 함께 받기.
// 외부 도구(openssl) 없이 Node만으로 자체 서명 인증서를 만든다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

// ---- DER(ASN.1) 인코딩: 인증서 한 장 만드는 데 필요한 만큼만 ----

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const sequence = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const explicit = (n, ...parts) => tlv(0xa0 + n, ...parts);
const utf8String = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const bitString = (bytes) => tlv(0x03, Buffer.from([0]), bytes);

function integer(bytes) {
  const body = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return tlv(0x02, body);
}

function objectId(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date) {
  const iso = date.toISOString(); // 2026-11-21T12:34:56.789Z
  const digits = iso.slice(0, 19).replace(/[-:T]/g, '');
  // 2049년까지는 UTCTime(두 자리 연도), 그 뒤는 GeneralizedTime
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';

/** EC P-256 키와 자체 서명 인증서(PEM)를 만든다. */
export function createSelfSignedCert(commonName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01; // 양수이면서 0으로 시작하지 않게
  const algorithm = sequence(objectId(ECDSA_WITH_SHA256));
  const name = sequence(set(sequence(objectId(COMMON_NAME), utf8String(commonName.slice(0, 60) || 'PC'))));
  const validity = sequence(time(new Date(Date.now() - 86_400_000)), time(new Date(Date.UTC(2049, 11, 31, 23, 59, 59))));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pemFromDer(sequence(tbs, algorithm, bitString(signature))),
  };
}

export function pemFromDer(der) {
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

/** 인증서 지문 (SHA-256, "AB:CD:..." 형식. Node의 getPeerCertificate().fingerprint256과 같다) */
export function fingerprintOf(certPem) {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

export function isValidCert(certPem) {
  try {
    return typeof certPem === 'string' && certPem.length < 4096 && Boolean(fingerprintOf(certPem));
  } catch {
    return false;
  }
}

/** 이 PC의 인증서. 처음 실행할 때 만들어 설정 폴더에 둔다. */
export function loadIdentity(dir, commonName) {
  const keyFile = path.join(dir, 'tls-key.pem');
  const certFile = path.join(dir, 'tls-cert.pem');
  try {
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(certFile, 'utf8');
    return { key, cert, fingerprint: fingerprintOf(cert) };
  } catch {
    // 없거나 망가졌으면 새로 만든다 (이미 연결된 PC들은 다시 연결해야 한다)
  }
  const created = createSelfSignedCert(commonName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, created.key, { mode: 0o600 });
  fs.writeFileSync(certFile, created.cert);
  return { ...created, fingerprint: fingerprintOf(created.cert) };
}

/**
 * 상대 인증서를 고정한 TLS 옵션. 저장해 둔 그 인증서가 아니면 연결 자체를 끊는다
 * (요청 내용은 인증서 확인이 끝나기 전에는 나가지 않는다).
 */
export function pinnedTlsOptions(certPem) {
  const expected = fingerprintOf(certPem);
  return {
    ca: [certPem],
    rejectUnauthorized: true,
    // IP 주소로 접속하므로 이름 대신 지문으로 확인한다
    checkServerIdentity: (_host, cert) => (cert.fingerprint256 === expected ? undefined : new Error('상대 PC의 인증서가 달라요')),
  };
}

/**
 * 한 포트에서 HTTP와 HTTPS를 함께 받는다. 연결의 첫 바이트가 TLS 핸드셰이크(0x16)면 HTTPS로 넘긴다.
 * 휴대폰 브라우저는 http://로, 다른 PC와 앱은 https://로 같은 주소에 접속한다.
 */
export function createDualServer(httpServer, httpsServer) {
  const front = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(15_000, () => socket.destroy()); // 아무것도 보내지 않는 연결은 정리
    socket.once('data', (chunk) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  // http 서버의 시간 제한(헤더를 너무 느리게 보내는 연결 끊기 등)은 'listening' 때 켜진다
  front.on('listening', () => {
    httpServer.emit('listening');
    httpsServer.emit('listening');
  });
  return front;
}
