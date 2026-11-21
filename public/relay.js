// 중계 서버를 거쳐 휴대폰 ↔ PC가 '종단간 암호화'로 주고받는 통신.
// 휴대폰 브라우저와 PC(Node) 양쪽에서 이 파일 하나를 같이 써서 형식이 어긋나지 않게 한다.
//
// 1. 휴대폰과 PC가 서로 난수를 하나씩 보낸다 (평문 'hello').
// 2. QR에 들어 있던 비밀 열쇠와 두 난수로 방향별 AES-GCM 열쇠를 만든다 (HKDF-SHA256).
//    비밀 열쇠는 QR 주소의 # 뒤에만 있어서 중계 서버로는 절대 가지 않는다.
// 3. 그 뒤로는 모든 메시지를 암호화한다. 메시지마다 번호(카운터)를 붙여 순서를 바꾸거나 되풀이해도 풀리지 않는다.
//    중계 서버는 알아볼 수 없는 바이트만 전달한다.
// 4. 암호화된 통로 위로 HTTP 요청·응답을 흘려보낸다 (PC의 쏙 서버가 그대로 처리한다).

export const FRAME = {
  REQ_HEAD: 1, // 휴대폰 → PC: { method, path, headers }
  REQ_DATA: 2, // 요청 본문 조각
  REQ_END: 3,
  RES_HEAD: 4, // PC → 휴대폰: { status, headers }
  RES_DATA: 5,
  RES_END: 6,
  CANCEL: 7, // 어느 쪽이든: 그 요청을 그만둔다
  AUTH: 8, // 휴대폰 → PC: 첫 암호 메시지 (열쇠가 맞는지 확인)
  AUTH_OK: 9,
  // 그대로 통과시키는 연결 (다른 곳의 PC와 처음 연결할 때: 이 안으로 PC의 HTTPS를 그대로 흘려보낸다)
  RAW_OPEN: 10,
  RAW_DATA: 11,
  RAW_END: 12,
};

export const CHUNK = 64 * 1024;
const INFO = new TextEncoder().encode('ssok-relay-v1');
const subtle = () => globalThis.crypto.subtle;

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export function fromHex(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex || '')) throw new Error('bad hex');
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** 비밀 열쇠와 두 난수로 방향별 열쇠를 만든다 */
export async function deriveKeys(secret, phoneNonce, pcNonce) {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const salt = new Uint8Array([...phoneNonce, ...pcNonce]);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, base, 512));
  const importAes = (raw) => subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { phoneToPc: await importAes(bits.slice(0, 32)), pcToPhone: await importAes(bits.slice(32)) };
}

function iv(counter) {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, counter);
  return out;
}

function frame(type, id, payload) {
  const body = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload ? JSON.stringify(payload) : '');
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id);
  out.set(body, 5);
  return out;
}

