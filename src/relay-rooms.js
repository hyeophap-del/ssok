// 홈페이지에서 바로 주고받기 (중계 서버의 첫 화면):
// 설치 없이 두 브라우저가 홈페이지에 들어와, 한쪽이 만든 6자리 방 코드를 다른 쪽이 넣으면 둘을 잇는다.
//   - 홈페이지를 쓰려면 중계 서버 주인이 정한 숫자 4자리 암호가 필요하다 (맞히면 그 브라우저는 30일 동안 기억)
//   - 이은 뒤에는 두 브라우저가 그 자리에서 만든 열쇠(ECDH)로 종단간 암호화한다 (public/relay.js). 이 서버는 바이트만 넘긴다.
import crypto from 'node:crypto';
import { acceptWebSocket } from './ws.js';
import { sendJson, sendEmpty, readJson } from './http.js';
import { encodeQR, toSvg } from './qr.js';

export const WEB_PIN = /^\d{4}$/;
const COOKIE = 'ssok_web';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ROOM_MS = 10 * 60_000; // 방 코드를 만들고 상대가 들어오기를 기다리는 시간
const MAX_ROOMS = 200;
const MAX_ROOMS_PER_ADDRESS = 5;
const MAX_WRONG = 10; // 암호·방 코드를 이만큼 틀리면 그 주소는 잠시 막는다
const WRONG_WINDOW_MS = 10 * 60_000;
const MAX_WRONG_ALL = 300; // 여러 주소에서 몰려와도: 10분 동안 전체로 이만큼 틀리면 잠시 모두 막는다

/** 웹소켓 업그레이드 요청에 HTTP로 거절한다 */
function refuseUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/**
 * @param {object} options
 * @param {object} options.state       중계 서버의 저장 자료 (여기에 web을 둔다)
 * @param {() => void} options.save
 * @param {(req) => string} options.clientAddress
 * @param {(type: string, payload?: any) => void} [options.log]
 */
