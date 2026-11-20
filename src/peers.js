// 다른 PC의 Galaxy File과 연결하기: 연결된 PC 목록, 주변 PC, PC끼리 주고받는 요청
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

export const DEFAULT_PORT = 8765;
export const PEER_ID = /^[0-9a-f]{16}$/;
const PEER_KEY = /^[A-Za-z0-9_-]{20,100}$/;
const ONLINE_MS = 75_000; // 이 시간 동안 소식이 없으면 꺼진 것으로 본다
const MAX_SEEN = 64;

export const newPeerId = () => crypto.randomBytes(8).toString('hex');
export const newPeerKey = () => crypto.randomBytes(24).toString('base64url');
/** 두 PC 화면에 함께 띄워서 맞는 상대인지 눈으로 확인하는 네 자리 숫자 */
export const newPairCode = () => String(crypto.randomInt(1000, 10000));

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
 * 상대가 정말 연결해 둔 그 PC인지 확인하는 서명. 두 PC만 아는 키로 만들기 때문에
 * 같은 Wi-Fi의 다른 기기가 그 PC인 척 주소를 바꿔치기할 수 없다. 키 자체는 보내지 않는다.
 */
export function pairProof(key, nonce, fromId, toId) {
  return crypto.createHmac('sha256', key).update(`galaxy-file-proof\n${nonce}\n${fromId}\n${toId}`).digest('base64url');
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

/** 다른 PC의 Galaxy File에 JSON 요청을 보낸다. 응답이 JSON이 아니면 json은 null. */
export function requestJson({ address, port }, { method = 'GET', path: urlPath, body, headers = {}, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: address,
        port,
        method,
        path: urlPath,
        timeout,
        headers: {
          'X-Requested-With': 'galaxy-file',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
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
          resolve({ status: res.statusCode, json });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('시간 초과'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(payload);
  });
}

/** 그 주소에서 Galaxy File이 돌고 있으면 ping 응답({app, version, id, name})을, 아니면 null을 준다. */
export async function pingGalaxy(target, timeout = 1500) {
  try {
    const { status, json } = await requestJson(target, { path: '/api/ping', timeout });
    return status === 200 && json?.app === 'galaxy-file' ? json : null;
  } catch {
    return null;
  }
}

/**
 * 연결해 둔 PC(paired)와 지금 네트워크에서 보이는 PC(seen)를 관리한다.
 * 연결해 둔 PC는 서로 주고받은 키와 함께 파일에 저장한다.
 *  - sendKey: 내가 그 PC에 요청할 때 내미는 키 (그 PC가 만들어 준 것)
 *  - recvKey: 그 PC가 나에게 요청할 때 내미는 키 (내가 만들어 준 것)
 */
export class PeerBook {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.paired = new Map();
    this.seen = new Map();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const peer of data.peers || []) {
        if (isValidPairedPeer(peer)) this.paired.set(peer.id, peer);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`연결된 PC 목록을 읽지 못했어요: ${err.message}`);
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, peers: [...this.paired.values()] }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  getPaired(id) {
    return this.paired.get(id) ?? null;
  }

  /** 상대가 내민 키로 어느 PC인지 찾는다 */
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

  /** 확인된 새 주소로 바꾼다 (IP가 바뀐 경우) */
  moveTo(id, address, port) {
    const peer = this.paired.get(id);
    if (!peer || (peer.address === address && peer.port === port)) return false;
    peer.address = address;
    peer.port = port;
    this.save();
    return true;
  }

  pair({ id, name, address, port, sendKey, recvKey }) {
    this.paired.set(id, { id, name, address, port, sendKey, recvKey, pairedAt: this.now() });
    this.save();
  }

  unpair(id) {
    const peer = this.paired.get(id);
    if (!peer) return null;
    this.paired.delete(id);
    this.save();
    return peer;
  }

  isOnline(id) {
    const seen = this.seen.get(id);
    return Boolean(seen && this.now() - seen.lastSeen < ONLINE_MS);
  }

  /** 화면에 보여 줄 목록 (키는 빼고). 연결된 PC 먼저, 그다음 주변 PC. */
  list() {
    const out = [];
    for (const peer of this.paired.values()) {
      out.push({ id: peer.id, name: peer.name, address: peer.address, port: peer.port, paired: true, online: this.isOnline(peer.id) });
    }
    for (const seen of this.seen.values()) {
      if (this.paired.has(seen.id) || !this.isOnline(seen.id)) continue;
      out.push({ id: seen.id, name: seen.name, address: seen.address, port: seen.port, paired: false, online: true });
    }
    const collator = new Intl.Collator('ko');
    return out.sort((a, b) => Number(b.paired) - Number(a.paired) || collator.compare(a.name, b.name));
  }

  /** 다른 PC로 요청을 보낼 대상 (연결된 PC면 저장된 주소, 아니면 마지막으로 본 주소) */
  target(id) {
    const paired = this.paired.get(id);
    if (paired) return paired;
    const seen = this.seen.get(id);
    return seen && this.isOnline(id) ? seen : null;
  }

  /** 시간이 지나 꺼진 것으로 바뀐 PC가 있는지 알아보려고 쓰는 목록 요약 */
  signature() {
    return JSON.stringify(this.list());
  }
}

function isValidPairedPeer(peer) {
  return (
    peer &&
    PEER_ID.test(peer.id) &&
    typeof peer.name === 'string' &&
    typeof peer.address === 'string' &&
    isValidPort(peer.port) &&
    isValidKey(peer.sendKey) &&
    isValidKey(peer.recvKey)
  );
}
