// 홈페이지 방의 약속 (브라우저 room.js와 시험이 함께 쓴다): 여러 기기(최대 10대)가 한 방에서 주고받는다.
//
// 1. 방을 만든 기기가 '방 열쇠'(AES-GCM 256비트)를 만든다.
// 2. 기기마다 그 자리에서 ECDH 열쇠 쌍을 만들어 공개 열쇠를 중계 서버에 알린다 (들어올 때 모두에게 전해진다).
// 3. 새 기기가 들어오면 방 열쇠를 가진 기기들이 그 기기와의 ECDH로 방 열쇠를 감싸서 건넨다 (signal).
// 4. 그 뒤 모든 메시지는 방 열쇠로 암호화한다. 받는 사람은 0(모두) 또는 특정 기기 번호이고, 중계 서버는 보낸 사람 번호를 붙여 나눠 준다.
//    파일은 한 번만 올리면 중계 서버가 여러 기기에 나눠 주고, 중계 서버는 내용을 볼 수 없다.
//
// 바이트 메시지:  보낼 때 [받는 사람 u16][IV 12][암호문]  →  받을 때 [보낸 사람 u16][IV 12][암호문]
// 암호문을 풀면:   [종류 u8][번호 u32][내용]  (relay.js의 FRAME.FILE_HEAD 등)
import { toHex, fromHex, randomBytes } from './relay.js';

const subtle = () => globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const WRAP_INFO = new TextEncoder().encode('ssok-room-key-v1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wrapKeyFor(myPair, theirPublicHex, salt) {
  const theirs = await subtle().importKey('raw', fromHex(theirPublicHex), ECDH, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: theirs }, myPair.privateKey, 256);
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: WRAP_INFO }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function frame(type, id, payload) {
  const body = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload ? JSON.stringify(payload) : '');
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id);
  out.set(body, 5);
  return out;
}

/**
 * 방 하나에 들어간 이 기기.
 *   const peer = await RoomPeer.open(wsUrl, { create: true, device });  또는  { code: '123456', device }
 *   peer.onFrame = (from, type, id, payload) => …;  peer.onMembers = (members) => …;  peer.onClose = (reason) => …
 *   await peer.send(0, FRAME.TEXT, 1, { text });   // 0 = 모두, 아니면 그 기기 번호
 */