const textOf = (data) => (typeof data === 'string' ? data : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 웹소켓 위의 암호화된 통로. role은 'phone' 또는 'pc'.
 * onFrame(type, id, payload: Uint8Array)로 받은 메시지를 넘겨준다.
 */
export class SecureSocket {
  constructor(ws, { role, secret, onFrame, onClose }) {
    this.ws = ws;
    this.role = role;
    this.secret = secret;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.sendCounter = 0n;
    this.recvCounter = 0n;
    this.sendChain = Promise.resolve();
    this.recvChain = Promise.resolve();
    this.keys = null;
    this.closed = false;
    ws.binaryType = 'arraybuffer';
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    ws.onmessage = (event) => {
      this.recvChain = this.recvChain.then(() => this.receive(event.data)).catch((err) => this.fail(err));
    };
    ws.onclose = (event) => this.shutdown(event?.code, event?.reason);
    ws.onerror = () => {};
  }

  /** 휴대폰 쪽: 인사를 먼저 보낸다 */
  async start(extra = {}) {
    this.extra = extra;
    this.myNonce = randomBytes(16);
    this.ws.send(JSON.stringify({ t: 'hello', v: 1, n: toHex(this.myNonce), ...extra }));
    return this.ready;
  }

  async receive(data) {
    if (this.closed) return;
    const text = textOf(data);
    if (text !== null) return this.receiveText(text);
    if (!this.keys) throw new Error('인사 전에 암호 메시지가 왔어요');
    const key = this.role === 'pc' ? this.keys.phoneToPc : this.keys.pcToPhone;
    let plain;
    try {
      plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv(this.recvCounter) }, key, data));
    } catch {
      throw Object.assign(new Error('암호를 풀지 못했어요 (열쇠가 다르거나 메시지가 바뀌었어요)'), { code: 'BAD_KEY' });
    }
    this.recvCounter++;
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const type = plain[0];
    const id = view.getUint32(1);
    const payload = plain.subarray(5);
    if (type === FRAME.AUTH && this.role === 'pc') {
      this.peerInfo = JSON.parse(new TextDecoder().decode(payload) || '{}');
      await this.send(FRAME.AUTH_OK, 0, {});
      this.resolveReady(this.peerInfo);
      return;
    }
    if (type === FRAME.AUTH_OK && this.role === 'phone') {
      this.resolveReady();
      return;
    }
    this.onFrame?.(type, id, payload);
  }

  async receiveText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'error') {
      // 중계 서버가 알려 준 이유 (pc-offline → PC_OFFLINE)
      throw Object.assign(new Error(msg.message || '연결하지 못했어요'), { code: String(msg.code || 'ERROR').toUpperCase().replace(/-/g, '_') });
    }
    if (msg.t !== 'hello' || this.keys) return;
    const theirNonce = fromHex(msg.n);
    if (theirNonce.length !== 16) throw new Error('잘못된 인사');
    if (this.role === 'pc') {
      // 휴대폰은 QR의 비밀 열쇠를, 연결된 다른 PC는 자기 번호(kid)를 밝히고 그 PC와 나눠 가진 열쇠를 쓴다
      const secret = typeof this.secret === 'function' ? this.secret(msg) : this.secret;
      if (!secret) {
        try {
          this.ws.send(JSON.stringify({ t: 'error', code: 'unknown-peer', message: '이 PC와 연결이 해제됐어요. 다시 연결해 주세요.' }));
        } catch {
          // 이미 닫힘
        }
        throw Object.assign(new Error('모르는 기기예요'), { code: 'UNKNOWN_PEER' });
      }
      this.myNonce = randomBytes(16);
      this.ws.send(JSON.stringify({ t: 'hello', v: 1, n: toHex(this.myNonce) }));
      this.keys = await deriveKeys(secret, theirNonce, this.myNonce);
      this.hello = msg;
    } else {
      this.keys = await deriveKeys(this.secret, this.myNonce, theirNonce);
      await this.send(FRAME.AUTH, 0, this.extra || {});
    }
  }

  /** 암호화해서 보낸다. 보내는 순서와 번호를 지키려고 차례대로 처리한다. */
  send(type, id, payload) {
    const run = async () => {
      if (this.closed) throw new Error('연결이 끊겼어요');
      const key = this.role === 'pc' ? this.keys.pcToPhone : this.keys.phoneToPc;
      const counter = this.sendCounter++;
      const data = await subtle().encrypt({ name: 'AES-GCM', iv: iv(counter) }, key, frame(type, id, payload));
      this.ws.send(data);
    };
    this.sendChain = this.sendChain.then(run, run);
    return this.sendChain;
  }

  /** 아직 내보내지 못한 양이 많으면 기다린다 (큰 파일을 보낼 때 메모리가 넘치지 않게) */
  async drain(limit = 1024 * 1024) {
    while (!this.closed && this.ws.bufferedAmount > limit) await sleep(15);
  }

  fail(err) {
    if (this.closed) return;
    this.rejectReady(err);
    // 열쇠가 다르면 휴대폰에 알려 준다 (휴대폰은 QR을 다시 스캔해야 한다)
    if (this.role === 'pc' && err?.code === 'BAD_KEY') {
      try {
        this.ws.send(JSON.stringify({ t: 'error', code: 'bad-key', message: 'PC의 연결 정보가 바뀌었어요. PC 화면의 [어디서나] QR을 다시 스캔해 주세요.' }));
      } catch {
        // 이미 닫힘
      }
    }
    this.shutdown(4000, err.message, err);
    try {
      this.ws.close(4000, 'error');
    } catch {
      // 이미 닫힘
    }
  }

  shutdown(code, reason, err) {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady(err || Object.assign(new Error(reason || '연결이 끊겼어요'), { code: code === 4004 ? 'PC_OFFLINE' : 'CLOSED' }));
    this.onClose?.(err);
  }

  close() {
    try {
      this.ws.close(1000);
    } catch {
      // 이미 닫힘
    }
    this.shutdown(1000, 'closed');
  }
}

