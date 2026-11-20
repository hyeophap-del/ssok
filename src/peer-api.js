// PC끼리 연결하고 파일·텍스트를 보내는 API
//
// 연결(페어링) 순서
//   1. A 화면에서 [연결]을 누르면 A 서버가 B 서버에 POST /api/pair 를 보낸다 (A의 키와 확인 숫자 포함).
//   2. B 화면에 확인 숫자와 함께 연결 요청 창이 뜬다. 사용자가 두 화면의 숫자가 같은지 보고 [허용]을 누른다.
//   3. B는 A를 저장하고 자기 키를 응답으로 돌려준다. A도 B를 저장한다.
// 그 뒤로는 서로의 키(Authorization: Bearer)로 상대 PC의 /api/upload, /api/text 를 쓴다.
// A 화면 → A 서버 → B 서버로 그대로 흘려보내므로 큰 파일도 A의 디스크에 한 번 더 쓰지 않는다.
import http from 'node:http';
import crypto from 'node:crypto';
import { sendJson, sendEmpty, rejectBody, readJson, plainAddress } from './http.js';
import {
  PEER_ID,
  cleanName,
  isValidKey,
  isValidPort,
  newPairCode,
  newPeerKey,
  pairProof,
  parseAddress,
  pingGalaxy,
  requestJson,
  safeEqual,
} from './peers.js';

const NONCE = /^[0-9a-f]{32}$/;

/**
 * @param {object} options
 * @param {import('./peers.js').PeerBook} options.book
 * @param {() => {id: string, name: string, port: number}} options.self
 * @param {(event: string, data: any) => void} options.broadcastHost   PC 화면에만 보내는 실시간 알림
 * @param {() => boolean} [options.hasHostPage]     PC 화면이 열려 있는지
 * @param {() => void} [options.showHostPage]       연결 요청이 왔는데 PC 화면이 닫혀 있을 때
 * @param {() => void} [options.announce]           주변 PC 다시 찾기
 * @param {number} [options.pairTimeoutMs]     연결 요청을 기다리는 시간
 * @param {number} [options.verifyCooldownMs]  같은 PC의 새 주소를 다시 확인하기까지 기다리는 시간
 * @param {(type: string, payload?: any) => void} [options.log]
 */
