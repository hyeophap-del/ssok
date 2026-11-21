// 다른 기기(PC, 휴대폰 앱)와 연결하기: 연결된 기기 목록, 주변 PC, 기기끼리 주고받는 암호화된 요청
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { APP_ID } from './brand.js';
import { isValidCert, pemFromDer, pinnedTlsOptions } from './tls.js';

export const DEFAULT_PORT = 8765;
export const PEER_ID = /^[0-9a-f]{16}$/;
export const NONCE = /^[0-9a-f]{32}$/;
const PEER_KEY = /^[A-Za-z0-9_-]{20,100}$/;
const ONLINE_MS = 75_000; // 이 시간 동안 소식이 없으면 꺼진 것으로 본다
const MAX_SEEN = 64;

export const newPeerId = () => crypto.randomBytes(8).toString('hex');
export const newPeerKey = () => crypto.randomBytes(24).toString('base64url');
export const newNonce = () => crypto.randomBytes(16).toString('hex');
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

export function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 40);
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 상대 PC의 중계 서버 주소 확인: 'https://ssok.example.com' 꼴만 받는다.
 * allowLocal은 시험할 때만 (이 PC 안의 http 주소).
 */
export function cleanRelayUrl(value, { allowLocal = false } = {}) {
  if (typeof value !== 'string' || value.length > 200) return null;
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    if (url.protocol === 'https:' && /^[A-Za-z0-9.-]+$/.test(url.hostname)) return `https://${url.host}`;
    if (allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return `http://${url.host}`;
  } catch {
    // 주소가 아니다
  }
  return null;
}

/**
 * 연결된 PC끼리 중계 서버로 주고받을 때 쓰는 비밀 열쇠.
 * 연결할 때 이미 나눠 가진 키(A가 B에게 내미는 키 = B가 A에게 준 키)에서 만들므로 따로 주고받을 것이 없다.
 */
export function peerRelaySecret(key) {
  return new Uint8Array(crypto.createHash('sha256').update(`ssok-peer-relay-v1:${key}`).digest());
}

