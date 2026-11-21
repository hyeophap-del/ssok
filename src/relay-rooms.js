// 홈페이지에서 바로 주고받기 (중계 서버의 첫 화면):
// 설치 없이 여러 브라우저(최대 10대)가 홈페이지에 들어와, 한 기기가 만든 6자리 방 코드로 같은 방에 모인다.
//   - 홈페이지를 쓰려면 중계 서버 주인이 정한 숫자 4자리 암호가 필요하다 (맞히면 그 브라우저는 30일 동안 기억)
//   - 방 안의 메시지는 '방 열쇠'로 종단간 암호화한다 (public/room-core.js). 이 서버는 받는 사람에게 나눠 주기만 한다.
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
const MAX_MEMBERS = 10; // 한 방에 들어올 수 있는 기기 수
const PING_MS = 20_000; // 기기마다 이 간격으로 신호를 보낸다
const SILENT_MS = 50_000; // 이만큼 아무 답이 없으면 끊긴 기기로 보고 내보낸다 (잠든 휴대폰, 닫힌 창 등)
const STALL_MS = 30_000; // 한 기기에 보낼 것이 이만큼 밀려 있으면 그 기기를 내보낸다 (방 전체가 멈추지 않게)
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
 * @param {{pingMs?: number, silentMs?: number, stallMs?: number}} [options.timing]  시험에서 짧게 줄일 때
 */
