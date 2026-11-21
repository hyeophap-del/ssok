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
import { sendJson, sendText } from './http.js';
import { APP_NAME, APP_ID } from './brand.js';

const PC_ID = /^[0-9a-f]{16}$/;
const SID = /^[0-9a-f]{32}$/;
const MAX_PCS_PER_INVITE = 10;
const MAX_SESSIONS_PER_PC = 16;
const ACCEPT_TIMEOUT_MS = 10_000;
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
 */
export function createRelayServer({ dataDir, publicDir, version, log = () => {} }) {
  const stateFile = path.join(dataDir, 'relay.json');
  let state = { invites: [], pcs: {} };
  try {
    const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (Array.isArray(loaded.invites) && loaded.pcs && typeof loaded.pcs === 'object') state = loaded;
  } catch {
    // 처음 실행
  }
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, stateFile);
    }, 300);
    saveTimer.unref?.();
  };

  const online = new Map(); // PC 번호 → { ws, invite, name }
  const pending = new Map(); // 연결 번호 → { phone, pcId, queue, timer }
  const sessionCount = new Map(); // PC 번호 → 이어진 휴대폰 수
  const live = new Set(); // 이어 둔 웹소켓 (끌 때 닫는다)
  const badTries = new Map(); // 접속한 주소 → { count, since }

  /** Cloudflare 터널 뒤에서는 실제 접속 주소가 이 헤더에 온다 */
  const clientAddress = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  function tooManyTries(address) {
    const entry = badTries.get(address);
    if (!entry) return false;
    if (Date.now() - entry.since > BAD_TRY_WINDOW_MS) {
      badTries.delete(address);
      return false;
    }
    return entry.count >= MAX_BAD_TRIES;
  }
  function countBadTry(address) {
    const entry = badTries.get(address);
    if (!entry || Date.now() - entry.since > BAD_TRY_WINDOW_MS) badTries.set(address, { count: 1, since: Date.now() });
    else entry.count++;
    if (badTries.size > 10_000) badTries.clear(); // 기억할 주소가 너무 많아지면 비운다
  }

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
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
    if (url.pathname === '/api/ping') return sendJson(res, 200, { app: `${APP_ID}-relay`, version });
    // 연결된 다른 PC가 '어디서나'로 보낼 수 있는지(그 PC가 지금 이 중계 서버에 붙어 있는지) 확인할 때
    if ((m = /^\/api\/online\/([0-9a-f]{16})$/.exec(url.pathname))) return sendJson(res, 200, { online: online.has(m[1]) });
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${APP_NAME} 중계 서버</title>` +
          `<body style="font:16px system-ui,sans-serif;margin:40px;color:#16181d"><h1>${APP_NAME} 중계 서버</h1>` +
          `<p>PC의 ${APP_NAME} 화면에 있는 <b>[어디서나]</b> QR 코드를 휴대폰으로 스캔하세요.</p></body>`,
      );
    }
    if ((m = /^\/p\/([0-9a-f]{16})\/?$/.exec(url.pathname))) return servePage(req, res, 'index.html', m[1]);
    if ((m = /^\/p\/([0-9a-f]{16})\/manifest\.webmanifest$/.exec(url.pathname))) return serveManifest(res, m[1]);
    const name = url.pathname.slice(1);
    // 휴대폰 화면에 필요한 파일만 내준다 (HTML은 /p/<PC 번호>로만, 관리 화면 파일은 내주지 않는다)
    const ext = path.extname(name);
    if (/^[A-Za-z0-9._-]+$/.test(name) && STATIC_TYPES[ext] && ext !== '.html' && !name.startsWith('relay-admin')) return servePage(req, res, name);
    return sendText(res, 404, 'Not Found');
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
    if (name === 'index.html') {
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
    if ((m = /^\/ws\/c\/([0-9a-f]{16})$/.exec(url.pathname))) return onPhone(acceptWebSocket(req, socket, head), m[1]);
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
      const name = String(msg.name || 'PC').slice(0, 40);
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
        if (!binary && data.length < 100 && data.toString('utf8').includes('"ping"')) ws.sendJson({ t: 'pong' });
      });
      ws.on('close', () => {
        clearInterval(keepAlive);
        if (online.get(msg.id) === entry) online.delete(msg.id);
        save();
      });
    });
  }

  /** 휴대폰이 들어왔다: PC에 알리고, PC가 따로 연결해 올 때까지 휴대폰 메시지를 모아 둔다 */
  function onPhone(ws, pcId) {
    if (!ws) return;
    const pc = online.get(pcId);
    if (!pc) return refuse(ws, 'pc-offline', 'PC의 쏙이 꺼져 있거나 중계 서버에 연결되어 있지 않아요.');
    if ((sessionCount.get(pcId) || 0) >= MAX_SESSIONS_PER_PC) return refuse(ws, 'busy', '이 PC에 연결된 기기가 너무 많아요.');
    const sid = crypto.randomBytes(16).toString('hex');
    const entry = { phone: ws, pcId, queue: [], invite: pc.invite };
    entry.collect = (data, binary) => entry.queue.push([data, binary]);
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
      sessionCount.set(entry.pcId, Math.max(0, (sessionCount.get(entry.pcId) || 1) - 1));
      save();
    };
    phone.on('close', done);
    pc.on('close', done);
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
        for (const [, entry] of online) if (entry.invite === code) entry.ws.close(4003, 'invite disabled');
      }
      return true;
    },
    removePc(pcId) {
      online.get(pcId)?.ws.close(4003, 'removed');
      delete state.pcs[pcId];
      save();
    },
    /** 지금 이어져 주고받는 중인 휴대폰 수 (업데이트를 미룰지 정할 때 쓴다) */
    activeSessions: () => [...sessionCount.values()].reduce((a, b) => a + b, 0),
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
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
