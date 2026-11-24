// 홈페이지에서 바로 주고받기 (중계 서버의 첫 화면):
// 설치 없이 여러 브라우저(최대 10대)가 홈페이지에 들어와, 한 기기가 만든 6자리 방 코드로 같은 방에 모인다.
//   - 홈페이지를 쓰려면 중계 서버 주인이 정한 숫자 4자리 암호가 필요하다 (맞히면 그 브라우저는 30일 동안 기억)
//   - 방 안의 메시지는 '방 열쇠'로 종단간 암호화한다 (public/room-core.js). 이 서버는 받는 사람에게 나눠 주기만 한다.
//   - 보관 방: 혼자 만들어 올려 둘 수 있다. '모두'에게 보낸 것(암호문 그대로)을 정한 기간(1·3·7일) 동안 디스크에 남겨 두고,
//     나중에 들어온 기기에 처음부터 다시 보내 준다. 방 열쇠는 방 코드로 감싼 것(PBKDF2)을 맡아 두었다가 들어온 기기에 준다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { acceptWebSocket } from './ws.js';
import { sendJson, sendEmpty, readJson, cleanName, addressKey } from './http.js';
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
const STALL_MS = 15_000; // 한 기기에 보낼 것이 이만큼 (하나도 못 받아 가고) 밀려 있으면 그 기기를 내보낸다 (방 전체가 멈추지 않게)
const MAX_WRONG = 10; // 암호·방 코드를 이만큼 틀리면 그 주소는 잠시 막는다
const WRONG_WINDOW_MS = 10 * 60_000;
const MAX_WRONG_ALL = 300; // 여러 주소에서 몰려와도: 10분 동안 전체로 이만큼 틀리면 잠시 모두 막는다
const VAULT_DAYS = [1, 3, 7]; // 보관 방을 남겨 두는 기간
const VAULT_ROOM_BYTES = 2 * 1024 ** 3; // 보관 방 하나에 남길 수 있는 양
const VAULT_TOTAL_BYTES = 10 * 1024 ** 3; // 모든 보관 방을 합친 한도
const VAULT_MIN_FREE = 2 * 1024 ** 3; // 디스크에 이만큼은 남겨 둔다
const MAX_VAULTS = 50;
const MAX_VAULTS_PER_ADDRESS = 5;
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

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
 * @param {string} [options.vaultDir]  보관 방의 내용을 둘 폴더 (없으면 보관 방을 만들지 않는다)
 */
