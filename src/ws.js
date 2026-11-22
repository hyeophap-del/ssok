// 아주 작은 웹소켓 서버 구현 (RFC 6455). 중계 서버에서만 쓴다.
// 클라이언트 쪽은 Node·브라우저에 들어 있는 WebSocket을 쓴다.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024; // 한 메시지 최대 크기 (쏙은 64KB 조각으로 보낸다)

/**
 * HTTP 'upgrade' 요청을 웹소켓으로 바꾼다. 웹소켓 요청이 아니면 null (소켓은 400으로 닫는다).
 * @returns {WsConnection | null}
 */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const isWs = /websocket/i.test(req.headers.upgrade || '') && key && req.headers['sec-websocket-version'] === '13';
  if (!isWs) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsConnection(socket, head);
}

export class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentType = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('drain', () => this.emit('drain'));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (this.buffer.length) queueMicrotask(() => this.onData(Buffer.alloc(0)));
  }

  onData(chunk) {
    if (this.closed) return; // 닫은 뒤에 오는 것은 모으지 않는다 (상대가 닫기에 답하지 않고 계속 보내도 메모리가 늘지 않게)
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      const frame = this.readFrame();
      if (!frame) return;
      this.handleFrame(frame);
    }
  }

  /** 버퍼에서 프레임 하나를 꺼낸다. 아직 덜 왔으면 null. */
  readFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      const high = b.readUInt32BE(2);
      length = high * 2 ** 32 + b.readUInt32BE(6);
      offset = 10;
    }
    if (length > MAX_MESSAGE) {
      this.close(1009, 'too big');
      return null;
    }
    if (!masked) {
      // 클라이언트가 보내는 프레임은 반드시 가려져(masked) 있어야 한다
      this.close(1002, 'unmasked');
      return null;
    }
    if (b.length < offset + 4 + length) return null;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = b.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    // 제어 프레임(닫기·ping·pong)은 125바이트 이하, 나뉘지 않은 것만 (RFC 6455 5.5)
    if (opcode >= 0x8 && (payload.length > 125 || !fin)) return this.close(1002, 'bad control frame');
    if (opcode === 0x8) {
      // 닫기: 받은 코드로 답하고 끝낸다
      this.sendFrame(0x8, payload.subarray(0, 2));
      this.socket.end();
      setTimeout(() => this.socket.destroy(), 2000).unref();
      return this.finish();
    }
    if (opcode === 0x9) {
      // ping → pong. 상대가 받아 가지 않아 내보낼 것이 쌓여 있으면 답하지 않는다 (메모리가 늘지 않게)
      if (this.socket.writableLength < 1024 * 1024) this.sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return this.emit('pong');
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragments.length) return this.close(1002, 'unexpected frame');
      if (fin) return this.deliver(payload, opcode === 0x2);
      this.fragmentType = opcode;
      this.fragments = [payload];
      return;
    }
    if (opcode === 0x0) {
      if (!this.fragments.length) return this.close(1002, 'unexpected continuation');
      this.fragments.push(payload);
      const total = this.fragments.reduce((n, f) => n + f.length, 0);
      if (total > MAX_MESSAGE) return this.close(1009, 'too big');
      if (fin) {
        const message = Buffer.concat(this.fragments);
        const binary = this.fragmentType === 0x2;
        this.fragments = [];
        this.deliver(message, binary);
      }
      return;
    }
    this.close(1002, 'bad opcode');
  }

  /** 받은 메시지를 넘긴다. 처리하다 오류가 나도 서버 전체가 죽지 않고 이 연결만 닫는다. */
  deliver(message, binary) {
    try {
      this.emit('message', message, binary);
    } catch (err) {
      console.error('웹소켓 메시지 처리 중 오류', err);
      this.close(1011, 'error');
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length >>> 0, 6);
    }
    this.socket.write(header);
    return this.socket.write(payload);
  }

  /** 메시지 보내기. 내보낼 버퍼가 가득 차면 false ('drain'을 기다릴 것) */
  send(data) {
    if (typeof data === 'string') return this.sendFrame(0x1, Buffer.from(data, 'utf8'));
    return this.sendFrame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  ping() {
    return this.sendFrame(0x9, Buffer.alloc(0));
  }

  pause() {
    this.socket.pause();
  }

  resume() {
    this.socket.resume();
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.sendFrame(0x8, payload);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