export function createRoomService({ state, save, clientAddress, log = () => {}, timing = {} }) {
  const { pingMs = PING_MS, silentMs = SILENT_MS, stallMs = STALL_MS } = timing;
  state.web ??= { pin: null, version: 1, bytes: 0 };
  state.web.key ??= crypto.randomBytes(32).toString('hex'); // 브라우저에 주는 입장권의 서명 열쇠

  const rooms = new Map(); // 방 코드 → { code, address, members: 번호 → { id, ws, device, e }, nextId, timer }
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
      // 그 기기의 ECDH 공개 열쇠: 방 열쇠를 건네받을 때 쓴다 (중계 서버는 그대로 전하기만 한다)
      const e = /^04[0-9a-f]{128}$/i.test(String(msg?.e || '')) ? String(msg.e) : '';
      if (!e) return ws.close(4002, 'bad message');
      if (msg?.t === 'create') return create(ws, address, device, e, origin);
      if (msg?.t === 'join') return join(ws, address, device, e, String(msg.code || ''), origin);
      ws.close(4002, 'bad message');
    });
  }

  const memberList = (room) => [...room.members.values()].map(({ id, device, e }) => ({ id, device, e }));
  const joinUrlOf = (origin, code) => `${origin}/#${code}`;

  function create(ws, address, device, e, origin) {
    const mine = [...rooms.values()].filter((r) => r.address === address).length;
    if (rooms.size >= MAX_ROOMS || mine >= MAX_ROOMS_PER_ADDRESS) {
      ws.sendJson({ t: 'error', code: 'busy', message: '지금은 방을 더 만들 수 없어요. 잠시 뒤 다시 해 주세요.' });
      return ws.close(4003, 'busy');
    }
    const code = newCode();
    const room = { code, address, members: new Map(), nextId: 1, everJoined: false };
    // 10분 동안 아무도 들어오지 않으면 닫는다 (한 번이라도 들어왔으면 모두 나갈 때까지 연다)
    room.timer = setTimeout(() => {
      if (rooms.get(code) !== room || room.everJoined) return;
      for (const m of room.members.values()) {
        m.ws.sendJson({ t: 'error', code: 'expired', message: '10분 동안 아무도 들어오지 않아 방을 닫았어요.' });
        m.ws.close(4008, 'expired');
      }
    }, ROOM_MS);
    room.timer.unref?.();
    rooms.set(code, room);
    const me = addMember(room, ws, device, e);
    const url = joinUrlOf(origin, code);
    ws.sendJson({ t: 'room', code, you: me.id, url, qrSvg: toSvg(encodeQR(url, { ecl: 'M' })), members: memberList(room) });
  }

  function join(ws, address, device, e, code, origin) {
    if (blocked(address)) {
      ws.sendJson({ t: 'error', code: 'too-many', message: '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.' });
      return ws.close(4003, 'too many');
    }
    const room = /^\d{6}$/.test(code) ? rooms.get(code) : null;
    if (!room) {
      countWrong(address);
      ws.sendJson({ t: 'error', code: 'no-room', message: '그 코드의 방이 없어요. 숫자를 확인하거나 방을 만든 사람에게 새 코드를 받아 주세요.' });
      return ws.close(4004, 'no room');
    }
    if (room.members.size >= MAX_MEMBERS) {
      ws.sendJson({ t: 'error', code: 'full', message: `한 방에는 ${MAX_MEMBERS}대까지 들어올 수 있어요.` });
      return ws.close(4003, 'full');
    }
    room.everJoined = true;
    const me = addMember(room, ws, device, e);
    for (const m of room.members.values()) if (m !== me) m.ws.sendJson({ t: 'member-join', id: me.id, device, e });
    const url = joinUrlOf(origin, code);
    ws.sendJson({ t: 'welcome', code, you: me.id, url, qrSvg: toSvg(encodeQR(url, { ecl: 'M' })), members: memberList(room) });
    log('room', `홈페이지 방 ${room.members.size}대: ${device} 들어옴`);
  }

  function addMember(room, ws, device, e) {
    const member = { id: room.nextId++, ws, device, e, heard: Date.now(), stall: null };
    room.members.set(member.id, member);
    live.add(ws);
    let unsaved = 0;
    // 말없이 끊긴 기기(잠든 휴대폰 등)는 신호에 답하지 않는다: 내보내야 인원 수가 맞고 다른 기기가 기다리지 않는다
    const heartbeat = setInterval(() => {
      if (Date.now() - member.heard > silentMs) {
        log('room', `홈페이지 방: ${member.device} 응답이 없어 내보냄`);
        return ws.close(4008, 'silent');
      }
      ws.ping();
    }, pingMs);
    heartbeat.unref?.();
    ws.on('pong', () => (member.heard = Date.now()));
    ws.on('message', (data, binary) => {
      member.heard = Date.now();
      if (!binary) {
        // 방 열쇠 건네기 등: 그 기기에게만 전한다 (보낸 기기 번호는 중계 서버가 붙인다)
        let msg;
        try {
          msg = data.length < 4096 ? JSON.parse(data.toString('utf8')) : null;
        } catch {
          msg = null;
        }
        if (msg?.t === 'skip') {
          // 이 기기가 '모두'에게 보낼 때 뺄 기기들: 받지 못하고 멈춘 기기 하나 때문에 다른 기기까지 기다리지 않게 (빈 목록이면 다시 모두)
          member.skip = new Set((Array.isArray(msg.ids) ? msg.ids : []).slice(0, MAX_MEMBERS).map(Number));
          return;
        }
        if (msg?.t === 'rename') {
          // 방에서 보일 이름 바꾸기
          member.device = String(msg.device || '').trim().slice(0, 40) || member.device;
          for (const m of room.members.values()) if (m !== member) m.ws.sendJson({ t: 'member-rename', id: member.id, device: member.device });
          return;
        }
        const target = msg?.t === 'signal' ? room.members.get(Number(msg.to)) : null;
        if (target && target !== member) target.ws.sendJson({ t: 'signal', from: member.id, data: msg.data });
        return;
      }
      // 바이트 메시지: [받는 사람 u16][...] → [보낸 사람 u16][...]. 0이면 나를 뺀 모두.
      if (data.length < 2) return;
      const to = data.readUInt16BE(0);
      const out = Buffer.from(data);
      out.writeUInt16BE(member.id, 0);
      const targets = to === 0 ? [...room.members.values()].filter((m) => m !== member && !member.skip?.has(m.id)) : [room.members.get(to)].filter((m) => m && m !== member);
      let waiting = 0;
      for (const target of targets) {
        if (target.ws.closed) continue; // 닫힌 기기는 곧 방에서 빠진다 (기다리면 다시 풀리지 않는다)
        state.web.bytes = (state.web.bytes || 0) + out.length;
        unsaved += out.length;
        if (!target.ws.send(out)) {
          // 받는 쪽이 느리면 보내는 쪽을 잠깐 멈춘다 (이 서버 메모리에 쌓이지 않게). 가장 느린 기기에 맞춘다.
          // 다만 한 기기가 오래 막혀 있으면 그 기기를 내보낸다 (끊긴 기기 하나 때문에 방 전체가 멈추지 않게).
          waiting++;
          const resumeOnce = () => {
            target.ws.off('drain', resumeOnce);
            target.ws.off('close', resumeOnce);
            clearTimeout(target.stall);
            target.stall = null;
            if (--waiting === 0) ws.resume();
          };
          target.ws.on('drain', resumeOnce);
          target.ws.on('close', resumeOnce);
          target.stall ??= setTimeout(() => {
            log('room', `홈페이지 방: ${target.device} 받는 것이 오래 막혀 내보냄`);
            target.ws.close(4008, 'stalled');
          }, stallMs);
        }
      }
      if (waiting) ws.pause();
      if (unsaved > 8 * 1024 * 1024) {
        unsaved = 0;
        save();
      }
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(member.stall);
      live.delete(ws);
      if (room.members.get(member.id) !== member) return;
      room.members.delete(member.id);
      for (const m of room.members.values()) m.ws.sendJson({ t: 'member-leave', id: member.id });
      if (room.members.size === 0 && rooms.get(room.code) === room) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
      }
      save();
    });
    return member;
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
      if (pin === null) for (const room of rooms.values()) for (const m of room.members.values()) m.ws.close(4003, 'web off');
    },
    overview: () => ({ enabled: enabled(), pin: state.web.pin, bytes: state.web.bytes || 0, rooms: rooms.size, connected: live.size }),
    /** 지금 주고받는 중인 방이 있는지 (업데이트를 미룰지 정할 때) */
    active: () => live.size,
    close() {
      for (const ws of live) ws.close(1001, 'server closing');
    },
  };
}