export function createRoomService({ state, save, clientAddress, log = () => {}, timing = {}, vaultDir = null }) {
  const { pingMs = PING_MS, silentMs = SILENT_MS, stallMs = STALL_MS } = timing;
  state.web ??= { pin: null, version: 1, bytes: 0 };
  state.web.key ??= crypto.randomBytes(32).toString('hex'); // 브라우저에 주는 입장권의 서명 열쇠

  const rooms = new Map(); // 방 코드 → { code, address, members: 번호 → { id, ws, device, e }, nextId, timer }
  const live = new Set();
  const wrong = new Map(); // 주소 → { count, since }
  let wrongAll = { count: 0, since: Date.now() };

  const enabled = () => WEB_PIN.test(state.web.pin || '');

  // ---- 보관 방 ----
  state.web.vaults ??= {}; // 방 코드 → { createdAt, expiresAt, address, ownerHash, key, names, nextId }
  const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
  const vaultFile = (code) => path.join(vaultDir, code, 'log.bin');
  const vaultRooms = () => [...rooms.values()].filter((r) => r.vault);
  const storedBytes = () => vaultRooms().reduce((n, r) => n + r.vault.size, 0);
  let freeCache = { at: 0, free: Infinity };
  function diskFree() {
    if (Date.now() - freeCache.at < 10_000) return freeCache.free;
    let free = Infinity;
    try {
      const s = fs.statfsSync(vaultDir);
      free = s.bavail * s.bsize;
    } catch {
      // 알 수 없으면 막지 않는다
    }
    freeCache = { at: Date.now(), free };
    return free;
  }
  function saveVault(room) {
    const v = room.vault;
    state.web.vaults[room.code] = { createdAt: v.createdAt, expiresAt: v.expiresAt, address: room.address, ownerHash: v.ownerHash, key: v.key, names: Object.fromEntries(v.names), nextId: room.nextId };
    save();
  }
  /** 보관 방을 지운다 (기간이 지났거나 만든 사람이 닫았다) */
  function destroyVault(room, code, message) {
    clearTimeout(room.timer);
    for (const m of room.members.values()) {
      m.ws.sendJson({ t: 'error', code, message });
      m.ws.close(4008, code);
    }
    if (rooms.get(room.code) === room) rooms.delete(room.code);
    delete state.web.vaults[room.code];
    save();
    try {
      fs.rmSync(path.dirname(vaultFile(room.code)), { recursive: true, force: true });
    } catch (err) {
      log('error', `보관 방 파일을 지우지 못했어요: ${err.message}`);
    }
    log('room', `홈페이지 보관 방 ${room.code} 지움 (${code === 'expired' ? '기간 지남' : '닫음'})`);
  }
  function armExpiry(room) {
    clearTimeout(room.timer);
    const left = room.vault.expiresAt - Date.now();
    if (left <= 0) return destroyVault(room, 'expired', '보관 기간이 지나 방을 닫았어요.');
    room.timer = setTimeout(() => armExpiry(room), Math.min(left, 24 * 60 * 60 * 1000)); // setTimeout은 24.8일까지라 하루씩 나눠 잰다
    room.timer.unref?.();
  }
  /** '모두'에게 보낸 것을 남긴다: [길이 u32][보낸 기기 번호 u16 + IV + 암호문]. 한도를 넘으면 남기지 않고 false */
  function store(room, out) {
    const v = room.vault;
    if (v.size + 4 + out.length > VAULT_ROOM_BYTES || storedBytes() + 4 + out.length > VAULT_TOTAL_BYTES || diskFree() < VAULT_MIN_FREE) return false;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(out.length);
    try {
      fs.appendFileSync(v.file, Buffer.concat([head, out]));
    } catch (err) {
      log('error', `보관 방에 남기지 못했어요: ${err.message}`);
      return false;
    }
    v.size += 4 + out.length;
    return true;
  }
  /** 늦게 들어온 기기에 남겨 둔 것을 처음부터 보낸다. 다 보내면 그때부터 실시간으로 받는다. */
  async function replay(room, member) {
    let fd = null;
    let offset = 0;
    try {
      fd = await fsp.open(room.vault.file, 'r');
    } catch {
      fd = null;
    }
    const head = Buffer.alloc(4);
    try {
      for (;;) {
        if (member.ws.closed) return;
        // 남은 것이 없으면 (같은 차례 안에서) 실시간으로 바꾼다: 그 사이 새로 남긴 것을 놓치지 않게
        if (!fd || offset >= room.vault.size) {
          member.replaying = false;
          for (const out of member.held.splice(0)) member.ws.send(out);
          member.ws.sendJson({ t: 'vault-ready' });
          return;
        }
        await fd.read(head, 0, 4, offset);
        const length = head.readUInt32BE(0);
        const out = Buffer.alloc(length);
        await fd.read(out, 0, length, offset + 4);
        offset += 4 + length;
        state.web.bytes = (state.web.bytes || 0) + length;
        if (!member.ws.send(out)) {
          await new Promise((resolve) => {
            const done = () => {
              member.ws.off('drain', done);
              member.ws.off('close', done);
              resolve();
            };
            member.ws.on('drain', done);
            member.ws.on('close', done);
          });
        }
      }
    } catch (err) {
      log('error', `보관 방을 보내지 못했어요: ${err.message}`);
      member.ws.close(1011, 'replay failed');
    } finally {
      await fd?.close().catch(() => {});
    }
  }
  // 켤 때: 남겨 둔 보관 방을 되살린다 (기간이 지났거나 내용이 없어진 것은 지운다)
  if (vaultDir) {
    for (const [code, meta] of Object.entries(state.web.vaults)) {
      let size = -1;
      try {
        size = fs.statSync(vaultFile(code)).size;
      } catch {
        size = -1;
      }
      if (!/^\d{6}$/.test(code) || size < 0 || !(meta.expiresAt > Date.now())) {
        delete state.web.vaults[code];
        fs.rmSync(path.join(vaultDir, code), { recursive: true, force: true });
        continue;
      }
      const room = {
        code,
        address: meta.address || '',
        members: new Map(),
        nextId: Number(meta.nextId) || 1,
        everJoined: true,
        vault: { createdAt: meta.createdAt, expiresAt: meta.expiresAt, ownerHash: meta.ownerHash, key: meta.key ?? null, names: new Map(Object.entries(meta.names || {}).map(([id, n]) => [Number(id), n])), file: vaultFile(code), size },
      };
      rooms.set(code, room);
      armExpiry(room);
    }
  } else state.web.vaults = {};

  // ---- 틀린 횟수 ----
  /** @param {boolean} [all]  여러 주소를 합친 한도도 볼지 (암호 넣기는 보고, 입장권이 있는 사람의 방 코드는 주소별로만) */
  function blocked(raw, all = true) {
    const address = addressKey(raw);
    if (Date.now() - wrongAll.since > WRONG_WINDOW_MS) wrongAll = { count: 0, since: Date.now() };
    if (all && wrongAll.count >= MAX_WRONG_ALL) return true;
    const entry = wrong.get(address);
    if (entry && Date.now() - entry.since > WRONG_WINDOW_MS) wrong.delete(address);
    return (wrong.get(address)?.count ?? 0) >= MAX_WRONG;
  }
  function countWrong(raw, all = true) {
    const address = addressKey(raw);
    if (all) wrongAll.count++;
    const entry = wrong.get(address);
    if (entry) entry.count++;
    else wrong.set(address, { count: 1, since: Date.now() });
    while (wrong.size > 10_000) wrong.delete(wrong.keys().next().value);
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
      const device = cleanName(msg?.device, '기기');
      // 그 기기의 ECDH 공개 열쇠: 방 열쇠를 건네받을 때 쓴다 (중계 서버는 그대로 전하기만 한다)
      const e = /^04[0-9a-f]{128}$/i.test(String(msg?.e || '')) ? String(msg.e) : '';
      if (!e) return ws.close(4002, 'bad message');
      if (msg?.t === 'create') return create(ws, address, device, e, origin, Number(msg.keep) || 0);
      if (msg?.t === 'join') return join(ws, address, device, e, String(msg.code || ''), origin);
      ws.close(4002, 'bad message');
    });
  }

  const memberList = (room) => [...room.members.values()].map(({ id, device, e }) => ({ id, device, e }));
  const joinUrlOf = (origin, code) => `${origin}/#${code}`;

  function create(ws, address, device, e, origin, keep = 0) {
    const mine = [...rooms.values()].filter((r) => r.address === address && !r.vault).length;
    if (rooms.size >= MAX_ROOMS || mine >= MAX_ROOMS_PER_ADDRESS) {
      ws.sendJson({ t: 'error', code: 'busy', message: '지금은 방을 더 만들 수 없어요. 잠시 뒤 다시 해 주세요.' });
      return ws.close(4003, 'busy');
    }
    if (keep) return createVault(ws, address, device, e, origin, keep);
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

  /** 보관 방: 혼자 만들고, 창을 닫아도 정한 기간 동안 남는다 */
  function createVault(ws, address, device, e, origin, keep) {
    if (!vaultDir || !VAULT_DAYS.includes(keep)) {
      ws.sendJson({ t: 'error', code: 'no-vault', message: '이 중계 서버에서는 보관 방을 만들 수 없어요.' });
      return ws.close(4003, 'no vault');
    }
    const vaults = vaultRooms();
    if (vaults.length >= MAX_VAULTS || vaults.filter((r) => r.address === address).length >= MAX_VAULTS_PER_ADDRESS) {
      ws.sendJson({ t: 'error', code: 'busy', message: `보관 방은 한 곳에서 ${MAX_VAULTS_PER_ADDRESS}개까지예요. 안 쓰는 방을 닫아 주세요.` });
      return ws.close(4003, 'busy');
    }
    if (storedBytes() >= VAULT_TOTAL_BYTES || diskFree() < VAULT_MIN_FREE) {
      ws.sendJson({ t: 'error', code: 'busy', message: '중계 서버에 보관할 자리가 모자라요. 나중에 다시 해 주세요.' });
      return ws.close(4003, 'busy');
    }
    const code = newCode();
    const owner = crypto.randomBytes(24).toString('base64url'); // 만든 사람만 방을 닫을 수 있게 (그 브라우저에 남겨 둔다)
    const file = vaultFile(code);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    const now = Date.now();
    const room = {
      code,
      address,
      members: new Map(),
      nextId: 1,
      everJoined: true,
      vault: { createdAt: now, expiresAt: now + keep * 24 * 60 * 60 * 1000, ownerHash: sha(owner), key: null, names: new Map(), file, size: 0 },
    };
    rooms.set(code, room);
    armExpiry(room);
    const me = addMember(room, ws, device, e);
    room.vault.names.set(me.id, device);
    saveVault(room);
    const url = joinUrlOf(origin, code);
    ws.sendJson({ t: 'room', code, you: me.id, url, qrSvg: toSvg(encodeQR(url, { ecl: 'M' })), members: memberList(room), vault: vaultInfo(room), owner });
    log('room', `홈페이지 보관 방 만듦 (${keep}일): ${device}`);
  }

  const vaultInfo = (room) => ({
    expiresAt: room.vault.expiresAt,
    size: room.vault.size,
    limit: VAULT_ROOM_BYTES,
    key: room.vault.key,
    names: Object.fromEntries(room.vault.names),
  });

  function join(ws, address, device, e, code, origin) {
    // 방 코드는 입장권(암호를 맞힌 브라우저)이 있어야 넣으므로 주소별로만 센다 (몇 사람이 틀려도 모두가 막히지 않게)
    if (blocked(address, false)) {
      ws.sendJson({ t: 'error', code: 'too-many', message: '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.' });
      return ws.close(4003, 'too many');
    }
    const room = /^\d{6}$/.test(code) ? rooms.get(code) : null;
    if (!room) {
      countWrong(address, false);
      ws.sendJson({ t: 'error', code: 'no-room', message: '그 코드의 방이 없어요. 숫자를 확인하거나 방을 만든 사람에게 새 코드를 받아 주세요.' });
      return ws.close(4004, 'no room');
    }
    if (room.members.size >= MAX_MEMBERS) {
      ws.sendJson({ t: 'error', code: 'full', message: `한 방에는 ${MAX_MEMBERS}대까지 들어올 수 있어요.` });
      return ws.close(4003, 'full');
    }
    if (room.nextId > 0xffff) {
      ws.sendJson({ t: 'error', code: 'full', message: '이 방은 더 들어올 수 없어요. 새 방을 만들어 주세요.' });
      return ws.close(4003, 'full');
    }
    room.everJoined = true;
    const me = addMember(room, ws, device, e);
    for (const m of room.members.values()) if (m !== me) m.ws.sendJson({ t: 'member-join', id: me.id, device, e });
    const url = joinUrlOf(origin, code);
    if (room.vault) {
      room.vault.names.set(me.id, device);
      saveVault(room);
      me.replaying = true; // 남겨 둔 것을 다 보내기 전까지는 실시간 '모두' 메시지를 따로 보내지 않는다 (남긴 것에서 읽는다)
    }
    ws.sendJson({ t: 'welcome', code, you: me.id, url, qrSvg: toSvg(encodeQR(url, { ecl: 'M' })), members: memberList(room), ...(room.vault ? { vault: vaultInfo(room) } : {}) });
    if (room.vault) replay(room, me);
    log('room', `홈페이지 방 ${room.members.size}대: ${device} 들어옴`);
  }

  function addMember(room, ws, device, e) {
    const member = { id: room.nextId++, ws, device, e, heard: Date.now(), stall: null, replaying: false, held: [] };
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
        if (msg?.t === 'store-key' && room.vault && !room.vault.key && member.id === 1) {
          // 보관 방을 만든 기기가 방 코드로 감싼 방 열쇠를 맡긴다 (나중에 혼자 들어온 기기가 방 코드로 푼다)
          const { salt, iv, k } = msg;
          if (HEX(32).test(String(salt)) && HEX(24).test(String(iv)) && HEX(96).test(String(k))) {
            room.vault.key = { salt, iv, k };
            saveVault(room);
          }
          return;
        }
        if (msg?.t === 'close-room' && room.vault) {
          // 보관 방 닫기: 만든 사람만 (그 브라우저에 남겨 둔 표시로 확인)
          const given = sha(msg.owner ?? '');
          if (given.length === room.vault.ownerHash.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(room.vault.ownerHash))) {
            destroyVault(room, 'room closed', '방을 만든 사람이 보관 방을 닫았어요.');
          } else member.ws.sendJson({ t: 'notice', message: '방을 만든 브라우저에서만 닫을 수 있어요.' });
          return;
        }
        if (msg?.t === 'rename') {
          // 방에서 보일 이름 바꾸기
          member.device = cleanName(msg.device, member.device);
          if (room.vault) {
            room.vault.names.set(member.id, member.device);
            saveVault(room);
          }
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
      let stored = false;
      if (to === 0 && room.vault) {
        stored = store(room, out);
        if (!stored && !member.vaultFullTold) {
          member.vaultFullTold = true;
          member.ws.sendJson({ t: 'vault-full', message: '보관 방에 남길 자리가 모자라요. 지금 방에 있는 기기에만 보내요.' });
        }
      }
      let waiting = 0;
      for (const target of targets) {
        if (target.ws.closed) continue; // 닫힌 기기는 곧 방에서 빠진다 (기다리면 다시 풀리지 않는다)
        if (target.replaying) {
          // 남겨 둔 것을 받는 중인 기기: 남긴 것은 거기서 읽고, 그 기기에게만 온 것은 다 받은 뒤에 보낸다
          if (!stored) target.held.push(out);
          continue;
        }
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
      // 보관 방은 모두 나가도 남는다 (기간이 지나거나 만든 사람이 닫을 때까지)
      if (room.members.size === 0 && rooms.get(room.code) === room && !room.vault) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
      }
      if (room.vault) saveVault(room);
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
      for (const room of rooms.values()) for (const m of room.members.values()) m.ws.close(4003, pin === null ? 'web off' : 'pin changed');
    },
    overview: () => ({ enabled: enabled(), pin: state.web.pin, bytes: state.web.bytes || 0, rooms: rooms.size - vaultRooms().length, vaults: vaultRooms().length, vaultBytes: storedBytes(), connected: live.size }),
    /** 지금 주고받는 중인 방이 있는지 (업데이트를 미룰지 정할 때) */
    active: () => live.size,
    close() {
      for (const ws of live) ws.close(1001, 'server closing');
    },
  };
}