export function createRoomService({ state, save, clientAddress, log = () => {} }) {
  state.web ??= { pin: null, version: 1, bytes: 0 };
  state.web.key ??= crypto.randomBytes(32).toString('hex'); // 브라우저에 주는 입장권의 서명 열쇠

  const rooms = new Map(); // 방 코드 → { host, device, address, timer }
  const live = new Set();
  const wrong = new Map(); // 주소 → { count, since }
  let wrongAll = { count: 0, since: Date.now() };

  const enabled = () => WEB_PIN.test(state.web.pin || '');

  // ---- 틀린 횟수 ----
  function blocked(address) {
    if (Date.now() - wrongAll.since > WRONG_WINDOW_MS) wrongAll = { count: 0, since: Date.now() };
    if (wrongAll.count >= MAX_WRONG_ALL) return true;
    const entry = wrong.get(address);
    if (entry && Date.now() - entry.since > WRONG_WINDOW_MS) wrong.delete(address);
    return (wrong.get(address)?.count ?? 0) >= MAX_WRONG;
  }
  function countWrong(address) {
    wrongAll.count++;
    const entry = wrong.get(address);
    if (entry) entry.count++;
    else wrong.set(address, { count: 1, since: Date.now() });
    if (wrong.size > 10_000) wrong.clear();
  }

  // ---- 입장권 (쿠키) ----
  const sign = (text) => crypto.createHmac('sha256', state.web.key).update(text).digest('base64url');
  function makeTicket() {
    const body = `${state.web.version}.${Date.now() + SESSION_MS}`;
    return `${body}.${sign(body)}`;
  }
  function hasTicket(req) {
    if (!enabled()) return false;
    const ticket = parseCookies(req.headers.cookie)[COOKIE] ?? '';
    const [version, expires, signature] = ticket.split('.');
    if (Number(version) !== state.web.version || !(Number(expires) > Date.now()) || !signature) return false;
    const expected = sign(`${version}.${expires}`);
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
  /** https로 들어왔으면 Secure 쿠키 (Cloudflare 터널 뒤에서는 이 헤더로 알 수 있다) */
  const viaHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''));
  const cookie = (req, value, maxAge) =>
    `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${viaHttps(req) ? '; Secure' : ''}`;

  // ---- HTTP ----
  async function handleHttp(req, res, url) {
    if (url.pathname === '/api/web/status' && req.method === 'GET') {
      return sendJson(res, 200, { enabled: enabled(), authed: hasTicket(req) }), true;
    }
    if (url.pathname === '/api/web/login' && req.method === 'POST') {
      const address = clientAddress(req);
      if (!enabled()) return sendJson(res, 404, { error: '이 중계 서버는 홈페이지 주고받기를 켜지 않았어요.' }), true;
      if (blocked(address)) return sendJson(res, 429, { error: '암호를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.' }), true;
      let body;
      try {
        body = (await readJson(req, 1024)) ?? {};
      } catch {
        return sendJson(res, 413, { error: '잘못된 요청이에요.' }), true;
      }
      const given = Buffer.from(String(body.pin ?? ''));
      const expected = Buffer.from(state.web.pin);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        countWrong(address);
        return sendJson(res, 401, { error: '암호가 맞지 않아요.' }), true;
      }
      res.setHeader('Set-Cookie', cookie(req, makeTicket(), Math.floor(SESSION_MS / 1000)));
      return sendEmpty(res), true;
    }
    if (url.pathname === '/api/web/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      return sendEmpty(res), true;
    }
    return false;
  }

  // ---- 방 ----
  function newCode() {
    for (;;) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      if (!rooms.has(code)) return code;
    }
  }

  function handleUpgrade(req, socket, head) {
    if (!enabled()) return refuseUpgrade(socket, 404, 'Not Found');
    if (!hasTicket(req)) return refuseUpgrade(socket, 401, 'Unauthorized');
    const address = clientAddress(req);
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '');
    const origin = `${viaHttps(req) || !/^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? 'https' : 'http'}://${host}`;
    const timer = setTimeout(() => ws.close(4008, 'timeout'), 10_000);
    ws.once('message', (data, binary) => {
      clearTimeout(timer);
      let msg = null;
      try {
        msg = binary ? null : JSON.parse(data.toString('utf8'));
      } catch {
        msg = null;
      }
      const device = String(msg?.device || '기기').slice(0, 40);
      if (msg?.t === 'create') return create(ws, address, device, origin);
      if (msg?.t === 'join') return join(ws, address, device, String(msg.code || ''));
      ws.close(4002, 'bad message');
    });
  }

  function create(ws, address, device, origin) {
    const mine = [...rooms.values()].filter((r) => r.address === address).length;
    if (rooms.size >= MAX_ROOMS || mine >= MAX_ROOMS_PER_ADDRESS) {
      ws.sendJson({ t: 'error', code: 'busy', message: '지금은 방을 더 만들 수 없어요. 잠시 뒤 다시 해 주세요.' });
      return ws.close(4003, 'busy');
    }
    const code = newCode();
    const room = { host: ws, device, address };
    room.timer = setTimeout(() => {
      if (rooms.get(code) !== room) return;
      rooms.delete(code);
      ws.sendJson({ t: 'error', code: 'expired', message: '10분 동안 아무도 들어오지 않아 방을 닫았어요.' });
      ws.close(4008, 'expired');
    }, ROOM_MS);
    room.timer.unref?.();
    rooms.set(code, room);
    ws.on('close', () => {
      if (rooms.get(code) === room) {
        clearTimeout(room.timer);
        rooms.delete(code);
      }
    });
    const joinUrl = `${origin}/#${code}`;
    ws.sendJson({ t: 'room', code, expires: Date.now() + ROOM_MS, url: joinUrl, qrSvg: toSvg(encodeQR(joinUrl, { ecl: 'M' })) });
  }

  function join(ws, address, device, code) {
    if (blocked(address)) {
      ws.sendJson({ t: 'error', code: 'too-many', message: '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.' });
      return ws.close(4003, 'too many');
    }
    const room = /^\d{6}$/.test(code) ? rooms.get(code) : null;
    if (!room) {
      countWrong(address);
      ws.sendJson({ t: 'error', code: 'no-room', message: '그 코드의 방이 없어요. 숫자를 확인하거나 상대에게 새 코드를 받아 주세요.' });
      return ws.close(4004, 'no room');
    }
    clearTimeout(room.timer);
    rooms.delete(code); // 한 방에는 두 사람만
    room.host.sendJson({ t: 'joined', peer: device });
    ws.sendJson({ t: 'joined', peer: room.device });
    pipe(room.host, ws);
    log('room', `홈페이지 방 연결: ${room.device} ↔ ${device}`);
  }

  /** 두 브라우저를 잇는다. 받는 쪽이 느리면 보내는 쪽을 잠깐 멈춘다 (이 서버 메모리에 쌓이지 않게). */
  function pipe(a, b) {
    live.add(a).add(b);
    let unsaved = 0;
    const forward = (from, to) => {
      from.on('message', (data, binary) => {
        state.web.bytes = (state.web.bytes || 0) + data.length;
        unsaved += data.length;
        if (unsaved > 8 * 1024 * 1024) {
          unsaved = 0;
          save();
        }
        if (!to.send(binary ? data : data.toString('utf8'))) {
          from.pause();
          to.once('drain', () => from.resume());
        }
      });
      from.on('close', () => {
        live.delete(from);
        to.close(1000, 'peer closed');
        save();
      });
    };
    forward(a, b);
    forward(b, a);
  }

  return {
    handleHttp,
    handleUpgrade,
    /** 홈페이지 암호를 정한다 (숫자 4자리, null이면 끈다). 바꾸면 그전에 들어온 브라우저는 다시 넣어야 한다. */
    setPin(pin) {
      if (pin !== null && !WEB_PIN.test(String(pin))) throw Object.assign(new Error('암호는 숫자 4자리로 정해 주세요.'), { status: 400 });
      state.web.pin = pin === null ? null : String(pin);
      state.web.version += 1;
      save();
      if (pin === null) for (const room of rooms.values()) room.host.close(4003, 'web off');
    },
    overview: () => ({ enabled: enabled(), pin: state.web.pin, bytes: state.web.bytes || 0, rooms: rooms.size, connected: live.size / 2 }),
    /** 지금 주고받는 중인 방이 있는지 (업데이트를 미룰지 정할 때) */
    active: () => live.size,
    close() {
      for (const room of rooms.values()) room.host.close(1001, 'server closing');
      for (const ws of live) ws.close(1001, 'server closing');
    },
  };
}
