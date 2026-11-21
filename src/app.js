import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { sanitizeFilename, moveIntoPlace, mimeOf, isInlineSafe, contentDisposition } from './files.js';
import { isAllowedHost, isOwnAddress } from './net.js';
import { encodeQR, toSvg } from './qr.js';
import { sendJson, sendText, sendEmpty, rejectBody, readBody } from './http.js';
import { safeEqual } from './peers.js';
import { createPeerApi } from './peer-api.js';
import { createDualServer } from './tls.js';
import { APP_NAME, APP_ID } from './brand.js';

import pkg from '../package.json' with { type: 'json' };

export const VERSION = pkg.version;
/** 안드로이드 앱 버전 번호 (android/build.mjs와 같은 계산: 1.2.3 → 10203) */
const ANDROID_VERSION_CODE = (([a, b, c]) => a * 10000 + b * 100 + c)(VERSION.split('.').map(Number));
const COOKIE = APP_ID;
const LEGACY_COOKIE = 'gf'; // 예전 이름(Galaxy File) 때 휴대폰에 저장된 쿠키도 받아 준다
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // 브라우저가 허용하는 최대치(400일)
const MAX_TEXT = 100_000;
const PART_SUFFIX = `.${APP_ID}-part`;
const PART_FILE = new RegExp(`^\\.[0-9a-f]{16}\\.${APP_ID}-part$`);

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

// 내려받는 파일이 브라우저에서 열려도 이 사이트의 권한(쿠키·API)을 쓰지 못하게 격리한다.
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

const TEMPLATED = new Set(['.html', '.js', '.webmanifest']);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.apk': 'application/vnd.android.package-archive', // 휴대폰에 내려주는 쏙 안드로이드 앱
};

export const newId = () => crypto.randomBytes(8).toString('hex');
export const newToken = () => crypto.randomBytes(9).toString('base64url');

export function isPartialUpload(fileName) {
  return PART_FILE.test(fileName);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // 잘못된 쿠키는 무시
    }
  }
  return cookies;
}

export function deviceLabel(ua = '') {
  if (/iPhone/i.test(ua) || /CFNetwork|Darwin/i.test(ua)) return 'iPhone'; // CFNetwork: 아이폰 '단축어' 앱
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? '휴대폰' : '태블릿';
  if (/Windows/i.test(ua)) return '다른 PC';
  if (/Macintosh/i.test(ua)) return 'Mac';
  return '다른 기기';
}

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
};

/** 이름 없이 온 파일의 이름: "iPhone 2026-11-21 003612.jpg" */
function autoName(device, type) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return sanitizeFilename(`${device} ${stamp}.${EXTENSIONS[type] || 'bin'}`);
}