/**
 * 휴대폰 쪽: 중계 서버를 거쳐 PC의 쏙에 HTTP 요청을 보낸다.
 *   const pc = await RelayClient.connect('wss://ssok.example.com/ws/c/<PC 번호>', 비밀열쇠);
 *   const res = await pc.request('GET', '/api/session');  →  { status, headers, json(), text(), blob() }
 */
export class RelayClient {
  static async connect(url, secret, { WebSocketImpl = globalThis.WebSocket, device = '', kid = null, onClose } = {}) {
    const ws = new WebSocketImpl(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('중계 서버에 연결하지 못했어요'));
      ws.onclose = (e) => reject(Object.assign(new Error('중계 서버에 연결하지 못했어요'), { code: e.code === 4004 ? 'PC_OFFLINE' : 'CLOSED' }));
    });
    const client = new RelayClient();
    client.socket = new SecureSocket(ws, {
      role: 'phone',
      secret,
      onFrame: (type, id, payload) => client.onFrame(type, id, payload),
      onClose: (err) => {
        for (const stream of client.streams.values()) stream.fail(err || new Error('연결이 끊겼어요'));
        client.streams.clear();
        for (const raw of client.raws.values()) raw.onClose?.(err || new Error('연결이 끊겼어요'));
        client.raws.clear();
        client.closed = true;
        onClose?.(err);
      },
    });
    await client.socket.start({ device, ...(kid ? { kid } : {}) }); // kid: 연결된 다른 PC가 보낼 때 자기 번호
    return client;
  }

  constructor() {
    this.streams = new Map();
    this.raws = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  /**
   * 그대로 통과시키는 연결을 연다. PC 쪽은 이 바이트를 자기 쏙 서버 포트로 그대로 넘긴다.
   * @returns {{ write(bytes: Uint8Array): Promise<void>, end(): void, abort(): void }}
   */
  openRaw({ onData, onEnd, onClose }) {
    if (this.closed) throw new Error('연결이 끊겼어요');
    const id = this.nextId;
    this.nextId += 2;
    this.raws.set(id, { onData, onEnd, onClose });
    this.socket.send(FRAME.RAW_OPEN, id, {}).catch(() => {});
    return {
      write: async (bytes) => {
        for (let at = 0; at < bytes.length; at += CHUNK) await this.socket.send(FRAME.RAW_DATA, id, bytes.subarray(at, at + CHUNK));
        await this.socket.drain();
      },
      end: () => this.socket.send(FRAME.RAW_END, id, {}).catch(() => {}),
      abort: () => {
        if (this.raws.delete(id)) this.socket.send(FRAME.CANCEL, id, {}).catch(() => {});
      },
    };
  }

  onFrame(type, id, payload) {
    const raw = this.raws.get(id);
    if (raw) {
      if (type === FRAME.RAW_DATA) raw.onData?.(payload.slice());
      else if (type === FRAME.RAW_END) raw.onEnd?.();
      else if (type === FRAME.CANCEL) {
        this.raws.delete(id);
        raw.onClose?.(new Error('PC가 연결을 끊었어요'));
      }
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    if (type === FRAME.RES_HEAD) stream.head(JSON.parse(new TextDecoder().decode(payload)));
    else if (type === FRAME.RES_DATA) stream.data(payload);
    else if (type === FRAME.RES_END) {
      this.streams.delete(id);
      stream.end();
    } else if (type === FRAME.CANCEL) {
      this.streams.delete(id);
      stream.fail(new Error('PC가 요청을 끝냈어요'));
    }
  }

  /**
   * @param {object} [options]
   * @param {Record<string,string>} [options.headers]
   * @param {Blob|Uint8Array|string|AsyncIterable<Uint8Array>|null} [options.body]  흘려보내는 본문(AsyncIterable)이면 headers에 content-length를 넣어야 한다
   * @param {(sent: number) => void} [options.onUploadProgress]
   * @param {(chunk: Uint8Array) => void} [options.onChunk]  있으면 응답을 모으지 않고 조각마다 넘긴다 (실시간 알림용)
   * @param {AbortSignal} [options.signal]
   */
  async request(method, path, { headers = {}, body = null, onUploadProgress, onChunk, signal } = {}) {
    if (this.closed) throw new Error('연결이 끊겼어요');
    const id = this.nextId;
    this.nextId += 2;
    const stream = createStream(onChunk);
    this.streams.set(id, stream);
    const cancel = () => {
      if (!this.streams.has(id)) return;
      this.streams.delete(id);
      this.socket.send(FRAME.CANCEL, id, {}).catch(() => {});
      stream.fail(new DOMException('취소됨', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });

    // 흘려보내는 본문 (Node의 요청 스트림 등): 받는 대로 조각내 보낸다
    const streaming = body !== null && typeof body === 'object' && !(body instanceof Uint8Array) && typeof body.arrayBuffer !== 'function' && typeof body[Symbol.asyncIterator] === 'function';
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : streaming ? null : body;
    const size = bytes ? (bytes.size ?? bytes.byteLength) : 0;
    const allHeaders = { ...headers };
    if (bytes) allHeaders['content-length'] = String(size);
    await this.socket.send(FRAME.REQ_HEAD, id, { method, path, headers: allHeaders });
    try {
      if (streaming) {
        let sent = 0;
        // for await를 쓰지 않는다: 중간에 멈출 때 본문 스트림을 없애 버리면, 보낸 쪽에 거절 이유를 답할 수 없다
        const chunks = body[Symbol.asyncIterator]();
        for (;;) {
          const { value: chunk, done } = await chunks.next();
          if (done || !this.streams.has(id)) break;
          for (let at = 0; at < chunk.length; at += CHUNK) {
            const data = chunk.subarray(at, at + CHUNK);
            await this.socket.send(FRAME.REQ_DATA, id, data);
            await this.socket.drain();
            sent += data.length;
            onUploadProgress?.(sent);
          }
        }
      } else if (bytes) {
        for (let offset = 0; offset < size; offset += CHUNK) {
          if (!this.streams.has(id)) break;
          const piece = bytes.slice(offset, Math.min(size, offset + CHUNK));
          const data = piece instanceof Uint8Array ? piece : new Uint8Array(await piece.arrayBuffer());
          await this.socket.send(FRAME.REQ_DATA, id, data);
          await this.socket.drain();
          onUploadProgress?.(Math.min(size, offset + data.length));
        }
      }
    } catch (err) {
      cancel(); // 보내던 본문이 끊겼다 (보내는 쪽에서 취소 등): 받는 쪽도 그만두게 한다
      throw err;
    }
    if (this.streams.has(id)) await this.socket.send(FRAME.REQ_END, id, {});
    return stream.response;
  }

  close() {
    this.socket.close();
  }
}

function createStream(onChunk) {
  const chunks = [];
  let resolveHead;
  let rejectHead;
  let resolveEnd;
  let rejectEnd;
  const ended = new Promise((resolve, reject) => {
    resolveEnd = resolve;
    rejectEnd = reject;
  });
  ended.catch(() => {});
  const response = new Promise((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });
  const body = async () => {
    await ended;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  return {
    response,
    head({ status, headers }) {
      resolveHead({
        status,
        ok: status >= 200 && status < 300,
        headers,
        done: ended,
        bytes: body,
        text: async () => new TextDecoder().decode(await body()),
        json: async () => JSON.parse(new TextDecoder().decode(await body())),
        blob: async (type) => new Blob([await body()], { type: type || headers['content-type'] || '' }),
      });
    },
    data(payload) {
      if (onChunk) onChunk(payload.slice());
      else chunks.push(payload.slice());
    },
    end: () => resolveEnd(),
    fail(err) {
      rejectHead(err);
      rejectEnd(err);
    },
  };
}