export class RoomPeer {
  /**
   * @param {string} url  wss://<중계 서버>/ws/room
   * @param {{create?: boolean, code?: string, device: string, headers?: object, WebSocketImpl?: any}} options
   */
  static async open(url, { create = false, code = '', device, headers, WebSocketImpl = globalThis.WebSocket }) {
    const peer = new RoomPeer();
    peer.device = device;
    peer.pair = await subtle().generateKey(ECDH, true, ['deriveBits']);
    peer.publicHex = toHex(new Uint8Array(await subtle().exportKey('raw', peer.pair.publicKey)));
    if (create) {
      // 방을 만든 기기가 방 열쇠를 만든다
      peer.roomKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      peer.roomKeyRaw = new Uint8Array(await subtle().exportKey('raw', peer.roomKey));
    }
    const ws = headers ? new WebSocketImpl(url, { headers }) : new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    peer.ws = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(Object.assign(new Error('방에 연결하지 못했어요'), { code: 'CONNECT' }));
    });
    ws.onmessage = (event) => {
      peer.inbox = peer.inbox.then(() => peer.receive(event.data)).catch((err) => peer.fail(err));
    };
    ws.onclose = (event) => peer.finish(event.reason || 'closed');
    ws.send(JSON.stringify(create ? { t: 'create', device, e: peer.publicHex } : { t: 'join', code, device, e: peer.publicHex }));
    await peer.joined;
    return peer;
  }

  constructor() {
    this.members = new Map(); // 번호 → { id, device, e }
    this.you = 0;
    this.code = '';
    this.inbox = Promise.resolve();
    this.outbox = Promise.resolve();
    this.closed = false;
    this.roomKey = null;
    this.onFrame = null;
    this.onMembers = null;
    this.onClose = null;
    this.joined = new Promise((resolve, reject) => {
      this.resolveJoined = resolve;
      this.rejectJoined = reject;
    });
    this.keyed = new Promise((resolve) => (this.resolveKeyed = resolve));
  }

  get ready() {
    return Boolean(this.roomKey);
  }

  async receive(data) {
    if (this.closed) return;
    if (typeof data === 'string') return this.receiveControl(JSON.parse(data));
    const bytes = new Uint8Array(data);
    if (bytes.length < 14 || !this.roomKey) return; // 방 열쇠를 받기 전의 메시지는 버린다 (보낸 쪽은 내가 들어오기 전에 보낸 것)
    const from = new DataView(bytes.buffer, bytes.byteOffset).getUint16(0);
    let plain;
    try {
      plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(2, 14) }, this.roomKey, bytes.subarray(14)));
    } catch {
      return; // 풀리지 않는 메시지는 무시한다
    }
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    this.onFrame?.(from, plain[0], view.getUint32(1), plain.subarray(5));
  }

  async receiveControl(msg) {
    if (msg.t === 'error') {
      const err = Object.assign(new Error(msg.message || '방에 들어가지 못했어요'), { code: String(msg.code || 'error') });
      this.rejectJoined(err);
      return;
    }
    if (msg.t === 'room' || msg.t === 'welcome') {
      this.you = msg.you;
      this.code = msg.code;
      this.url = msg.url;
      this.qrSvg = msg.qrSvg;
      for (const m of msg.members) this.members.set(m.id, m);
      if (this.roomKey) this.resolveKeyed();
      this.resolveJoined();
      this.onMembers?.(this.memberList());
      return;
    }
    if (msg.t === 'member-join') {
      this.members.set(msg.id, { id: msg.id, device: msg.device, e: msg.e });
      this.onMembers?.(this.memberList(), { joined: msg });
      // 방 열쇠를 가진 기기는 새 기기에게 건넨다 (여럿이 건네도 새 기기는 처음 것을 쓴다)
      if (this.roomKey && /^04[0-9a-f]{128}$/i.test(msg.e || '')) {
        try {
          const salt = randomBytes(16);
          const wrap = await wrapKeyFor(this.pair, msg.e, salt);
          const iv = randomBytes(12);
          const wrapped = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, wrap, this.roomKeyRaw));
          this.ws.send(JSON.stringify({ t: 'signal', to: msg.id, data: { k: toHex(wrapped), iv: toHex(iv), salt: toHex(salt) } }));
        } catch {
          // 공개 열쇠가 잘못된 기기에게는 건네지 않는다 (그 기기 하나 때문에 내 연결이 끊기지 않게)
        }
      }
      return;
    }
    if (msg.t === 'member-rename') {
      const member = this.members.get(msg.id);
      if (!member) return;
      const before = member.device;
      member.device = msg.device;
      this.onMembers?.(this.memberList(), { renamed: { id: msg.id, from: before, to: msg.device } });
      return;
    }
    if (msg.t === 'member-leave') {
      const left = this.members.get(msg.id);
      this.members.delete(msg.id);
      this.onMembers?.(this.memberList(), { left });
      return;
    }
    if (msg.t === 'signal' && !this.roomKey && msg.data?.k) {
      const sender = this.members.get(msg.from);
      if (!sender?.e) return;
      try {
        const wrap = await wrapKeyFor(this.pair, sender.e, fromHex(msg.data.salt));
        this.roomKeyRaw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromHex(msg.data.iv) }, wrap, fromHex(msg.data.k)));
        this.roomKey = await subtle().importKey('raw', this.roomKeyRaw, 'AES-GCM', true, ['encrypt', 'decrypt']);
        this.resolveKeyed();
        this.onMembers?.(this.memberList());
      } catch {
        // 풀리지 않으면 다른 기기가 건넨 것을 기다린다
      }
    }
  }

  /** 방에서 보일 내 이름을 바꾼다 (다른 기기에도 바로 알린다) */
  rename(device) {
    const name = String(device || '').trim().slice(0, 40);
    if (!name || this.closed) return;
    this.device = name;
    const me = this.members.get(this.you);
    if (me) me.device = name;
    this.ws.send(JSON.stringify({ t: 'rename', device: name }));
    this.onMembers?.(this.memberList());
  }

  /** '모두'(0)에게 보낼 때 뺄 기기들 (빈 목록이면 다시 모두). 앞뒤 메시지와 순서가 섞이지 않게 같은 줄에 선다. */
  skip(ids) {
    const run = async () => {
      if (!this.closed) this.ws.send(JSON.stringify({ t: 'skip', ids: [...ids] }));
    };
    this.outbox = this.outbox.then(run, run);
    return this.outbox;
  }

  memberList() {
    return [...this.members.values()].sort((a, b) => a.id - b.id).map((m) => ({ id: m.id, device: m.device, me: m.id === this.you }));
  }

  /** 암호화해서 보낸다. to: 0이면 나를 뺀 모두, 아니면 그 기기. 순서를 지키려고 차례대로 보낸다. */
  send(to, type, id, payload) {
    const run = async () => {
      if (this.closed) throw new Error('방이 닫혔어요');
      await this.keyed;
      const iv = randomBytes(12);
      const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, this.roomKey, frame(type, id, payload)));
      const out = new Uint8Array(14 + sealed.length);
      new DataView(out.buffer).setUint16(0, to);
      out.set(iv, 2);
      out.set(sealed, 14);
      this.ws.send(out);
    };
    this.outbox = this.outbox.then(run, run);
    return this.outbox;
  }

  /** 아직 내보내지 못한 양이 많으면 기다린다 (큰 파일을 보낼 때) */
  async drain(limit = 1024 * 1024) {
    while (!this.closed && this.ws.bufferedAmount > limit) await sleep(15);
  }

  fail(err) {
    this.rejectJoined(err);
    this.close();
  }

  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    this.rejectJoined(Object.assign(new Error('연결이 끊겼어요'), { code: 'CLOSED' }));
    this.onClose?.(reason);
  }

  close() {
    try {
      this.ws.close(1000);
    } catch {
      // 이미 닫힘
    }
    this.finish('left');
  }
}
