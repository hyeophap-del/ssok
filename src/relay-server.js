// 중계 서버 (본가 PC 같은 늘 켜진 컴퓨터에서 Cloudflare 터널 뒤에 둔다).
// 하는 일은 셋뿐이다.
//   1. 초대 코드를 가진 쏙 PC들이 연결해 두게 한다 (/ws/pc)
//   2. 휴대폰이 들어오면(/ws/c/<PC 번호>) 그 PC에 알리고, PC가 따로 연결해 오면(/ws/pc-accept/<번호>) 둘을 잇는다
//   3. 휴대폰 화면(웹 페이지 파일)을 내려준다
// 주고받는 내용은 휴대폰과 PC 사이에서 종단간 암호화되어 있어, 이 서버는 알아볼 수 없는 바이트만 넘긴다.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { acceptWebSocket } from './ws.js';
import { sendJson, sendText, cleanName, addressKey } from './http.js';
import { APP_NAME, APP_ID } from './brand.js';
import { cleanLinkName, DROP_ID } from './drops.js';
import { peerRelaySecret } from './peers.js';
import { RelayClient } from '../public/relay.js';
import { createRoomService } from './relay-rooms.js';

const PC_ID = /^[0-9a-f]{16}$/;
const SID = /^[0-9a-f]{32}$/;
const MAX_PCS_PER_INVITE = 10;
const MAX_SESSIONS_PER_PC = 16;
const MAX_PHONES_PER_ADDRESS = 8; // 한 주소에서 동시에 열 수 있는 휴대폰 연결 (한 사람이 PC의 자리를 다 차지하지 못하게)
const HELLO_TIMEOUT_MS = 15_000; // 연결하고 이 안에 첫 인사가 없으면 닫는다
const MAX_QUEUED_BYTES = 4 * 1024 * 1024; // PC가 받기 전에 휴대폰이 보낸 것을 모아 두는 한도
const MAX_SHORTCUTS_IN_FLIGHT = 4; // 크기를 알리지 않은 단축어 본문을 동시에 모으는 수
const ACCEPT_TIMEOUT_MS = 10_000;
const PAIR_CODE_MS = 10 * 60_000;
const MAX_LINKS_PER_PC = 20; // 링크 이름 (ssok.example.com/minsu)
const SHORTCUT_BUFFER = 100 * 1024 * 1024; // 크기를 미리 알리지 않고 보낸 단축어 본문은 이만큼까지 모아서 넘긴다 (Cloudflare 무료 요금제의 한도와 같다) // 다른 곳의 PC와 처음 연결할 때 쓰는 연결 코드의 유효 시간
const MAX_BAD_TRIES = 20; // 초대 코드를 이만큼 틀리면 그 주소는 잠시 막는다
const BAD_TRY_WINDOW_MS = 10 * 60_000;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.apk': 'application/vnd.android.package-archive',
};
const INVITE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외

const hash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** 본문을 바이트 그대로 모은다 (사진 같은 파일이라 글자로 바꾸면 안 된다). 너무 크면 예외. */
function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    // 끝나기 전에 끊기면 (보내던 쪽이 그만둠, 열쇠가 틀려 이쪽에서 끊음) 기다리지 않는다
    req.on('close', () => !req.complete && reject(Object.assign(new Error('closed'), { code: 'CLOSED' })));
  });
}

/**
 * 본문을 받는 대로 읽어 모아 두면서, 꺼내 쓰는 쪽에는 조각씩 넘겨준다 (for await로 읽는 스트림).
 * 넘기는 쪽(PC로 가는 통로)이 늦어도 받기는 멈추지 않는다. limit을 넘으면 끊는다.
 */
function spool(req, limit) {
  const chunks = [];
  let total = 0;
  let ended = false;
  let error = null;
  let wake = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > limit) {
      error = Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
      req.destroy();
    } else {
      chunks.push(chunk);
    }
    poke();
  });
  req.on('end', () => {
    ended = true;
    poke();
  });
  req.on('error', (err) => {
    error ??= err;
    poke();
  });
  req.on('close', () => {
    if (!ended) error ??= new Error('보내던 쪽이 끊었어요');
    poke();
  });
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (chunks.length) {
          yield chunks.shift();
          continue;
        }
        if (error) throw error;
        if (ended) return;
        await new Promise((resolve) => (wake = resolve));
      }
    },
  };
}