function publicItem(item) {
  const base = { id: item.id, kind: item.kind, from: item.from, device: item.device, createdAt: item.createdAt };
  if (item.kind === 'text') return { ...base, text: item.text };
  return { ...base, name: item.name, size: item.size, mime: mimeOf(item.name) };
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function freeSpace(dir) {
  try {
    const stat = await fsp.statfs(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.token          휴대폰 접속용 비밀 토큰 (QR 코드에 들어간다)
 * @param {string} options.receivedDir    휴대폰에서 받은 파일을 저장할 폴더
 * @param {string} options.outboxDir      PC에서 휴대폰으로 보낼 파일을 잠시 두는 폴더
 * @param {import('./store.js').Store} options.store
 * @param {string} options.publicDir      웹 화면 파일 폴더
 * @param {() => {address: string, iface: string}[]} [options.lanAddresses]
 * @param {(remoteAddress: string) => boolean} [options.isHostAddress]  요청이 이 PC에서 왔는지
 * @param {{ open: (p: string) => void, reveal: (p: string) => void }} [options.opener]
 * @param {() => string[]} [options.warnings]  PC 화면에 띄울 안내 (예: 공용 네트워크 경고)
 * @param {{id: string, name: string}} [options.self]  다른 PC에 보일 이 PC의 이름과 고유 번호
 * @param {{key: string, cert: string, fingerprint: string}} [options.tls]  이 PC의 인증서. 있으면 같은 포트에서 HTTPS도 받는다.
 * @param {import('./peers.js').PeerBook} [options.peerBook]  연결된 기기 목록. tls와 함께 있어야 기기끼리 연결 기능이 켜진다.
 * @param {() => void} [options.announce]       주변 PC 다시 찾기
 * @param {() => void} [options.showHostPage]   연결 요청이 왔는데 PC 화면이 닫혀 있을 때 화면 열기
 * @param {{pairTimeoutMs?: number, verifyCooldownMs?: number}} [options.peerOptions]  테스트용 시간 설정
 * @param {{get: () => object, set: (patch: object) => Promise<void>}} [options.settings]  PC 화면의 설정 (이름, 자동 실행)
 * @param {() => void} [options.onQuit]  PC 화면에서 '끄기'를 눌렀을 때
 * @param {(type: string, payload?: any) => void} [options.log]
 */
export function createApp(options) {
  const {
    token,
    receivedDir,
    outboxDir,
    store,
    publicDir,
    lanAddresses = () => [],
    tailscaleAddress = () => null, // Tailscale을 켜 두었으면 집 밖에서도 들어올 수 있는 주소
    isHostAddress = (addr) => isOwnAddress(addr),
    opener = { open() {}, reveal() {} },
    warnings = () => [],
    self = { id: undefined, name: undefined },
    tls = null,
    peerBook = null,
    announce = () => {},
    showHostPage = () => {},
    peerOptions = {},
    settings = null,
    onQuit = null,
    updater = null, // { state(), check(), apply() } — exe로 설치했을 때만
    onShow = null, // PC 화면 창을 열거나 앞으로 가져오기 (시작 메뉴로 다시 실행했을 때)
    openLog = null, // 접속 코드를 가린 실행 기록을 열기 (문제가 생겼을 때 보내 달라고 할 파일)
    onHostPagesClosed = () => {}, // 열려 있던 PC 화면이 모두 닫혔을 때
    log = () => {},
  } = options;

  const clients = new Set();
  const selfInfo = () => ({ id: self.id, name: self.name, port: server.address()?.port });
  const peers =
    peerBook && tls
    ? createPeerApi({
        book: peerBook,
        self: selfInfo,
        identity: tls,
        broadcastHost,
        hasHostPage: () => [...clients].some((c) => c.isHost),
        showHostPage,
        announce,
        log,
        ...peerOptions,
      })
    : null;
  const staticFiles = new Map();
  for (const name of fs.readdirSync(publicDir)) {
    const type = STATIC_TYPES[path.extname(name)];
    if (type) staticFiles.set(name, { path: path.join(publicDir, name), type });
  }

  const onRequest = (req, res) => {
    handle(req, res).catch((err) => {
      log('error', err);
      if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했어요.' });
      else res.destroy();
    });
  };
  const httpServer = http.createServer(onRequest);
  const httpsServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, onRequest) : null;
  for (const s of [httpServer, httpsServer].filter(Boolean)) {
    // 큰 동영상 업로드가 몇 분씩 걸려도 끊기지 않게 한다 (Node 기본값은 5분).
    s.requestTimeout = 0;
    s.headersTimeout = 60_000;
  }
  // 휴대폰 브라우저는 http://, 다른 PC와 앱은 https://로 같은 포트에 접속한다
  const server = httpsServer ? createDualServer(httpServer, httpsServer) : httpServer;

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!isAllowedHost(req.headers.host)) {
      rejectBody(req, res);
      return sendText(res, 421, 'Misdirected Request');
    }
    const url = new URL(req.url, 'http://localhost');
    const ctx = authenticate(req, url);
    if (url.pathname.startsWith('/api/')) return api(req, res, url, ctx);
    return serveStatic(req, res, url, ctx);
  }

  function authenticate(req, url) {
    // 연결해 둔 다른 PC는 서로 주고받은 키로 들어온다. 같은 PC에서 왔더라도 'PC 화면' 권한은 주지 않는다.
    const peer = peers?.authenticate(req);
    if (peer !== undefined) {
      return { isHost: false, authed: Boolean(peer), peer, giveCookie: false, device: peer?.name ?? '다른 PC' };
    }
    const isHost = isHostAddress(req.socket.remoteAddress);
    // PC 자신의 요청이라도 다른 웹사이트가 몰래 보낸 요청이면 믿지 않는다.
    const site = req.headers['sec-fetch-site'];
    const trustedSite = !site || site === 'same-origin' || site === 'none';
    const cookies = parseCookies(req.headers.cookie);
    const cookieOk = safeEqual(cookies[COOKIE], token) || safeEqual(cookies[LEGACY_COOKIE], token);
    const queryOk = safeEqual(url.searchParams.get('k') ?? undefined, token);
    return {
      isHost,
      authed: cookieOk || queryOk || (isHost && trustedSite),
      giveCookie: queryOk && !cookieOk,
      // 주소에 접속 코드를 담아 보낸 요청(아이폰 단축어 등). 브라우저가 몰래 붙여 보내는 쿠키가 아니므로 CSRF 걱정이 없다.
      byQuery: queryOk,
      device: isHost ? 'PC' : deviceLabel(req.headers['user-agent']),
    };
  }

  async function api(req, res, url, ctx) {
    const { pathname } = url;
    const method = req.method;
    res.setHeader('Cache-Control', 'no-store');

    if (pathname === '/api/ping') {
      rejectBody(req, res);
      // 이 PC에서 물어보면 실행 파일 위치도 알려 준다 (새 버전 exe가 예전 것을 바꿀 때 쓴다)
      return sendJson(res, 200, {
        app: APP_ID,
        version: VERSION,
        id: self.id,
        name: self.name,
        // 휴대폰 앱이 새 버전이 있는지 알 수 있게 이 PC가 가진 앱 버전을 알려 준다
        ...(staticFiles.has(`${APP_ID}.apk`) ? { android: ANDROID_VERSION_CODE } : {}),
        // 이 PC에 닿을 수 있는 주소들. 휴대폰 앱이 기억해 두었다가 지금 주소가 안 되면(집 밖 등) 차례로 써 본다.
        addrs: [...lanAddresses().map((a) => a.address), ...[tailscaleAddress()?.address].filter(Boolean)],
        // 이 PC에서 물어보면 실행 파일 위치도 알려 준다 (새 버전 exe가 예전 것을 바꿀 때 쓴다)
        ...(ctx.isHost ? { exe: process.execPath } : {}),
      });
    }
    if (peers && (await peers.handlePublic(req, res, url))) return;
    if (!ctx.authed) {
      rejectBody(req, res);
      return sendJson(res, 401, { error: 'PC 화면의 QR 코드를 다시 스캔해 주세요.' });
    }
    if (method !== 'GET' && method !== 'HEAD' && !ctx.byQuery) {
      // 다른 사이트가 보낸 위조 요청(CSRF) 차단: 이 헤더는 같은 출처의 스크립트만 붙일 수 있다.
      const origin = req.headers.origin;
      if (req.headers['x-requested-with'] !== APP_ID || (origin && origin !== `http://${req.headers.host}`)) {
        rejectBody(req, res);
        return sendJson(res, 403, { error: '허용되지 않은 요청이에요.' });
      }
    }

    if (peers && (await peers.handle(req, res, url, ctx))) return;
    if (pathname === '/api/session' && method === 'GET') return sendJson(res, 200, session(ctx, req));
    if (pathname === '/api/items' && method === 'GET') return sendJson(res, 200, { items: store.list().map(publicItem) });
    if (pathname === '/api/events' && method === 'GET') return events(req, res, ctx);
    if (pathname === '/api/upload' && method === 'POST') return upload(req, res, url, ctx);
    if (pathname === '/api/text' && method === 'POST') return postText(req, res, ctx);
    if (pathname === '/api/settings' && (method === 'GET' || method === 'POST')) return settingsApi(req, res, ctx);
    if (pathname.startsWith('/api/update')) return updateApi(req, res, url, ctx);
    if (pathname === '/api/open-log' && method === 'POST') {
      rejectBody(req, res);
      if (!ctx.isHost || !openLog) return sendJson(res, 403, { error: 'PC 화면에서만 할 수 있어요.' });
      try {
        openLog();
      } catch (err) {
        return sendJson(res, err.status || 500, { error: err.status ? err.message : '기록을 열지 못했어요.' });
      }
      return sendEmpty(res);
    }
    if (pathname === '/api/show' && method === 'POST') {
      rejectBody(req, res);
      if (!ctx.isHost || !onShow) return sendJson(res, 403, { error: 'PC에서만 할 수 있어요.' });
      onShow();
      return sendEmpty(res);
    }
    if (pathname === '/api/quit' && method === 'POST') {
      rejectBody(req, res);
      if (!ctx.isHost || !onQuit) return sendJson(res, 403, { error: 'PC 화면에서만 할 수 있어요.' });
      res.on('finish', () => setTimeout(onQuit, 100));
      return sendEmpty(res);
    }
    if (pathname === '/api/open-folder' && method === 'POST') {
      rejectBody(req, res);
      if (!ctx.isHost) return sendJson(res, 403, { error: 'PC에서만 할 수 있어요.' });
      opener.open(receivedDir);
      return sendEmpty(res);
    }

    let m;
    if ((m = /^\/api\/files\/([0-9a-f]{16})$/.exec(pathname)) && (method === 'GET' || method === 'HEAD')) {
      return download(req, res, url, m[1]);
    }
    if ((m = /^\/api\/items\/([0-9a-f]{16})$/.exec(pathname)) && method === 'DELETE') {
      rejectBody(req, res);
      return removeItem(res, m[1]);
    }
    if ((m = /^\/api\/items\/([0-9a-f]{16})\/(open|reveal)$/.exec(pathname)) && method === 'POST') {
      rejectBody(req, res);
      return openOnHost(res, ctx, m[1], m[2]);
    }

    rejectBody(req, res);
    return sendJson(res, 404, { error: '없는 주소예요.' });
  }

  function session(ctx, req) {
    const info = { app: APP_ID, version: VERSION, isHost: ctx.isHost, device: ctx.device, androidApp: staticFiles.has(`${APP_ID}.apk`) };
    if (!ctx.isHost) {
      // 아이폰 단축어에 넣을 보내기 주소. 이 휴대폰은 이미 이 접속 코드로 들어와 있으므로 새로 알려 주는 것은 없다.
      return ctx.peer ? info : { ...info, shortcutUrl: `http://${req.headers.host}/api/upload?k=${token}` };
    }
    const port = server.address().port;
    const addresses = lanAddresses().map(({ address, iface }) => {
      const url = `http://${address}:${port}/?k=${token}`;
      return { address, iface, url, qrSvg: toSvg(encodeQR(url)) };
    });
    const ts = tailscaleAddress();
    const anywhere = ts && { address: ts.address, url: `http://${ts.address}:${port}/?k=${token}` };
    if (anywhere) anywhere.qrSvg = toSvg(encodeQR(anywhere.url));
    return {
      ...info,
      receivedDir,
      addresses,
      tailscale: anywhere || null,
      port,
      name: self.name,
      peerSupport: Boolean(peers),
      settings: settings?.get() ?? null,
      canOpenLog: Boolean(openLog),
      update: updater?.state() ?? null,
      canQuit: Boolean(onQuit),
      warnings: warnings(),
    };
  }

  /** 새 버전 확인·업데이트 (PC 화면에서만) */
  async function updateApi(req, res, url, ctx) {
    rejectBody(req, res);
    if (!ctx.isHost) return sendJson(res, 403, { error: 'PC 화면에서만 할 수 있어요.' });
    if (!updater) return sendJson(res, 404, { error: '이 설치 방식에서는 자동 업데이트를 쓸 수 없어요.' });
    if (url.pathname === '/api/update' && req.method === 'GET') return sendJson(res, 200, updater.state());
    if (url.pathname === '/api/update/check' && req.method === 'POST') return sendJson(res, 200, await updater.check());
    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      if (!updater.state().available) return sendJson(res, 409, { error: '새 버전이 없어요.' });
      // 내려받는 동안의 진행률은 실시간 알림('update')으로 보낸다
      updater.apply().catch((err) => log('error', err));
      return sendJson(res, 202, updater.state());
    }
    return sendJson(res, 404, { error: '없는 주소예요.' });
  }

  async function settingsApi(req, res, ctx) {
    if (!ctx.isHost || !settings) {
      rejectBody(req, res);
      return sendJson(res, 403, { error: 'PC 화면에서만 할 수 있어요.' });
    }
    if (req.method === 'POST') {
      let patch;
      try {
        patch = JSON.parse(await readBody(req, 4096));
      } catch {
        return sendJson(res, 400, { error: '잘못된 요청이에요.' });
      }
      try {
        await settings.set({
          name: typeof patch?.name === 'string' ? patch.name : undefined,
          autostart: typeof patch?.autostart === 'boolean' ? patch.autostart : undefined,
          autoUpdate: typeof patch?.autoUpdate === 'boolean' ? patch.autoUpdate : undefined,
        });
      } catch (err) {
        if (!err.status) log('error', err);
        return sendJson(res, err.status || 500, { error: err.status ? err.message : '설정을 바꾸지 못했어요.' });
      }
    }
    return sendJson(res, 200, settings.get());
  }

  // ---- 실시간 알림 (Server-Sent Events) ----

  function writeEvent(res, event, data) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(event, data) {
    for (const client of clients) writeEvent(client.res, event, data);
  }

  /** PC 화면에만 보내는 알림 (다른 PC 목록, 연결 요청) */
  function broadcastHost(event, data) {
    for (const client of clients) if (client.isHost) writeEvent(client.res, event, data);
  }

  function presence() {
    const remotes = [...clients].filter((c) => !c.isHost).map((c) => c.device);
    return { remotes };
  }

  function events(req, res, ctx) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const client = { res, isHost: ctx.isHost, device: ctx.device };
    clients.add(client);
    writeEvent(res, 'snapshot', {
      items: store.list().map(publicItem),
      presence: presence(),
      ...(ctx.isHost && peers ? peers.snapshot() : {}),
    });
    broadcast('presence', presence());
    if (!ctx.isHost) log('connect', ctx.device);

    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
      broadcast('presence', presence());
      // 새로 고침이 아니라 정말 창을 닫았는지 잠깐 기다려 본다
      if (client.isHost && !hasHostPage()) setTimeout(() => !hasHostPage() && onHostPagesClosed(), 4000).unref();
    });
  }

  // ---- 항목 관리 ----

  async function cleanupItem(item) {
    if (item.kind !== 'file' || item.from !== 'host') return;
    const dir = path.dirname(item.path);
    if (isInside(outboxDir, dir)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  function addItem(item) {
    const evicted = store.add(item);
    for (const old of evicted) {
      cleanupItem(old);
      broadcast('remove', { id: old.id });
    }
    broadcast('add', publicItem(item));
    log('add', item);
  }

  async function upload(req, res, url, ctx) {
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) {
      rejectBody(req, res);
      return sendJson(res, 411, { error: '파일 크기를 알 수 없어요.' });
    }
    // 아이폰 '단축어'처럼 이름 없이 보내면: 짧은 텍스트는 텍스트 항목으로, 나머지는 종류와 시각으로 이름을 붙인다
    const rawName = url.searchParams.get('name');
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (rawName === null && type === 'text/plain' && size <= MAX_TEXT * 4) {
      let text;
      try {
        text = await readBody(req, MAX_TEXT * 4);
      } catch {
        return sendJson(res, 413, { error: '텍스트가 너무 길어요.' });
      }
      return addText(res, ctx, text);
    }
    const name = rawName === null ? autoName(ctx.device, type) : sanitizeFilename(rawName);
    const lastModified = Number(url.searchParams.get('lastModified'));
    const id = newId();
    const dir = ctx.isHost ? path.join(outboxDir, id) : receivedDir;
    await fsp.mkdir(dir, { recursive: true });

    const free = await freeSpace(dir);
    if (free !== null && size > free) {
      rejectBody(req, res);
      if (ctx.isHost) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      return sendJson(res, 507, { error: 'PC 저장 공간이 부족해요.' });
    }

    const tmp = path.join(dir, `.${id}${PART_SUFFIX}`);
    const discard = async () => {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (ctx.isHost) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      await pipeline(req, fs.createWriteStream(tmp, { flags: 'wx' }));
    } catch (err) {
      await discard();
      if (['ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(err.code)) {
        log('upload-cancelled', name);
        return; // 보내는 쪽이 취소했거나 연결이 끊겼다
      }
      // 디스크 쓰기 오류 등. pipeline이 연결을 이미 끊었을 수 있어서 응답은 보낼 수 있을 때만 보낸다.
      log('error', err);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: err.code === 'ENOSPC' ? 'PC 저장 공간이 부족해요.' : '파일을 저장하지 못했어요.' });
      }
      return;
    }

    let finalPath;
    try {
      const { size: written } = await fsp.stat(tmp);
      if (written !== size) throw Object.assign(new Error('파일이 끝까지 전송되지 않았어요.'), { status: 400 });
      finalPath = await moveIntoPlace(tmp, dir, name);
    } catch (err) {
      await discard();
      if (!err.status) log('error', err);
      return sendJson(res, err.status || 500, { error: err.status ? err.message : '파일을 저장하지 못했어요.' });
    }

    if (Number.isFinite(lastModified) && lastModified > 0) {
      // 사진 찍은 날짜 같은 원래 수정 시각을 유지한다
      await fsp.utimes(finalPath, new Date(), new Date(lastModified)).catch(() => {});
    }

    const item = {
      id,
      kind: 'file',
      from: ctx.isHost ? 'host' : ctx.peer ? 'peer' : 'remote',
      device: ctx.device,
      name: path.basename(finalPath),
      size,
      path: finalPath,
      createdAt: Date.now(),
    };
    addItem(item);
    return sendJson(res, 201, publicItem(item));
  }

  async function postText(req, res, ctx) {
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_TEXT * 4 + 1024));
    } catch (err) {
      if (err.code === 'TOO_LARGE') return sendJson(res, 413, { error: '텍스트가 너무 길어요. 파일로 보내 주세요.' });
      return sendJson(res, 400, { error: '잘못된 요청이에요.' });
    }
    return addText(res, ctx, typeof body?.text === 'string' ? body.text : '');
  }

  function addText(res, ctx, raw) {
    const text = raw.replace(/\r\n?/g, '\n');
    if (!text.trim()) return sendJson(res, 400, { error: '보낼 내용이 없어요.' });
    if (text.length > MAX_TEXT) return sendJson(res, 413, { error: '텍스트가 너무 길어요. 파일로 보내 주세요.' });

    const item = {
      id: newId(),
      kind: 'text',
      from: ctx.isHost ? 'host' : ctx.peer ? 'peer' : 'remote',
      device: ctx.device,
      text,
      createdAt: Date.now(),
    };
    addItem(item);
    return sendJson(res, 201, publicItem(item));
  }

  async function removeItem(res, id) {
    const item = store.remove(id);
    if (!item) return sendJson(res, 404, { error: '이미 지워진 항목이에요.' });
    await cleanupItem(item);
    broadcast('remove', { id });
    log('remove', item);
    sendEmpty(res);
  }

  function openOnHost(res, ctx, id, action) {
    if (!ctx.isHost) return sendJson(res, 403, { error: 'PC에서만 할 수 있어요.' });
    const item = store.get(id);
    if (!item || item.kind !== 'file' || !fs.existsSync(item.path)) {
      return sendJson(res, 404, { error: 'PC에서 파일이 옮겨지거나 지워졌어요.' });
    }
    opener[action](item.path);
    return sendEmpty(res);
  }

  async function download(req, res, url, id) {
    const item = store.get(id);
    if (!item || item.kind !== 'file') return sendJson(res, 404, { error: '항목을 찾을 수 없어요.' });

    let stat;
    try {
      stat = await fsp.stat(item.path);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      return sendJson(res, 404, { error: 'PC에서 파일이 옮겨지거나 지워졌어요.' });
    }

    const mime = mimeOf(item.name);
    const inline = url.searchParams.get('inline') === '1' && isInlineSafe(mime);
    const headers = {
      'Content-Type': mime,
      'Content-Disposition': contentDisposition(item.name, inline),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=600',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    // PDF 뷰어는 sandbox 안에서 열리지 않는다. PDF는 스크립트를 이 사이트 권한으로 실행하지 않으므로 예외로 둔다.
    if (mime !== 'application/pdf') headers['Content-Security-Policy'] = FILE_CSP;

    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || '').trim());
    if (range && (range[1] || range[2]) && stat.size > 0) {
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      } else {
        start = Math.max(0, stat.size - Number(range[2]));
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || stat.size === 0) return res.end();
    try {
      await pipeline(fs.createReadStream(item.path, { start, end }), res);
    } catch {
      // 받는 쪽이 중간에 끊었다
    }
  }

  // ---- 웹 화면 ----

  async function serveStatic(req, res, url, ctx) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectBody(req, res);
      return sendText(res, 405, 'Method Not Allowed');
    }
    let name = 'index.html';
    if (url.pathname !== '/') {
      try {
        name = decodeURIComponent(url.pathname.slice(1));
      } catch {
        name = '';
      }
    }
    const file = staticFiles.get(name);
    if (!file) return sendText(res, 404, 'Not Found');

    const headers = { 'Content-Type': file.type, 'Cache-Control': 'no-cache' };
    if (name.endsWith('.apk')) headers['Content-Disposition'] = `attachment; filename="${name}"`;
    if (name === 'index.html') {
      headers['Content-Security-Policy'] = PAGE_CSP;
      headers['X-Frame-Options'] = 'DENY';
      if (ctx.giveCookie) {
        headers['Set-Cookie'] = `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`;
      }
    }
    let body = await fsp.readFile(file.path);
    if (TEMPLATED.has(path.extname(name))) {
      // 화면 파일 안의 {{APP_NAME}}, {{APP_ID}}를 실제 이름으로 바꿔서 보낸다 (이름은 brand.js 한 곳에서 관리)
      body = Buffer.from(body.toString('utf8').replaceAll('{{APP_NAME}}', APP_NAME).replaceAll('{{APP_ID}}', APP_ID));
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function close() {
    peers?.close();
    for (const client of clients) client.res.end();
    clients.clear();
    const closed = new Promise((resolve) => server.close(() => resolve()));
    for (const s of [httpServer, httpsServer].filter(Boolean)) {
      s.closeAllConnections();
      if (s !== server) s.close(() => {}); // 시간 제한 감시를 멈춘다
    }
    return closed;
  }

  function hasHostPage() {
    return [...clients].some((c) => c.isHost);
  }

  return { server, broadcast, broadcastHost, close, clients, peers, hasHostPage };
}