export function isValidKey(key) {
  return typeof key === 'string' && PEER_KEY.test(key);
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * 두 화면에 띄워 눈으로 맞춰 보는 6자리 확인 숫자.
 * 요청한 쪽의 신원(인증서 지문), 받는 쪽 인증서 지문, 양쪽이 낸 난수로 계산한다.
 * 중간에서 누가 끼어들면 양쪽이 보는 인증서가 달라져 숫자가 어긋난다.
 * 요청한 쪽은 자기 난수를 먼저 '봉인'(해시)해서 보내고, 상대 난수를 받은 뒤에야 공개하므로
 * 끼어든 쪽이 숫자를 일부러 맞추려고 값을 골라 볼 수 없다.
 */
export function pairCode(initiator, responderFingerprint, initiatorNonce, responderNonce) {
  const digest = crypto
    .createHash('sha256')
    .update(`${APP_ID}-pair\n${initiator}\n${responderFingerprint}\n${initiatorNonce}\n${responderNonce}`)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** "192.168.0.40", "192.168.0.40:8766", "DESKTOP-ABC" 같은 입력을 주소와 포트로 나눈다. */
export function parseAddress(input) {
  const text = String(input ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  const m = /^([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(text);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  if (!isValidPort(port)) return null;
  return { address: m[1], port };
}

/**
 * 다른 PC의 이 프로그램에 암호화된(HTTPS) JSON 요청을 보낸다.
 * pin(상대 인증서)이 있으면 그 인증서가 아닐 때 아무것도 보내지 않고 실패한다.
 * pin이 없으면(처음 연결할 때) 상대 인증서를 받아 와서 돌려준다.
 */
export function requestJson({ address, port }, { method = 'GET', path: urlPath, body, headers = {}, timeout = 5000, pin = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        host: address,
        port,
        method,
        path: urlPath,
        timeout,
        agent: false,
        ...(pin ? pinnedTlsOptions(pin) : { rejectUnauthorized: false }),
        headers: {
          'X-Requested-With': APP_ID,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const raw = res.socket.getPeerCertificate?.()?.raw;
        const cert = raw ? pemFromDer(raw) : null;
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) req.destroy(new Error('응답이 너무 커요'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // JSON이 아닌 응답
          }
          resolve({ status: res.statusCode, json, cert });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('시간 초과'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(payload);
  });
}

/** 그 주소에서 이 프로그램이 돌고 있으면 ping 응답({app, version, id, name})을, 아니면 null을 준다. */
export async function pingApp(target, { timeout = 1500, pin = null } = {}) {
  try {
    const { status, json } = await requestJson(target, { path: '/api/ping', timeout, pin });
    return status === 200 && json?.app === APP_ID ? json : null;
  } catch {
    return null;
  }
}

/**
 * 연결해 둔 기기(paired)와 지금 네트워크에서 보이는 PC(seen)를 관리한다. 연결해 둔 기기는 파일에 저장한다.
 *  - kind: 'pc'(다른 PC, 서로 보낼 수 있음) 또는 'app'(휴대폰 앱, 이 PC로 보내기만 함)
 *  - cert: 그 PC의 인증서 (PC만. 그 PC에 접속할 때 이 인증서로 고정한다)
 *  - sendKey: 내가 그 PC에 요청할 때 내미는 키 (그 PC가 만들어 준 것, PC만)
 *  - recvKey: 그 기기가 나에게 요청할 때 내미는 키 (내가 만들어 준 것)
 */
export class PeerBook {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.paired = new Map();
    this.seen = new Map();
    this.relaySeen = new Map(); // 같은 네트워크에는 없지만 중계 서버에 연결되어 있는 PC → 마지막으로 확인한 때
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const peer of data.peers || []) {
        // 암호화 이전 버전에서 연결한 PC(인증서 없음)는 다시 연결해야 한다
        if (isValidPairedPeer(peer)) this.paired.set(peer.id, peer);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`연결된 기기 목록을 읽지 못했어요: ${err.message}`);
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, peers: [...this.paired.values()] }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  getPaired(id) {
    return this.paired.get(id) ?? null;
  }

  /** 상대가 내민 키로 어느 기기인지 찾는다 */
  byKey(key) {
    if (!isValidKey(key)) return null;
    for (const peer of this.paired.values()) {
      if (safeEqual(peer.recvKey, key)) return peer;
    }
    return null;
  }

  /** 네트워크에서 그 PC를 봤다. 목록 모양이 바뀌었으면 true. */
  saw({ id, name, address, port }) {
    const before = this.signature();
    const prev = this.seen.get(id);
    if (!prev && this.seen.size >= MAX_SEEN) {
      // 가짜 알림을 쏟아부어도 목록이 끝없이 커지지 않게, 꺼진 PC부터 정리하고 그래도 많으면 새 PC는 받지 않는다
      for (const old of this.seen.values()) if (!this.isOnline(old.id)) this.seen.delete(old.id);
      if (this.seen.size >= MAX_SEEN && !this.paired.has(id)) return false;
    }
    this.seen.set(id, { id, name: name || prev?.name || id, address, port, lastSeen: this.now() });
    const paired = this.paired.get(id);
    if (paired && name && paired.name !== name && paired.address === address) {
      paired.name = name;
      this.save();
    }
    return this.signature() !== before;
  }

  /** 꺼졌거나 연결이 끊긴 것으로 보이는 PC */
  lost(id) {
    const before = this.signature();
    this.seen.delete(id);
    return this.signature() !== before;
  }

/** 중계 서버에 연결되어 있는 것을 확인했다. 목록 모양이 바뀌었으면 true. */
  sawRelay(id) {
    const before = this.signature();
    this.relaySeen.set(id, this.now());
    return this.signature() !== before;
  }

  lostRelay(id) {
    const before = this.signature();
    this.relaySeen.delete(id);
    return this.signature() !== before;
  }

  /** 그 PC의 중계 서버 주소를 바꾼다 (그 PC에서 설정을 바꾼 경우). 바뀌었으면 true. */
  setRelay(id, relay) {
    const peer = this.paired.get(id);
    if (!peer || peer.kind !== 'pc' || (peer.relay ?? null) === (relay ?? null)) return false;
    if (relay) peer.relay = relay;
    else delete peer.relay;
    if (!relay) this.relaySeen.delete(id);
    this.save();
    return true;
  }

  /** 같은 네트워크에서는 안 보이지만 중계 서버로 닿는 PC인지 */
  isRelayOnline(id) {
    const at = this.relaySeen.get(id);
    return Boolean(at && this.paired.get(id)?.relay && this.now() - at < ONLINE_MS);
  }

  /** 확인된 새 주소로 바꾼다 (IP가 바뀐 경우) */
  moveTo(id, address, port) {
    const peer = this.paired.get(id);
    if (!peer || peer.kind !== 'pc' || (peer.address === address && peer.port === port)) return false;
    peer.address = address;
    peer.port = port;
    this.save();
    return true;
  }

  pair(peer) {
    const { id, name, kind, address, port, cert, sendKey, recvKey, relay } = peer;
    const record = kind === 'app' ? { id, name, kind, recvKey } : { id, name, kind, address, port, cert, sendKey, recvKey, ...(relay ? { relay } : {}) };
    this.paired.set(id, { ...record, pairedAt: this.now() });
    this.save();
  }

  unpair(id) {
    const peer = this.paired.get(id);
    if (!peer) return null;
    this.paired.delete(id);
    this.seen.delete(id);
    this.relaySeen.delete(id);
    this.save();
    return peer;
  }

  isOnline(id) {
    const seen = this.seen.get(id);
    return Boolean(seen && this.now() - seen.lastSeen < ONLINE_MS);
  }

  /** 화면에 보여 줄 목록 (키·인증서는 빼고). 연결된 기기 먼저, 그다음 주변 PC. */
  list() {
    const out = [];
    for (const peer of this.paired.values()) {
      out.push({
        id: peer.id,
        name: peer.name,
        kind: peer.kind,
        address: peer.address ?? null,
        port: peer.port ?? null,
        paired: true,
        // lan: 같은 네트워크에서 바로, relay: 중계 서버를 거쳐 (집 밖 등)
        online: this.isOnline(peer.id) || this.isRelayOnline(peer.id),
        via: this.isOnline(peer.id) ? 'lan' : this.isRelayOnline(peer.id) ? 'relay' : null,
        relay: Boolean(peer.relay),
      });
    }
    for (const seen of this.seen.values()) {
      if (this.paired.has(seen.id) || !this.isOnline(seen.id)) continue;
      out.push({ id: seen.id, name: seen.name, kind: 'pc', address: seen.address, port: seen.port, paired: false, online: true });
    }
    const collator = new Intl.Collator('ko');
    return out.sort((a, b) => Number(b.paired) - Number(a.paired) || collator.compare(a.name, b.name));
  }

  /** 연결하려고 찾아갈 PC (연결된 PC면 저장된 주소, 아니면 마지막으로 본 주소) */
  target(id) {
    const paired = this.paired.get(id);
    if (paired?.kind === 'pc') return paired;
    const seen = this.seen.get(id);
    return seen && this.isOnline(id) ? seen : null;
  }

  /** 시간이 지나 꺼진 것으로 바뀐 PC가 있는지 알아보려고 쓰는 목록 요약 */
  signature() {
    return JSON.stringify(this.list());
  }
}

function isValidPairedPeer(peer) {
  if (!peer || !PEER_ID.test(peer.id) || typeof peer.name !== 'string' || !isValidKey(peer.recvKey)) return false;
  if (peer.kind === 'app') return true;
  return (
    peer.kind === 'pc' &&
    typeof peer.address === 'string' &&
    isValidPort(peer.port) &&
    isValidKey(peer.sendKey) &&
    isValidCert(peer.cert) &&
    (peer.relay === undefined || typeof peer.relay === 'string')
  );
}