export function newInviteCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => INVITE_LETTERS[b % INVITE_LETTERS.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * @param {object} options
 * @param {string} options.dataDir     초대 코드·PC 목록을 저장할 폴더
 * @param {string} options.publicDir   휴대폰 화면 파일 (쏙의 public/)
 * @param {string} options.version
 * @param {(type: string, payload?: any) => void} [options.log]
 * @param {object} [options.roomTiming]  홈페이지 방의 신호 간격 (시험용)
 */
export function createRelayServer({ dataDir, publicDir, version, log = () => {}, roomTiming }) {
  const stateFile = path.join(dataDir, 'relay.json');
  let state = { invites: [], pcs: {}, links: {} }; // links: 링크 이름 → { pcId, linkId }
  try {
    const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (Array.isArray(loaded.invites) && loaded.pcs && typeof loaded.pcs === 'object') state = { links: {}, ...loaded };
  } catch {
    // 처음 실행
  }
  state.pcs = Object.assign(Object.create(null), state.pcs);
  state.links = Object.assign(Object.create(null), state.links);
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = `${stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
        fs.renameSync(tmp, stateFile);
      } catch (err) {
        log('error', `relay.json을 저장하지 못했어요 (조금 뒤 다시): ${err.message}`);
        saveTimer = setTimeout(save, 10_000);
        saveTimer.unref?.();
      }
    }, 300);
    saveTimer.unref?.();
  };

  const online = new Map(); // PC 번호 → { ws, invite, name }
  const pending = new Map(); // 연결 번호 → { phone, pcId, queue, timer }
  const sessionCount = new Map(); // PC 번호 → 이어진 휴대폰 수
  const live = new Set(); // 이어 둔 웹소켓 (끌 때 닫는다)
  const pairCodes = new Map(); // 연결 코드 → { pcId, expires } (PC 하나에 하나씩)
  const badTries = new Map(); // 접속한 주소 → { count, since }
  const phonesByAddress = new Map(); // 접속한 주소 → 열어 둔 휴대폰 연결 수
  const sessionsByPc = new Map(); // PC 번호 → 이어진 [휴대폰, PC] 연결들
  let shortcutsInFlight = 0; // 지금 받는 중인 단축어 본문 수 (메모리에 모으므로 한도를 둔다)

  /** Cloudflare 터널 뒤에서는 실제 접속 주소가 이 헤더에 온다 */
  const clientAddress = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  function tooManyTries(raw) {
    const address = addressKey(raw);
    const entry = badTries.get(address);
    if (!entry) return false;
    if (Date.now() - entry.since > BAD_TRY_WINDOW_MS) {
      badTries.delete(address);
      return false;
    }
    return entry.count >= MAX_BAD_TRIES;
  }
  function countBadTry(raw) {
    const address = addressKey(raw);
    const entry = badTries.get(address);
    if (!entry || Date.now() - entry.since > BAD_TRY_WINDOW_MS) badTries.set(address, { count: 1, since: Date.now() });
    else entry.count++;
    while (badTries.size > 10_000) badTries.delete(badTries.keys().next().value); // 너무 많아지면 오래된 것부터 잊는다
  }

  // 홈페이지에서 바로 주고받기 (설치 없이 브라우저끼리, 주인이 정한 4자리 암호로)
  const rooms = createRoomService({ state, save, clientAddress, log, timing: roomTiming });

  // ---- 웹 페이지 ----

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
    });
  });
  server.headersTimeout = 30_000;
  server.on('upgrade', (req, socket, head) => {
    try {
      upgrade(req, socket, head);
    } catch (err) {
      log('error', err);
      socket.destroy();
    }
  });

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://relay');
    let m;
    if (url.pathname.startsWith('/api/web/') && (await rooms.handleHttp(req, res, url))) return;
    // 아이폰 단축어: 파일·텍스트를 그대로 올리면 이 중계 서버가 암호화된 통로로 PC에 넘긴다
    if ((m = /^\/s\/([0-9a-f]{16})$/.exec(url.pathname)) && (req.method === 'POST' || req.method === 'PUT')) return shortcutUpload(req, res, m[1], url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
    if (url.pathname === '/api/ping') return sendJson(res, 200, { app: `${APP_ID}-relay`, version });
    // 연결된 다른 PC가 '어디서나'로 보낼 수 있는지(그 PC가 지금 이 중계 서버에 붙어 있는지) 확인할 때
    if ((m = /^\/api\/online\/([0-9a-f]{16})$/.exec(url.pathname))) return sendJson(res, 200, { online: online.has(m[1]) });
    // 다른 곳의 PC가 연결 코드로 상대 PC 번호를 찾을 때. 코드를 함부로 맞혀 보지 못하게 틀린 횟수를 센다.
    if ((m = /^\/api\/pair-code\/([A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(url.pathname))) {
      const address = clientAddress(req);
      if (tooManyTries(address)) return sendJson(res, 429, { error: '너무 많이 틀렸어요. 10분 뒤에 다시 시도해 주세요.' });
      const entry = pairCodes.get(m[1]);
      if (!entry || entry.expires < Date.now() || !online.has(entry.pcId)) {
        countBadTry(address);
        return sendJson(res, 404, { error: '연결 코드가 맞지 않거나 시간이 지났어요.' });
      }
      return sendJson(res, 200, { id: entry.pcId });
    }
    // 첫 화면: 설치 없이 브라우저끼리 주고받기 (암호를 넣어야 쓸 수 있다)
    if (url.pathname === '/') return servePage(req, res, 'room.html');
    if ((m = /^\/p\/([0-9a-f]{16})\/?$/.exec(url.pathname))) return servePage(req, res, 'index.html', m[1]);
    if ((m = /^\/p\/([0-9a-f]{16})\/manifest\.webmanifest$/.exec(url.pathname))) return serveManifest(res, m[1]);
    // 링크 이름으로 받는 PC와 링크 번호를 찾는다 (함부로 이름을 맞혀 보지 못하게 틀린 횟수를 센다)
    if ((m = /^\/api\/link\/([^/]+)$/.exec(url.pathname))) {
      const address = clientAddress(req);
      if (tooManyTries(address)) return sendJson(res, 429, { error: '너무 많이 시도했어요. 10분 뒤에 다시 해 주세요.' });
      let wanted = '';
      try {
        wanted = cleanLinkName(decodeURIComponent(m[1])) ?? '';
      } catch {
        wanted = '';
      }
      const owner = wanted ? state.links[wanted] : null;
      if (!owner) {
        countBadTry(address);
        return sendJson(res, 404, { error: '이 링크를 찾을 수 없어요. 주소를 확인해 주세요.' });
      }
      return sendJson(res, 200, { pcId: owner.pcId, linkId: owner.linkId, online: online.has(owner.pcId) });
    }
    const name = url.pathname.slice(1);
    // 링크 (ssok.example.com/minsu): 보내고 받는 화면. 정말 있는 링크인지는 화면이 /api/link로 확인한다.
    const linkName = name.replace(/\/$/, '');
    if (/^[A-Za-z0-9-]+$/.test(linkName) && cleanLinkName(linkName)) return servePage(req, res, 'drop.html');
    // 휴대폰 화면에 필요한 파일만 내준다 (HTML은 /p/<PC 번호>로만, 관리 화면 파일은 내주지 않는다)
    const ext = path.extname(name);
    if (/^[A-Za-z0-9._-]+$/.test(name) && STATIC_TYPES[ext] && ext !== '.html' && !name.toLowerCase().startsWith('relay-admin')) return servePage(req, res, name);
    return sendText(res, 404, 'Not Found');
  }

/**
   * 아이폰 단축어가 보낸 것을 PC로 넘긴다. 단축어는 웹소켓·암호화를 못 하므로, 이 중계 서버가 휴대폰 대신
   * 그 PC와 암호화된 통로를 열고(단축어 열쇠로) 받은 본문을 흘려보낸다. 그래서 이 경로만은 중계 서버가 내용을 볼 수 있다.
   * 열쇠가 맞는지는 PC가 확인한다 (틀리면 통로가 열리지 않는다). PC는 이 통로로 보내기만 허락한다.
   */
  async function shortcutUpload(req, res, pcId, url) {
    const address = clientAddress(req);
    const fail = (status, error) => {
      if (!req.complete) {
        res.setHeader('Connection', 'close');
        res.on('finish', () => req.destroy());
      }
      return sendJson(res, status, { error });
    };
    if (tooManyTries(address)) return fail(429, '너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.');
    const key = url.searchParams.get('k') ?? /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1] ?? '';
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) {
      countBadTry(address);
      return fail(401, '단축어 주소가 맞지 않아요. PC의 쏙 화면에서 주소를 다시 복사해 주세요.');
    }
    if (!online.has(pcId)) return fail(503, 'PC의 쏙이 꺼져 있거나 중계 서버에 연결되어 있지 않아요.');

    // 본문은 받는 대로 바로 읽어 둔다. 읽지 않고 두면 Cloudflare 터널의 한 연결(HTTP/2)이 그 본문으로 가득 차서,
    // 같은 연결로 오는 PC의 응답까지 막혀 통로가 열리지 않는다 (실제로 겪었다).
    // PC는 크기를 미리 알아야 하므로, 단축어가 크기 없이 보내면 끝까지 모아서 잰다.
    let length = Number(req.headers['content-length']);
    if (Number.isSafeInteger(length) && length > SHORTCUT_BUFFER) return fail(413, '한 번에 100MB까지 보낼 수 있어요.');
    let body;
    let reading = null;
    const sized = Number.isSafeInteger(length) && length >= 0;
    if (sized) body = spool(req, SHORTCUT_BUFFER);
    else {
      if (shortcutsInFlight >= MAX_SHORTCUTS_IN_FLIGHT) return fail(503, '지금 받는 것이 많아요. 잠시 뒤 다시 보내 주세요.');
      shortcutsInFlight++;
      reading = readBytes(req, SHORTCUT_BUFFER);
      reading.catch(() => {}).finally(() => shortcutsInFlight--);
    }

    let client;
    try {
      client = await RelayClient.connect(`ws://127.0.0.1:${server.address().port}/ws/c/${pcId}`, peerRelaySecret(key), { kid: 'shortcut', device: '아이폰 단축어' });
    } catch (err) {
      if (err.code === 'BAD_KEY' || err.code === 'UNKNOWN_PEER') {
        countBadTry(address);
        return fail(401, '단축어 주소가 맞지 않아요. PC의 쏙 화면에서 주소를 다시 복사해 주세요.');
      }
      return fail(503, 'PC의 쏙이 꺼져 있거나 중계 서버에 연결되어 있지 않아요.');
    }
    if (reading) {
      // 열쇠가 맞을 때만 끝까지 모은다
      try {
        body = await reading;
      } catch {
        client.close();
        return fail(413, '한 번에 100MB까지 보낼 수 있어요.');
      }
      length = body.length;
    }
    const params = new URLSearchParams();
    for (const name of ['name', 'lastModified']) if (url.searchParams.has(name)) params.set(name, url.searchParams.get(name));
    try {
      const answer = await client.request('POST', `/api/upload${params.size ? `?${params}` : ''}`, {
        headers: {
          'content-type': String(req.headers['content-type'] || 'application/octet-stream'),
          'content-length': String(length),
          'user-agent': String(req.headers['user-agent'] || ''),
          'x-requested-with': APP_ID,
        },
        body,
      });
      let json = null;
      try {
        json = await answer.json();
      } catch {
        json = null;
      }
      if (answer.status >= 200 && answer.status < 300) return sendJson(res, 200, { ok: true, name: json?.name ?? null });
      return fail(answer.status, json?.error || 'PC가 받지 못했어요.');
    } catch {
      return fail(502, '보내는 중에 연결이 끊겼어요. 다시 보내 주세요.');
    } finally {
      client.close();
    }
  }

  async function servePage(req, res, name, pcId) {
    let body;
    try {
      body = await fsp.readFile(path.join(publicDir, name));
    } catch {
      return sendText(res, 404, 'Not Found');
    }
    const ext = path.extname(name);
    if (['.html', '.js', '.webmanifest'].includes(ext)) {
      let text = body.toString('utf8').replaceAll('{{APP_NAME}}', APP_NAME).replaceAll('{{APP_ID}}', APP_ID);
      // 홈 화면에 추가하면 이 PC의 주소로 열리게 한다
      if (name === 'index.html' && pcId) text = text.replace('href="/manifest.webmanifest"', `href="/p/${pcId}/manifest.webmanifest"`);
      body = Buffer.from(text);
    }
    const headers = { 'Content-Type': STATIC_TYPES[ext], 'Content-Length': body.length, 'Cache-Control': 'no-cache' };
    if (name === 'index.html' || name === 'drop.html' || name === 'room.html') {
      const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '');
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        `connect-src 'self' wss://${host}`,
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; ');
      headers['X-Frame-Options'] = 'DENY';
    }
    if (ext === '.apk') headers['Content-Disposition'] = `attachment; filename="${name}"`;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function serveManifest(res, pcId) {
    let manifest = {};
    try {
      manifest = JSON.parse((await fsp.readFile(path.join(publicDir, 'manifest.webmanifest'), 'utf8')).replaceAll('{{APP_NAME}}', APP_NAME));
    } catch {
      // 기본값으로
    }
    manifest.start_url = `/p/${pcId}`;
    manifest.scope = `/p/${pcId}`;
    manifest.id = `/p/${pcId}`;
    for (const icon of manifest.icons || []) if (icon.src && !icon.src.startsWith('/')) icon.src = `/${icon.src}`;
    return sendJson(res, 200, manifest);
  }

  // ---- 웹소켓 ----

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://relay');
    let m;
    if (url.pathname === '/ws/pc') return onControl(acceptWebSocket(req, socket, head), clientAddress(req));
    if (url.pathname === '/ws/room') return rooms.handleUpgrade(req, socket, head);
    if ((m = /^\/ws\/c\/([0-9a-f]{16})$/.exec(url.pathname))) return onPhone(acceptWebSocket(req, socket, head), m[1], clientAddress(req));
    if ((m = /^\/ws\/pc-accept\/([0-9a-f]{32})$/.exec(url.pathname))) return onAccept(acceptWebSocket(req, socket, head), m[1]);
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  }

  /** 첫 메시지(JSON)를 기다린다. 안 오거나 이상하면 연결을 끊는다. */
  function firstMessage(ws, onMessage) {
    if (!ws) return;
    const timer = setTimeout(() => ws.close(4008, 'timeout'), 10_000);
    ws.once('message', (data, binary) => {
      clearTimeout(timer);
      let msg = null;
      try {
        msg = binary ? null : JSON.parse(data.toString('utf8'));
      } catch {
        msg = null;
      }
      if (!msg) return ws.close(4002, 'bad message');
      onMessage(msg);
    });
  }

  function refuse(ws, code, message) {
    ws.sendJson({ t: 'error', code, message });
    ws.close(code === 'pc-offline' ? 4004 : 4003, code);
  }

  /** 쏙 PC가 연결해 둔다 */
  function onControl(ws, address) {
    if (ws && tooManyTries(address)) return refuse(ws, 'too-many-tries', '초대 코드를 너무 많이 틀렸어요. 10분 뒤에 다시 시도해 주세요.');
    firstMessage(ws, (msg) => {
      if (msg.t !== 'register' || !PC_ID.test(msg.id || '') || typeof msg.auth !== 'string' || msg.auth.length < 20 || msg.auth.length > 100) {
        return refuse(ws, 'bad-request', '잘못된 연결 요청이에요.');
      }
      const invite = state.invites.find((i) => i.code === String(msg.invite || '').trim().toUpperCase());
      if (!invite) countBadTry(address);
      if (!invite || invite.disabled) return refuse(ws, 'bad-invite', '초대 코드가 맞지 않거나 막혔어요. 중계 서버 주인에게 확인해 주세요.');
      const known = state.pcs[msg.id];
      if (known && !sameHash(known.authHash, hash(msg.auth))) countBadTry(address);
      if (known && !sameHash(known.authHash, hash(msg.auth))) return refuse(ws, 'bad-auth', '이 PC 번호는 이미 다른 PC가 쓰고 있어요.');
      if (!known && Object.values(state.pcs).filter((p) => p.invite === invite.code).length >= MAX_PCS_PER_INVITE) {
        return refuse(ws, 'too-many', `초대 코드 하나로는 PC를 ${MAX_PCS_PER_INVITE}대까지 연결할 수 있어요.`);
      }
      const name = cleanName(msg.name, 'PC');
      state.pcs[msg.id] = { ...(known || { authHash: hash(msg.auth), createdAt: Date.now() }), invite: invite.code, name, version: String(msg.version || ''), lastSeen: Date.now() };
      save();
      online.get(msg.id)?.ws.close(4000, 'replaced');
      const entry = { ws, invite: invite.code, name };
      online.set(msg.id, entry);
      ws.sendJson({ t: 'ok' });
      log('relay-pc', `${name} 연결됨`);
      // 오래 아무 말이 없으면 끊긴 연결로 보고 닫는다 (PC가 곧 다시 연결한다)
      let heard = Date.now();
      const keepAlive = setInterval(() => {
        if (Date.now() - heard > 90_000) return ws.close(4008, 'silent');
        ws.ping();
      }, 30_000);
      ws.on('pong', () => (heard = Date.now()));
      ws.on('message', (data, binary) => {
        heard = Date.now();
        if (state.pcs[msg.id]) state.pcs[msg.id].lastSeen = heard;
        if (binary || data.length > 8192) return;
        let m2;
        try {
          m2 = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (m2?.t === 'ping') ws.sendJson({ t: 'pong' });
        else if (m2?.t === 'link-claim') ws.sendJson({ t: 'link-claim', rid: m2.rid, ...claimLink(msg.id, m2.name, m2.linkId) });
        else if (m2?.t === 'link-release') releaseLink(msg.id, m2.name);
        else if (m2?.t === 'link-sync' && Array.isArray(m2.links)) syncLinks(msg.id, m2.links);
        else if (m2?.t === 'pair-code') {
          // 이 PC가 다른 곳의 PC와 연결하려고 연결 코드를 만든다 (예전 코드는 지운다)
          for (const [code, entry] of pairCodes) if (entry.pcId === msg.id || entry.expires < Date.now()) pairCodes.delete(code);
          let code;
          do code = newInviteCode();
          while (pairCodes.has(code));
          const expires = Date.now() + PAIR_CODE_MS;
          pairCodes.set(code, { pcId: msg.id, expires });
          ws.sendJson({ t: 'pair-code', code, expires });
        }
      });
      ws.on('close', () => {
        clearInterval(keepAlive);
        if (online.get(msg.id) === entry) online.delete(msg.id);
        save();
      });
    });
  }

// ---- 링크 이름: 중계 서버 안에서 겹치지 않게 PC들이 나눠 쓴다 ----

  function claimLink(pcId, rawName, linkId) {
    const name = cleanLinkName(rawName);
    if (!name || !DROP_ID.test(String(linkId))) return { ok: false, error: '링크 이름을 확인해 주세요.' };
    const owner = state.links[name];
    if (owner && owner.pcId !== pcId) return { ok: false, error: `‘${name}’은(는) 다른 사람이 이미 쓰고 있어요. 다른 이름을 정해 주세요.` };
    if (!owner && Object.values(state.links).filter((l) => l.pcId === pcId).length >= MAX_LINKS_PER_PC) {
      return { ok: false, error: `링크는 PC 하나에 ${MAX_LINKS_PER_PC}개까지예요.` };
    }
    state.links[name] = { pcId, linkId };
    save();
    return { ok: true, name };
  }

  function releaseLink(pcId, rawName) {
    const name = cleanLinkName(rawName);
    if (name && state.links[name]?.pcId === pcId) {
      delete state.links[name];
      save();
    }
  }

  /** PC가 연결할 때 자기 링크 목록을 다시 알려 준다 (중계 서버 자료가 사라졌을 때도 되살아나게) */
  function syncLinks(pcId, links) {
    const keep = new Set();
    for (const { name, linkId } of links.filter((l) => l && typeof l === 'object').slice(0, MAX_LINKS_PER_PC)) {
      const result = claimLink(pcId, name, linkId);
      if (result.ok) keep.add(result.name);
    }
    for (const [name, owner] of Object.entries(state.links)) if (owner.pcId === pcId && !keep.has(name)) delete state.links[name];
    save();
  }

  /** 휴대폰이 들어왔다: PC에 알리고, PC가 따로 연결해 올 때까지 휴대폰 메시지를 모아 둔다 */
  function onPhone(ws, pcId, rawAddress = '') {
    if (!ws) return;
    const pc = online.get(pcId);
    if (!pc) return refuse(ws, 'pc-offline', 'PC의 쏙이 꺼져 있거나 중계 서버에 연결되어 있지 않아요.');
    const waiting = [...pending.values()].filter((p) => p.pcId === pcId).length;
    if ((sessionCount.get(pcId) || 0) + waiting >= MAX_SESSIONS_PER_PC) return refuse(ws, 'busy', '이 PC에 연결된 기기가 너무 많아요.');
    const address = addressKey(rawAddress);
    if ((phonesByAddress.get(address) || 0) >= MAX_PHONES_PER_ADDRESS) return refuse(ws, 'busy', '한 곳에서 너무 많이 연결했어요. 잠시 뒤 다시 해 주세요.');
    phonesByAddress.set(address, (phonesByAddress.get(address) || 0) + 1);
    ws.on('close', () => {
      const left = (phonesByAddress.get(address) || 1) - 1;
      if (left > 0) phonesByAddress.set(address, left);
      else phonesByAddress.delete(address);
    });
    // 첫 인사(암호 통로 시작)가 오지 않는 연결은 자리만 차지하므로 닫는다
    let greeted = false;
    ws.once('message', () => (greeted = true));
    const hello = setTimeout(() => !greeted && ws.close(4008, 'no hello'), HELLO_TIMEOUT_MS);
    hello.unref?.();
    ws.on('close', () => clearTimeout(hello));
    const sid = crypto.randomBytes(16).toString('hex');
    const entry = { phone: ws, pcId, queue: [], queued: 0, invite: pc.invite };
    entry.collect = (data, binary) => {
      entry.queued += data.length;
      if (entry.queued > MAX_QUEUED_BYTES) return ws.close(4009, 'too much before accept');
      entry.queue.push([data, binary]);
    };
    ws.on('message', entry.collect);
    entry.timer = setTimeout(() => {
      pending.delete(sid);
      refuse(ws, 'pc-timeout', 'PC가 응답하지 않아요.');
      // PC가 꺼졌는데 연결이 말없이 남아 있던 것: 닫아 두면 다음 휴대폰은 곧바로 'PC 꺼짐'을 듣고, PC가 살아 있으면 다시 연결해 온다
      if (online.get(pcId) === pc) pc.ws.close(4008, 'no accept');
    }, ACCEPT_TIMEOUT_MS);
    ws.on('close', () => {
      clearTimeout(entry.timer);
      pending.delete(sid);
    });
    pending.set(sid, entry);
    pc.ws.sendJson({ t: 'incoming', sid });
  }

  /** PC가 그 휴대폰 전용으로 연결해 왔다: 둘을 잇는다 */
  function onAccept(ws, sid) {
    firstMessage(ws, (msg) => {
      const entry = pending.get(sid);
      const pc = state.pcs[msg.id];
      if (!entry || msg.t !== 'accept' || entry.pcId !== msg.id || !pc || !sameHash(pc.authHash, hash(msg.auth))) {
        return ws.close(4003, 'bad accept');
      }
      clearTimeout(entry.timer);
      pending.delete(sid);
      entry.phone.off('message', entry.collect);
      pipe(entry.phone, ws, entry);
    });
  }

  function pipe(phone, pc, entry) {
    const invite = state.invites.find((i) => i.code === entry.invite);
    sessionCount.set(entry.pcId, (sessionCount.get(entry.pcId) || 0) + 1);
    if (!sessionsByPc.has(entry.pcId)) sessionsByPc.set(entry.pcId, new Set());
    const pair = [phone, pc];
    sessionsByPc.get(entry.pcId).add(pair);
    live.add(phone).add(pc);
    const forward = (from, to) => {
      from.on('message', (data, binary) => {
        if (invite) invite.bytes = (invite.bytes || 0) + data.length;
        const ok = to.send(binary ? data : data.toString('utf8'));
        if (!ok) {
          // 받는 쪽이 느리면 보내는 쪽을 잠깐 멈춘다 (중계 서버 메모리에 쌓이지 않게)
          from.pause();
          to.once('drain', () => from.resume());
        }
      });
      from.on('close', () => to.close(1000, 'peer closed'));
    };
    for (const [data, binary] of entry.queue) pc.send(binary ? data : data.toString('utf8'));
    forward(phone, pc);
    forward(pc, phone);
    let counted = true;
    const done = () => {
      if (!counted) return;
      counted = false;
      live.delete(phone);
      live.delete(pc);
      sessionsByPc.get(entry.pcId)?.delete(pair);
      sessionCount.set(entry.pcId, Math.max(0, (sessionCount.get(entry.pcId) || 1) - 1));
      save();
    };
    phone.on('close', done);
    pc.on('close', done);
  }

  /** 그 PC로 이어진 연결과 기다리는 연결을 모두 끊는다 */
  function dropSessions(pcId) {
    for (const [phone, pc] of sessionsByPc.get(pcId) || []) {
      phone.close(4003, 'removed');
      pc.close(4003, 'removed');
    }
    for (const [sid, entry] of pending) {
      if (entry.pcId !== pcId) continue;
      pending.delete(sid);
      clearTimeout(entry.timer);
      entry.phone.close(4003, 'removed');
    }
  }

  // ---- 관리 (본가 PC의 관리 화면에서 쓴다) ----

  return {
    server,
    createInvite(label) {
      const invite = { code: newInviteCode(), label: String(label || '').slice(0, 40) || '이름 없음', createdAt: Date.now(), disabled: false, bytes: 0 };
      state.invites.push(invite);
      save();
      return invite;
    },
    setInviteDisabled(code, disabled) {
      const invite = state.invites.find((i) => i.code === code);
      if (!invite) return false;
      invite.disabled = Boolean(disabled);
      save();
      if (invite.disabled) {
        for (const [pcId, entry] of online) {
          if (entry.invite !== code) continue;
          entry.ws.close(4003, 'invite disabled');
          dropSessions(pcId);
        }
      }
      return true;
    },
    removePc(pcId) {
      online.get(pcId)?.ws.close(4003, 'removed');
      dropSessions(pcId);
      delete state.pcs[pcId];
      for (const [linkName, owner] of Object.entries(state.links)) if (owner.pcId === pcId) delete state.links[linkName];
      save();
    },
    /** 지금 이어져 주고받는 중인 휴대폰 수 (업데이트를 미룰지 정할 때 쓴다) */
    activeSessions: () => [...sessionCount.values()].reduce((a, b) => a + b, 0) + rooms.active(),
    /** 홈페이지 주고받기: 암호(숫자 4자리, null이면 끔)와 현황 */
    setWebPin: (pin) => rooms.setPin(pin),
    webOverview: () => rooms.overview(),
    overview() {
      return {
        invites: state.invites.map((i) => ({
          ...i,
          pcs: Object.entries(state.pcs)
            .filter(([, p]) => p.invite === i.code)
            .map(([id, p]) => ({ id, name: p.name, online: online.has(id), lastSeen: p.lastSeen, sessions: sessionCount.get(id) || 0 })),
        })),
      };
    },
    close() {
      for (const entry of online.values()) entry.ws.close(1001, 'server closing');
      for (const entry of pending.values()) entry.phone.close(1001, 'server closing');
      for (const ws of live) ws.close(1001, 'server closing');
      rooms.close();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