export function createPeerApi({
  book,
  self,
  broadcastHost,
  hasHostPage = () => true,
  showHostPage = () => {},
  announce = () => {},
  pairTimeoutMs = 60_000,
  verifyCooldownMs = 10_000,
  log = () => {},
}) {
  let pending = null; // 이 PC에 들어온 연결 요청 (한 번에 하나)
  const lastVerify = new Map();

  const changed = () => broadcastHost('peers', { peers: book.list() });
  const publicRequest = (p) => p && { rid: p.rid, id: p.id, name: p.name, address: p.address, code: p.code };
  const peerHeaders = (peer) => ({
    Authorization: `Bearer ${peer.sendKey}`,
    'X-Galaxy-File-Port': String(self().port),
  });

  // ---- 인증 ----

  /**
   * Authorization: Bearer 키로 온 요청이면 그 PC를 돌려준다. 키가 틀렸으면 null, 키가 없으면 undefined.
   */
  function authenticate(req) {
    const key = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (key === undefined) return undefined;
    const peer = book.byKey(key);
    if (!peer) return null;
    // 키를 가진 진짜 그 PC가 보낸 요청이므로 주소가 바뀌었으면 새 주소를 믿어도 된다
    const address = plainAddress(req.socket.remoteAddress);
    const port = Number(req.headers['x-galaxy-file-port']);
    let moved = book.moveTo(peer.id, address, isValidPort(port) ? port : peer.port);
    moved = book.saw({ id: peer.id, name: peer.name, address: peer.address, port: peer.port }) || moved;
    if (moved) changed();
    return peer;
  }

  // ---- 인증 없이 받는 요청: 연결 요청, 신원 확인 ----

  async function handlePublic(req, res, url) {
    const { pathname } = url;
    if (pathname === '/api/pair' && req.method === 'POST') {
      await receivePairRequest(req, res);
      return true;
    }
    if (pathname === '/api/peer-proof' && req.method === 'GET') {
      const from = url.searchParams.get('from');
      const nonce = url.searchParams.get('nonce');
      const peer = PEER_ID.test(from || '') && NONCE.test(nonce || '') ? book.getPaired(from) : null;
      if (!peer) sendJson(res, 404, { error: '연결된 PC가 아니에요.' });
      else sendJson(res, 200, { id: self().id, proof: pairProof(peer.recvKey, nonce, from, self().id) });
      return true;
    }
    return false;
  }

  async function receivePairRequest(req, res) {
    // 웹사이트가 브라우저를 시켜 몰래 연결 요청을 보내지 못하게 한다 (이 헤더는 스크립트가 다른 사이트로 보낼 수 없다)
    if (req.headers['x-requested-with'] !== 'galaxy-file') {
      rejectBody(req, res);
      return sendJson(res, 403, { error: '허용되지 않은 요청이에요.' });
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      return sendJson(res, 413, { error: '잘못된 요청이에요.' });
    }
    const name = cleanName(body?.name);
    if (!body || !PEER_ID.test(body.id || '') || !name || !isValidPort(body.port) || !isValidKey(body.key) || !/^\d{4}$/.test(body.code || '')) {
      return sendJson(res, 400, { error: '잘못된 연결 요청이에요.' });
    }
    if (body.id === self().id) return sendJson(res, 400, { error: '자기 자신과는 연결할 수 없어요.' });
    if (pending) return sendJson(res, 409, { error: '다른 연결 요청을 처리하는 중이에요.' });

    const request = {
      rid: crypto.randomBytes(8).toString('hex'),
      id: body.id,
      name,
      address: plainAddress(req.socket.remoteAddress),
      port: body.port,
      key: body.key,
      code: body.code,
    };
    const decision = await new Promise((resolve) => {
      pending = { ...request, resolve };
      const timer = setTimeout(() => resolve('timeout'), pairTimeoutMs);
      pending.timer = timer;
      // 요청한 쪽이 기다리다 포기하면(창을 닫는 등) 여기 요청도 거둔다
      res.on('close', () => {
        if (!res.writableFinished) resolve('gone');
      });
      broadcastHost('pair-request', publicRequest(request));
      log('pair-request', publicRequest(request));
      if (!hasHostPage()) showHostPage();
    });
    clearTimeout(pending.timer);
    pending = null;
    broadcastHost('pair-request-done', { rid: request.rid, decision });

    if (decision === 'accept') {
      const recvKey = newPeerKey();
      book.pair({ id: request.id, name, address: request.address, port: request.port, sendKey: request.key, recvKey });
      book.saw({ id: request.id, name, address: request.address, port: request.port });
      changed();
      log('paired', name);
      return sendJson(res, 200, { id: self().id, name: self().name, key: recvKey });
    }
    if (decision === 'deny') return sendJson(res, 403, { error: '상대 PC에서 거절했어요.' });
    if (decision === 'timeout') return sendJson(res, 408, { error: '상대 PC에서 응답이 없어요.' });
    // 'gone': 연결이 이미 끊겼다
  }

  // ---- 인증된 요청 ----

  async function handle(req, res, url, ctx) {
    const { pathname } = url;
    const method = req.method;

    // 연결된 PC가 보내는 요청
    if (pathname === '/api/peer/unpair' && method === 'POST') {
      rejectBody(req, res);
      if (!ctx.peer) {
        sendJson(res, 403, { error: '연결된 PC만 할 수 있어요.' });
        return true;
      }
      book.unpair(ctx.peer.id);
      changed();
      log('unpaired', ctx.peer.name);
      sendEmpty(res);
      return true;
    }

    const isPeerRoute = pathname === '/api/peers' || pathname.startsWith('/api/peers/') || pathname.startsWith('/api/pair-requests/');
    if (!isPeerRoute) return false;
    if (!ctx.isHost) {
      rejectBody(req, res);
      sendJson(res, 403, { error: 'PC 화면에서만 할 수 있어요.' });
      return true;
    }

    if (pathname === '/api/peers' && method === 'GET') {
      sendJson(res, 200, snapshot());
      return true;
    }
    if (pathname === '/api/peers/scan' && method === 'POST') {
      rejectBody(req, res);
      announce();
      refresh();
      sendEmpty(res);
      return true;
    }
    if (pathname === '/api/peers/connect' && method === 'POST') {
      await connectByAddress(req, res);
      return true;
    }

    let m;
    if ((m = /^\/api\/pair-requests\/([0-9a-f]{16})\/(accept|deny)$/.exec(pathname)) && method === 'POST') {
      rejectBody(req, res);
      if (pending?.rid === m[1]) {
        pending.resolve(m[2]);
        sendEmpty(res);
      } else {
        sendJson(res, 404, { error: '이미 끝난 연결 요청이에요.' });
      }
      return true;
    }
    if ((m = /^\/api\/peers\/([0-9a-f]{16})\/pair$/.exec(pathname)) && method === 'POST') {
      rejectBody(req, res);
      startPairing(res, m[1]);
      return true;
    }
    if ((m = /^\/api\/peers\/([0-9a-f]{16})$/.exec(pathname)) && method === 'DELETE') {
      rejectBody(req, res);
      const peer = book.unpair(m[1]);
      if (!peer) {
        sendJson(res, 404, { error: '연결된 PC가 아니에요.' });
        return true;
      }
      changed();
      log('unpaired', peer.name);
      // 상대 PC에도 알린다. 꺼져 있으면 다음에 보낼 때 상대가 알아서 거절한다.
      requestJson(peer, { method: 'POST', path: '/api/peer/unpair', headers: peerHeaders(peer), timeout: 3000 }).catch(() => {});
      sendEmpty(res);
      return true;
    }
    if ((m = /^\/api\/peers\/([0-9a-f]{16})\/(upload|text)$/.exec(pathname)) && method === 'POST') {
      await sendToPeer(req, res, url, m[1], m[2]);
      return true;
    }

    rejectBody(req, res);
    sendJson(res, 404, { error: '없는 주소예요.' });
    return true;
  }

  function snapshot() {
    return { self: { id: self().id, name: self().name }, peers: book.list(), request: publicRequest(pending) };
  }

  // ---- 연결하기 ----

  async function connectByAddress(req, res) {
    let body;
    try {
      body = await readJson(req, 1024);
    } catch {
      return sendJson(res, 413, { error: '잘못된 요청이에요.' });
    }
    const target = parseAddress(body?.address);
    if (!target) return sendJson(res, 400, { error: '주소를 확인해 주세요. 예: 192.168.0.40' });
    const info = await pingGalaxy(target, 3000);
    if (!info) {
      return sendJson(res, 404, { error: `${target.address}에서 Galaxy File을 찾지 못했어요. 그 PC에서 Galaxy File이 켜져 있는지 확인해 주세요.` });
    }
    if (!PEER_ID.test(info.id || '')) return sendJson(res, 400, { error: '그 PC의 Galaxy File을 최신 버전으로 바꿔 주세요.' });
    if (info.id === self().id) return sendJson(res, 400, { error: '이 PC의 주소예요. 다른 PC의 주소를 넣어 주세요.' });
    if (book.saw({ id: info.id, name: cleanName(info.name) || target.address, address: target.address, port: target.port })) changed();
    return sendJson(res, 200, { peer: book.list().find((p) => p.id === info.id) });
  }

  function startPairing(res, id) {
    const target = book.target(id);
    if (!target) return sendJson(res, 404, { error: '그 PC를 찾을 수 없어요. 다시 찾아 주세요.' });
    const code = newPairCode();
    const recvKey = newPeerKey();
    sendJson(res, 202, { code });

    const me = self();
    requestJson(target, {
      method: 'POST',
      path: '/api/pair',
      body: { id: me.id, name: me.name, port: me.port, key: recvKey, code },
      timeout: pairTimeoutMs + 15_000,
    })
      .then(({ status, json }) => {
        if (status === 200 && json?.id === id && isValidKey(json.key)) {
          const name = cleanName(json.name) || target.name;
          book.pair({ id, name, address: target.address, port: target.port, sendKey: json.key, recvKey });
          book.saw({ id, name, address: target.address, port: target.port });
          log('paired', name);
          return { id, ok: true, name };
        }
        const reasons = {
          200: '다른 PC가 응답했어요. 목록을 새로 고친 뒤 다시 시도해 주세요.',
          403: `${target.name}에서 거절했어요.`,
          408: `${target.name}에서 응답이 없어 취소됐어요. 그 PC의 Galaxy File 화면을 연 뒤 다시 시도해 주세요.`,
          409: `${target.name}에서 다른 연결 요청을 처리하는 중이에요. 잠시 뒤 다시 시도해 주세요.`,
        };
        return { id, ok: false, error: reasons[status] || json?.error || '연결하지 못했어요.' };
      })
      .catch(() => ({ id, ok: false, error: `${target.name}에 연결하지 못했어요. 그 PC에서 Galaxy File이 켜져 있는지 확인해 주세요.` }))
      .then((result) => {
        // 화면이 새 목록을 먼저 받아야 결과를 보고 바로 그 PC를 고를 수 있다
        changed();
        broadcastHost('pair-result', result);
      });
  }

  // ---- 연결된 PC로 보내기 ----

  async function sendToPeer(req, res, url, id, kind) {
    const peer = book.getPaired(id);
    if (!peer) {
      rejectBody(req, res);
      return sendJson(res, 404, { error: '연결된 PC가 아니에요. 다시 연결해 주세요.' });
    }
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0) {
      rejectBody(req, res);
      return sendJson(res, 411, { error: '파일 크기를 알 수 없어요.' });
    }

    let targetPath = '/api/text';
    if (kind === 'upload') {
      const params = new URLSearchParams({ name: url.searchParams.get('name') ?? '' });
      const lastModified = url.searchParams.get('lastModified');
      if (lastModified) params.set('lastModified', lastModified);
      targetPath = `/api/upload?${params}`;
    }

    const out = http.request({
      host: peer.address,
      port: peer.port,
      method: 'POST',
      path: targetPath,
      headers: {
        'Content-Length': length,
        'Content-Type': kind === 'text' ? 'application/json' : 'application/octet-stream',
        'X-Requested-With': 'galaxy-file',
        ...peerHeaders(peer),
      },
    });
    // 상대 PC가 30초 동안 아무 반응이 없으면 끊긴 것으로 본다
    out.setTimeout(30_000, () => out.destroy(Object.assign(new Error('시간 초과'), { code: 'ETIMEDOUT' })));

    const outcome = new Promise((resolve) => {
      out.on('response', (peerRes) => {
        const chunks = [];
        peerRes.on('data', (c) => chunks.length < 64 && chunks.push(c));
        peerRes.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // JSON이 아닌 응답
          }
          resolve({ status: peerRes.statusCode, json });
        });
        peerRes.on('error', (error) => resolve({ error }));
      });
      out.on('error', (error) => resolve({ error }));
    });

    // 이 PC 화면에서 취소하면 상대 PC로 가던 전송도 멈춘다 (상대는 받다 만 파일을 지운다)
    res.on('close', () => {
      if (!res.writableFinished) out.destroy();
    });
    req.on('error', () => out.destroy());
    req.pipe(out);

    const result = await outcome;
    if (res.destroyed) return;
    // 상대가 도중에 거절했으면 아직 들어오는 본문을 더 받지 않는다
    if (!req.complete) {
      req.unpipe(out);
      rejectBody(req, res);
    }

    if (result.error) {
      if (book.lost(peer.id)) changed();
      announce();
      return sendJson(res, 502, { error: `${peer.name}에 보내지 못했어요. 그 PC에서 Galaxy File이 켜져 있는지 확인해 주세요.` });
    }
    if (result.status === 401) {
      // 상대 PC에서 연결을 해제했다
      book.unpair(peer.id);
      changed();
      return sendJson(res, 409, { error: `${peer.name}에서 연결이 해제됐어요. 다시 연결해 주세요.` });
    }
    if (result.status < 200 || result.status >= 300) {
      return sendJson(res, result.status, { error: `${peer.name}: ${result.json?.error || '보내지 못했어요.'}` });
    }
    if (book.saw({ id: peer.id, name: peer.name, address: peer.address, port: peer.port })) changed();
    log('peer-sent', { to: peer.name, item: result.json });
    return sendJson(res, 201, { ok: true, to: peer.name });
  }

  // ---- 상대 PC가 켜져 있는지, 주소가 바뀌었는지 ----

  /** UDP로 다른 PC를 발견했을 때 */
  function discovered(info) {
    const paired = book.getPaired(info.id);
    if (!paired || (paired.address === info.address && paired.port === info.port)) {
      if (book.saw(info)) changed();
      return;
    }
    // 연결해 둔 PC가 다른 주소에서 나타났다. UDP 알림은 누구나 꾸밀 수 있으므로
    // 그 주소의 PC가 우리끼리만 아는 키를 갖고 있는지 확인한 뒤에만 새 주소를 쓴다.
    const now = Date.now();
    if (now - (lastVerify.get(info.id) || 0) < verifyCooldownMs) return;
    lastVerify.set(info.id, now);
    verifyAt(paired, info.address, info.port).then((ok) => {
      if (!ok) return;
      book.moveTo(info.id, info.address, info.port);
      book.saw(info);
      changed();
    });
  }

  async function verifyAt(peer, address, port) {
    const nonce = crypto.randomBytes(16).toString('hex');
    try {
      const { status, json } = await requestJson(
        { address, port },
        { path: `/api/peer-proof?from=${self().id}&nonce=${nonce}`, timeout: 3000 },
      );
      return status === 200 && json?.id === peer.id && safeEqual(json.proof, pairProof(peer.sendKey, nonce, self().id, peer.id));
    } catch {
      return false;
    }
  }

  /** 연결된 PC들이 켜져 있는지 HTTP로 확인한다 (UDP가 막힌 네트워크에서도 상태가 맞도록) */
  async function refresh() {
    const before = book.signature();
    await Promise.all(
      [...book.paired.values()].map(async (peer) => {
        const info = await pingGalaxy(peer);
        if (info?.id === peer.id) book.saw({ id: peer.id, name: cleanName(info.name) || peer.name, address: peer.address, port: peer.port });
        else book.lost(peer.id);
      }),
    );
    if (book.signature() !== before) changed();
  }

  function close() {
    pending?.resolve('closing');
  }

  return { authenticate, handlePublic, handle, snapshot, discovered, refresh, close };
}
