// 다른 기기(PC, 휴대폰 앱)와 연결하고, 연결된 PC로 파일·텍스트를 보내는 API.
// 기기끼리는 항상 HTTPS로 주고받고, 연결할 때 받은 상대 인증서로 고정해서 확인한다.
//
// 연결(페어링) 순서 — A가 B에 연결을 요청할 때
//   1. A → B  POST /api/pair/start  { A 정보, A 인증서, A가 B에게 주는 키, 봉인한 난수 H(Na) }
//             B는 자기 난수 Nb로 답한다. A는 이 연결에서 B의 인증서를 받아 둔다.
//   2. A → B  POST /api/pair/finish { Na }  (1에서 받은 B 인증서로 고정한 연결)
//             B는 봉인이 맞는지 확인하고 6자리 확인 숫자를 화면에 띄워 [허용]을 기다린다.
//             A 화면에도 같은 방식으로 계산한 숫자가 떠 있다. 중간에 누가 끼어들면 숫자가 어긋난다.
//   3. 허용하면 B는 A를 저장하고 자기 키를 돌려준다. A도 B를 저장한다.
// 그 뒤로는 서로 받은 키(Authorization: Bearer)로 상대의 /api/upload, /api/text 를 쓴다.
// 휴대폰 앱도 같은 순서로 연결한다. 앱은 서버가 아니므로 인증서 대신 앱 고유 번호를 신원으로 쓴다.
//
// 어디서나(중계 서버): 연결할 때 서로의 중계 서버 주소도 알려 둔다. 같은 네트워크에서 상대가 안 보이면
// 상대의 중계 서버를 거쳐 보낸다. 통로는 나눠 가진 키에서 만든 열쇠로 종단간 암호화한다 (public/relay.js).
import https from 'node:https';
import { sendJson, sendEmpty, rejectBody, readJson, plainAddress } from './http.js';
import { APP_NAME, APP_ID } from './brand.js';
import { fingerprintOf, isValidCert, pinnedTlsOptions } from './tls.js';
import { RelayClient } from '../public/relay.js';
import { openTunnel } from './relay-tunnel.js';
import {
  NONCE,
  PEER_ID,
  cleanName,
  cleanRelayUrl,
  isValidKey,
  isValidPort,
  newNonce,
  newPeerKey,
  pairChannelSecret,
  pairCode,
  parseAddress,
  parseRemoteCode,
  peerRelaySecret,
  pingApp,
  requestJson,
  sha256,
} from './peers.js';

const COMMIT = /^[0-9a-f]{64}$/;
const COMMIT_TIMEOUT_MS = 15_000; // 1단계 뒤 2단계가 이 시간 안에 오지 않으면 요청을 버린다
const INFO_INTERVAL_MS = 5 * 60_000; // 같은 네트워크의 연결된 PC에게 중계 서버 주소가 바뀌었는지 묻는 간격
const CHANNEL_IDLE_MS = 60_000; // 중계 통로를 쓰지 않으면 이 시간 뒤에 닫는다

/**
 * @param {object} options
 * @param {import('./peers.js').PeerBook} options.book
 * @param {() => {id: string, name: string, port: number}} options.self
 * @param {{key: string, cert: string, fingerprint: string}} options.identity  이 PC의 인증서
 * @param {(event: string, data: any) => void} options.broadcastHost   PC 화면에만 보내는 실시간 알림
 * @param {() => boolean} [options.hasHostPage]     PC 화면이 열려 있는지
 * @param {() => void} [options.showHostPage]       연결 요청이 왔는데 PC 화면이 닫혀 있을 때
 * @param {() => void} [options.announce]           주변 PC 다시 찾기
 * @param {number} [options.pairTimeoutMs]     연결 요청을 기다리는 시간
 * @param {number} [options.verifyCooldownMs]  같은 PC의 새 주소를 다시 확인하기까지 기다리는 시간
 * @param {() => string|null} [options.relayUrl]  이 PC가 쓰는 중계 서버 주소 (연결된 PC에게 알려 준다)
 * @param {boolean} [options.allowLocalRelay]    시험용: http://127.0.0.1 중계 서버 주소도 받는다
 * @param {() => Promise<{code: string, expires: number}>} [options.relayPairCode]  다른 곳의 PC가 연결할 때 넣을 코드 받기
 * @param {(type: string, payload?: any) => void} [options.log]
 */
export function createPeerApi({
  book,
  self,
  identity,
  broadcastHost,
  hasHostPage = () => true,
  showHostPage = () => {},
  announce = () => {},
  pairTimeoutMs = 60_000,
  verifyCooldownMs = 10_000,
  relayUrl = () => null,
  allowLocalRelay = false,
  relayPairCode = null,
  log = () => {},
}) {
  let pending = null; // 이 PC에 들어온 연결 요청 (한 번에 하나)
  const lastVerify = new Map();
  const infoAt = new Map(); // 연결된 PC → 그 PC의 중계 서버 주소를 마지막으로 물어본 때
  const channels = new Map(); // 연결된 PC → 그 PC의 중계 서버를 거친 암호화 통로 (잠깐 열어 두고 다시 쓴다)
  const cleanRelay = (value) => cleanRelayUrl(value, { allowLocal: allowLocalRelay });
  const myRelay = () => cleanRelay(relayUrl());

  const changed = () => broadcastHost('peers', { peers: book.list() });
  const publicRequest = (p) =>
    p?.stage === 'asking' ? { rid: p.rid, id: p.id, name: p.name, kind: p.kind, address: p.address, code: p.code } : null;
  const peerHeaders = (peer) => ({ Authorization: `Bearer ${peer.sendKey}`, 'X-App-Port': String(self().port) });
  const offlineMessage = (name) => `${name}에 연결하지 못했어요. 그 PC에서 ${APP_NAME} 프로그램이 켜져 있는지 확인해 주세요.`;

  // ---- 인증 ----

  /**
   * Authorization: Bearer 키로 온 요청이면 그 기기를 돌려준다. 키가 틀렸으면 null, 키가 없으면 undefined.
   */
  function authenticate(req, { viaRelay = false } = {}) {
    const key = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (key === undefined) return undefined;
    // 키는 암호화된 연결로만 받는다. 평문으로 오갔다면 같은 Wi-Fi에서 엿봤을 수 있다.
    // 중계로 온 요청은 종단간 암호화된 통로를 지나 이 PC 안에서 전달된 것이다 (src/relay-client.js).
    if (!req.socket.encrypted && !viaRelay) return null;
    const peer = book.byKey(key);
    if (!peer) return null;
    // 중계로 온 요청의 출발 주소는 이 PC 자신이라 주소를 옮기지 않는다
    if (peer.kind === 'pc' && !viaRelay) {
      // 키를 가진 진짜 그 PC가 보낸 요청이므로 주소가 바뀌었으면 새 주소를 믿어도 된다
      const address = plainAddress(req.socket.remoteAddress);
      const port = Number(req.headers['x-app-port']);
      let moved = book.moveTo(peer.id, address, isValidPort(port) ? port : peer.port);
      moved = book.saw({ id: peer.id, name: peer.name, address: peer.address, port: peer.port }) || moved;
      if (moved) changed();
    }
    return peer;
  }

  // ---- 인증 없이 받는 요청: 연결 요청 ----

  async function handlePublic(req, res, url, ctx = {}) {
    if (req.method !== 'POST' || (url.pathname !== '/api/pair/start' && url.pathname !== '/api/pair/finish')) return false;
    // 웹사이트가 브라우저를 시켜 몰래 연결 요청을 보내지 못하게 한다 (이 헤더는 스크립트가 다른 사이트로 보낼 수 없다)
    if (req.headers['x-requested-with'] !== APP_ID) {
      rejectBody(req, res);
      sendJson(res, 403, { error: '허용되지 않은 요청이에요.' });
      return true;
    }
    if (!req.socket.encrypted) {
      rejectBody(req, res);
      sendJson(res, 400, { error: '암호화된 연결(HTTPS)로만 연결할 수 있어요.' });
      return true;
    }
    if (url.pathname === '/api/pair/start') await pairStart(req, res, ctx);
    else await pairFinish(req, res);
    return true;
  }

  async function pairStart(req, res, ctx = {}) {
    let body;
    try {
      body = await readJson(req, 16 * 1024);
    } catch {
      return sendJson(res, 413, { error: '잘못된 요청이에요.' });
    }
    const name = cleanName(body?.name);
    const kind = body?.kind;
    const valid =
      body &&
      PEER_ID.test(body.id || '') &&
      name &&
      COMMIT.test(body.commit || '') &&
      (kind === 'app' || (kind === 'pc' && isValidPort(body.port) && isValidKey(body.key) && isValidCert(body.cert)));
    if (!valid) return sendJson(res, 400, { error: '잘못된 연결 요청이에요.' });
    if (body.id === self().id) return sendJson(res, 400, { error: '자기 자신과는 연결할 수 없어요.' });
    if (pending && !(pending.stage === 'committed' && pending.id === body.id)) {
      return sendJson(res, 409, { error: '다른 연결 요청을 처리하는 중이에요.' });
    }
    if (pending) clearTimeout(pending.timer); // 같은 기기가 다시 시도하면 새 요청으로 바꾼다

    const request = {
      rid: newNonce().slice(0, 16),
      stage: 'committed',
      id: body.id,
      name,
      kind,
      // 중계 서버를 거쳐 온 요청(다른 곳의 PC)이면 같은 네트워크 주소를 모른다. 나중에 같은 네트워크에서 만나면 채워진다.
      address: ctx.viaRelay ? '' : plainAddress(req.socket.remoteAddress),
      port: kind === 'pc' ? body.port : null,
      cert: kind === 'pc' ? body.cert : null,
      key: kind === 'pc' ? body.key : null,
      relay: kind === 'pc' ? cleanRelay(body.relay) : null, // 그 PC가 쓰는 중계 서버 (없으면 null)
      commit: body.commit,
      nb: newNonce(),
    };
    request.timer = setTimeout(() => {
      if (pending === request) pending = null;
    }, COMMIT_TIMEOUT_MS);
    pending = request;
    return sendJson(res, 200, { id: self().id, name: self().name, nb: request.nb, port: self().port });
  }

  async function pairFinish(req, res) {
    let body;
    try {
      body = await readJson(req, 1024);
    } catch {
      return sendJson(res, 413, { error: '잘못된 요청이에요.' });
    }
    const request = pending;
    if (!request || request.stage !== 'committed' || body?.id !== request.id) {
      return sendJson(res, 409, { error: '연결 요청이 만료됐어요. 다시 시도해 주세요.' });
    }
    clearTimeout(request.timer);
    if (!NONCE.test(body.na || '') || sha256(body.na) !== request.commit) {
      pending = null;
      return sendJson(res, 400, { error: '확인 값이 맞지 않아요.' });
    }
    const initiator = request.kind === 'pc' ? fingerprintOf(request.cert) : `app:${request.id}`;
    request.code = pairCode(initiator, identity.fingerprint, body.na, request.nb);
    request.stage = 'asking';

    const decision = await new Promise((resolve) => {
      request.resolve = resolve;
      request.timer = setTimeout(() => resolve('timeout'), pairTimeoutMs);
      // 요청한 쪽이 기다리다 포기하면(창을 닫는 등) 여기 요청도 거둔다
      res.on('close', () => {
        if (!res.writableFinished) resolve('gone');
      });
      broadcastHost('pair-request', publicRequest(request));
      log('pair-request', publicRequest(request));
      if (!hasHostPage()) showHostPage();
    });
    clearTimeout(request.timer);
    if (pending === request) pending = null;
    broadcastHost('pair-request-done', { rid: request.rid, decision });

    if (decision === 'accept') {
      const recvKey = newPeerKey();
      const { id, name, kind, address, port, cert, key, relay } = request;
      book.pair({ id, name, kind, address, port, cert, sendKey: key, recvKey, relay });
      if (kind === 'pc') book.saw({ id, name, address, port });
      if (kind === 'pc') infoAt.set(id, Date.now());
      changed();
      log('paired', name);
      // 이 PC의 중계 서버 주소도 알려 준다 (PC·휴대폰 앱이 집 밖에서 중계로 보낼 때 쓴다)
      return sendJson(res, 200, { key: recvKey, relay: myRelay() });
    }
    if (decision === 'deny') return sendJson(res, 403, { error: '상대 기기에서 거절했어요.' });
    if (decision === 'timeout') return sendJson(res, 408, { error: '상대 기기에서 응답이 없어요.' });
    // 'gone', 'closing': 연결이 이미 끊겼다
  }

  // ---- 인증된 요청 ----

  async function handle(req, res, url, ctx) {
    const { pathname } = url;
    const method = req.method;

    // 연결된 기기가 스스로 연결을 끊을 때
    if (pathname === '/api/peer/unpair' && method === 'POST') {
      rejectBody(req, res);
      if (!ctx.peer) {
        sendJson(res, 403, { error: '연결된 기기만 할 수 있어요.' });
        return true;
      }
      book.unpair(ctx.peer.id);
      changed();
      log('unpaired', ctx.peer.name);
      sendEmpty(res);
      return true;
    }

    // 연결된 PC·휴대폰 앱이 이 PC의 중계 서버 주소를 물어볼 때 (설정을 바꿨을 수 있어서 가끔 묻는다)
    if (pathname === '/api/peer/info' && method === 'GET') {
      if (!ctx.peer) {
        sendJson(res, 403, { error: '연결된 기기만 할 수 있어요.' });
        return true;
      }
      sendJson(res, 200, { id: self().id, name: self().name, relay: myRelay() });
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
    if (pathname === '/api/peers/remote-code' && method === 'POST') {
      rejectBody(req, res);
      await makeRemoteCode(res);
      return true;
    }
    if (pathname === '/api/peers/connect-remote' && method === 'POST') {
      await connectRemote(req, res);
      return true;
    }

    let m;
    if ((m = /^\/api\/pair-requests\/([0-9a-f]{16})\/(accept|deny)$/.exec(pathname)) && method === 'POST') {
      rejectBody(req, res);
      if (pending?.stage === 'asking' && pending.rid === m[1]) {
        pending.resolve(m[2]);
        sendEmpty(res);
      } else {
        sendJson(res, 404, { error: '이미 끝난 연결 요청이에요.' });
      }
      return true;
    }
    if ((m = /^\/api\/peers\/([0-9a-f]{16})\/pair$/.exec(pathname)) && method === 'POST') {
      rejectBody(req, res);
      await startPairing(res, m[1]);
      return true;
    }
    if ((m = /^\/api\/peers\/([0-9a-f]{16})$/.exec(pathname)) && method === 'DELETE') {
      rejectBody(req, res);
      const peer = book.unpair(m[1]);
      if (!peer) {
        sendJson(res, 404, { error: '연결된 기기가 아니에요.' });
        return true;
      }
      changed();
      log('unpaired', peer.name);
      // 상대 PC에도 알린다 (같은 네트워크에 없으면 중계 서버로). 꺼져 있으면 다음에 보낼 때 상대가 알아서 거절한다.
      if (peer.kind === 'pc') {
        (peer.address ? requestJson(peer, { method: 'POST', path: '/api/peer/unpair', headers: peerHeaders(peer), pin: peer.cert, timeout: 3000 }) : Promise.reject(new Error('주소 모름')))
          .catch(() => peer.relay && relayRequest(peer, 'POST', '/api/peer/unpair', { 'x-requested-with': APP_ID }))
          .catch(() => {})
          .finally(() => closeChannel(peer.id));
      }
      sendEmpty(res);
      return true;
    }
    if ((m = /^\/api\/peers\/([0-9a-f]{16})\/upload-status$/.exec(pathname)) && method === 'GET') {
      await peerUploadStatus(res, url, m[1]);
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
    const info = await pingApp(target, { timeout: 3000 });
    if (!info) {
      return sendJson(res, 404, {
        error: `${target.address}에서 ${APP_NAME} 프로그램을 찾지 못했어요. 그 PC에서 ${APP_NAME} 프로그램이 켜져 있는지 확인해 주세요.`,
      });
    }
    if (!PEER_ID.test(info.id || '')) return sendJson(res, 400, { error: `그 PC의 ${APP_NAME} 프로그램을 최신 버전으로 바꿔 주세요.` });
    if (info.id === self().id) return sendJson(res, 400, { error: '이 PC의 주소예요. 다른 PC의 주소를 넣어 주세요.' });
    if (book.saw({ id: info.id, name: cleanName(info.name) || target.address, address: target.address, port: target.port })) changed();
    return sendJson(res, 200, { peer: book.list().find((p) => p.id === info.id) });
  }

  /**
   * 연결 과정. target이 다른 곳의 PC({ remote: { relay, code } })면 그 PC의 중계 서버를 거친 통로 안에서
   * 똑같이 HTTPS로 진행한다. 중계 서버는 통로 열쇠(연결 코드)를 알 수 있지만 그 안의 HTTPS는 풀 수 없고,
   * 끼어들면 두 화면의 6자리 숫자가 달라진다.
   */
/** 다른 곳의 PC가 이 PC에 처음 연결할 때 넣을 코드를 만든다 (이 PC의 중계 서버에 10분 동안 등록) */
  async function makeRemoteCode(res) {
    const relay = myRelay();
    if (!relay || !relayPairCode) {
      return sendJson(res, 409, { error: '먼저 [설정]에서 ‘어디서나 (중계 서버)’를 켜 주세요. 다른 곳의 PC와 연결할 때 중계 서버를 거쳐요.' });
    }
    try {
      const { code, expires } = await relayPairCode();
      return sendJson(res, 200, { code, expires, relay: new URL(relay).host });
    } catch (err) {
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  /** 다른 곳의 PC가 만든 연결 코드로 그 PC를 찾아 연결을 시작한다 */
  async function connectRemote(req, res) {
    let body;
    try {
      body = await readJson(req, 1024);
    } catch {
      return sendJson(res, 413, { error: '잘못된 요청이에요.' });
    }
    const parsed = parseRemoteCode(body?.code);
    if (!parsed) return sendJson(res, 400, { error: '연결 코드를 확인해 주세요. 예: ABCD-EFGH' });
    // 주소 없이 코드만 넣었으면 이 PC가 쓰는 중계 서버에서 찾는다 (보통 같은 중계 서버를 쓴다)
    const relay = parsed.host ? cleanRelay(`https://${parsed.host}`) : myRelay();
    if (!relay) {
      return sendJson(res, 400, { error: '상대 PC의 중계 서버 주소를 코드 앞에 붙여 주세요. 예: ssok.example.com/ABCD-EFGH' });
    }
    let found;
    try {
      const lookup = await fetch(`${relay}/api/pair-code/${parsed.code}`, { signal: AbortSignal.timeout(8000) });
      found = lookup.ok ? await lookup.json() : { error: (await lookup.json().catch(() => null))?.error };
    } catch {
      return sendJson(res, 502, { error: `중계 서버(${new URL(relay).host})에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.` });
    }
    if (!PEER_ID.test(found?.id || '')) return sendJson(res, 404, { error: found?.error || '연결 코드가 맞지 않거나 시간이 지났어요.' });
    if (found.id === self().id) return sendJson(res, 400, { error: '이 PC가 만든 코드예요. 연결할 다른 PC에서 넣어 주세요.' });
    const paired = book.getPaired(found.id);
    if (paired?.kind === 'pc') return sendJson(res, 409, { error: `이미 연결된 PC예요: ${paired.name}` });
    return startPairing(res, found.id, { id: found.id, name: '상대 PC', address: '127.0.0.1', port: 8765, remote: { relay, code: parsed.code } });
  }

  async function startPairing(res, id, target = book.target(id)) {
    if (!target) return sendJson(res, 404, { error: '그 PC를 찾을 수 없어요. 다시 찾아 주세요.' });
    const me = self();
    const na = newNonce();
    const recvKey = newPeerKey();
    const remote = target.remote ?? null;
    let tunnelClient = null;
    const via = async () => {
      if (!remote) return {};
      tunnelClient ??= RelayClient.connect(`${remote.relay.replace(/^http/, 'ws')}/ws/c/${id}`, pairChannelSecret(remote.code, id), { kid: 'pair', device: me.name });
      return { socket: openTunnel(await tunnelClient) };
    };
    const closeTunnel = () => tunnelClient?.then((c) => c.close(), () => {});

    // 1단계: 내 정보와 봉인한 난수를 보내고, 상대 인증서와 난수를 받는다
    let first;
    try {
      first = await requestJson(target, {
        method: 'POST',
        path: '/api/pair/start',
        body: { id: me.id, name: me.name, kind: 'pc', port: me.port, cert: identity.cert, key: recvKey, commit: sha256(na), relay: myRelay() },
        timeout: 8000,
        ...(await via()),
      });
    } catch (err) {
      closeTunnel();
      if (err.code === 'UNKNOWN_PEER') return sendJson(res, 410, { error: '연결 코드의 시간이 지났어요. 상대 PC에서 코드를 다시 만들어 주세요.' });
      return sendJson(res, 502, { error: offlineMessage(target.name) });
    }
    if (first.status === 409) {
      closeTunnel();
      return sendJson(res, 409, { error: `${target.name}에서 다른 연결 요청을 처리하는 중이에요. 잠시 뒤 다시 시도해 주세요.` });
    }
    if (first.status !== 200 || first.json?.id !== id || !NONCE.test(first.json?.nb || '') || !first.cert) {
      closeTunnel();
      return sendJson(res, 502, { error: first.json?.error || '다른 PC가 응답했어요. 목록을 새로 고친 뒤 다시 시도해 주세요.' });
    }
    const peerCert = first.cert;
    const peerName = cleanName(first.json.name) || target.name;
    const code = pairCode(identity.fingerprint, fingerprintOf(peerCert), na, first.json.nb);
    sendJson(res, 202, { id, name: peerName, code });

    // 2단계: 받은 인증서로 고정한 연결로 난수를 공개하고, 상대가 [허용]을 누를 때까지 기다린다
    via()
      .then((extra) => requestJson(target, { method: 'POST', path: '/api/pair/finish', body: { id: me.id, na }, pin: peerCert, timeout: pairTimeoutMs + 15_000, ...extra }))
      .then(({ status, json }) => {
        if (status === 200 && isValidKey(json?.key)) {
          const name = peerName;
          const relay = cleanRelay(json.relay) ?? remote?.relay ?? null;
          if (remote) {
            // 다른 곳의 PC: 같은 네트워크 주소는 모른다 (나중에 같은 네트워크에서 만나면 알아서 채워진다)
            const port = isValidPort(first.json.port) ? first.json.port : 8765;
            book.pair({ id, name, kind: 'pc', address: '', port, cert: peerCert, sendKey: json.key, recvKey, relay });
            book.sawRelay(id);
          } else {
            book.pair({ id, name, kind: 'pc', address: target.address, port: target.port, cert: peerCert, sendKey: json.key, recvKey, relay });
            book.saw({ id, name, address: target.address, port: target.port });
          }
          infoAt.set(id, Date.now());
          log('paired', name);
          return { id, ok: true, name };
        }
        const reasons = {
          403: `${target.name}에서 거절했어요.`,
          408: `${target.name}에서 응답이 없어 취소됐어요. 그 PC의 ${APP_NAME} 화면을 연 뒤 다시 시도해 주세요.`,
          409: '연결 요청이 만료됐어요. 다시 시도해 주세요.',
        };
        return { id, ok: false, error: reasons[status] || json?.error || '연결하지 못했어요.' };
      })
      .catch(() => ({ id, ok: false, error: '연결이 끊겼어요. 다시 시도해 주세요.' }))
      .then((result) => {
        closeTunnel();
        // 화면이 새 목록을 먼저 받아야 결과를 보고 바로 그 PC를 고를 수 있다
        changed();
        broadcastHost('pair-result', result);
      });
  }

  // ---- 연결된 PC로 보내기 ----

  async function sendToPeer(req, res, url, id, kind) {
    const peer = book.getPaired(id);
    if (peer?.kind !== 'pc') {
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
      for (const key of ['lastModified', 'uploadId', 'size', 'offset']) if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key));
      targetPath = `/api/upload?${params}`;
    }

    const contentType = kind === 'text' ? 'application/json' : 'application/octet-stream';
    // 같은 네트워크에서 안 보이면 중계 서버로 보낸다. 목록이 아직 확인 전일 수 있어 잠깐 직접 확인해 본다.
    let viaRelay = false;
    if (!book.isOnline(peer.id) && peer.relay) {
      const pong = peer.address ? await pingApp(peer, { pin: peer.cert, timeout: 1200 }) : null;
      if (pong?.id === peer.id) book.saw({ id: peer.id, name: peer.name, address: peer.address, port: peer.port });
      else viaRelay = true;
    }
    const result = viaRelay
      ? await sendViaRelay(req, res, peer, targetPath, length, contentType)
      : await sendDirect(req, res, peer, targetPath, length, contentType);
    if (res.destroyed) return;
    // 상대가 도중에 거절했으면 아직 들어오는 본문을 더 받지 않는다
    if (!req.complete) {
      req.unpipe();
      rejectBody(req, res);
    }

    if (result.error) {
      if (result.error.code === 'UNKNOWN_PEER') {
        // 상대 PC에서 연결을 해제했다 (중계로 보내려다 알게 됨)
        book.unpair(peer.id);
        closeChannel(peer.id);
        changed();
        return sendJson(res, 409, { error: `${peer.name}에서 연결이 해제됐어요. 다시 연결해 주세요.` });
      }
      if (viaRelay ? book.lostRelay(peer.id) : book.lost(peer.id)) changed();
      announce();
      return sendJson(res, 502, {
        error: viaRelay
          ? `${peer.name}에 보내지 못했어요. 그 PC에서 ${APP_NAME}이(가) 켜져 있고 어디서나(중계 서버)에 연결되어 있는지 확인해 주세요.`
          : `${peer.name}에 보내지 못했어요. 그 PC에서 ${APP_NAME} 프로그램이 켜져 있는지 확인해 주세요.`,
      });
    }
    if (result.status === 401) {
      // 상대 PC에서 연결을 해제했다
      book.unpair(peer.id);
      closeChannel(peer.id);
      changed();
      return sendJson(res, 409, { error: `${peer.name}에서 연결이 해제됐어요. 다시 연결해 주세요.` });
    }
    // 이어 보내기: 일부만 받았거나(202) 시작 위치가 달랐으면(409) 받은 양을 그대로 알려 준다
    if ((result.status === 202 || result.status === 409) && Number.isSafeInteger(result.json?.received)) {
      return sendJson(res, result.status, { received: result.json.received, error: result.json.error });
    }
    if (result.status < 200 || result.status >= 300) {
      return sendJson(res, result.status, { error: `${peer.name}: ${result.json?.error || '보내지 못했어요.'}` });
    }
    const seen = viaRelay ? book.sawRelay(peer.id) : book.saw({ id: peer.id, name: peer.name, address: peer.address, port: peer.port });
    if (seen) changed();
    log('peer-sent', { to: viaRelay ? `${peer.name} (어디서나)` : peer.name, item: result.json });
    return sendJson(res, 201, { ok: true, to: peer.name, via: viaRelay ? 'relay' : 'lan' });
  }

  /** 이어 보내기: 상대 PC가 그 파일을 얼마나 받아 두었는지 묻는다 (예전 버전이면 404 → 화면은 처음부터 보낸다) */
  async function peerUploadStatus(res, url, id) {
    const peer = book.getPaired(id);
    if (peer?.kind !== 'pc') return sendJson(res, 404, { error: '연결된 PC가 아니에요.' });
    const params = new URLSearchParams();
    for (const key of ['uploadId', 'size', 'name']) if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key));
    const statusPath = `/api/upload-status?${params}`;
    let result = null;
    if (peer.address && (book.isOnline(peer.id) || !peer.relay)) {
      result = await requestJson(peer, { path: statusPath, headers: peerHeaders(peer), pin: peer.cert, timeout: 5000 }).catch(() => null);
    }
    if (!result && peer.relay) result = await relayRequest(peer, 'GET', statusPath, { 'x-requested-with': APP_ID }).catch(() => null);
    if (result?.status === 200 && Number.isSafeInteger(result.json?.received)) return sendJson(res, 200, { received: result.json.received });
    return sendJson(res, 404, { error: '이어 보내기를 쓸 수 없어요.' });
  }

  /** 같은 네트워크에서 상대 PC에 바로 보낸다 (HTTPS, 저장해 둔 인증서로 고정) */
  function sendDirect(req, res, peer, targetPath, length, contentType) {
    const out = https.request({
      host: peer.address,
      port: peer.port,
      method: 'POST',
      path: targetPath,
      agent: false,
      ...pinnedTlsOptions(peer.cert),
      headers: {
        'Content-Length': length,
        'Content-Type': contentType,
        'X-Requested-With': APP_ID,
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
    return outcome;
  }

  /** 상대 PC의 중계 서버를 거쳐 보낸다 (종단간 암호화된 통로, 받는 대로 흘려보낸다) */
  async function sendViaRelay(req, res, peer, targetPath, length, contentType) {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      return await relayRequest(peer, 'POST', targetPath, { 'content-type': contentType, 'content-length': String(length), 'x-requested-with': APP_ID }, { body: req, signal: controller.signal });
    } catch (error) {
      return { error };
    }
  }

  // ---- 중계 서버를 거친 통로 ----

  /** 그 PC로 가는 통로 (열려 있으면 다시 쓴다) */
  function relayChannel(peer) {
    let entry = channels.get(peer.id);
    if (entry && entry.relay === peer.relay && entry.key === peer.sendKey) return entry;
    closeChannel(peer.id);
    entry = { relay: peer.relay, key: peer.sendKey, active: 0, timer: null };
    const url = `${peer.relay.replace(/^http/, 'ws')}/ws/c/${peer.id}`;
    const forget = () => {
      if (channels.get(peer.id) === entry) channels.delete(peer.id);
      clearTimeout(entry.timer);
    };
    entry.client = RelayClient.connect(url, peerRelaySecret(peer.sendKey), { kid: self().id, device: self().name, onClose: forget });
    entry.client.catch(forget);
    channels.set(peer.id, entry);
    return entry;
  }

  function closeChannel(id) {
    const entry = channels.get(id);
    if (!entry) return;
    channels.delete(id);
    clearTimeout(entry.timer);
    entry.client.then((c) => c.close(), () => {});
  }

  /** 중계 통로로 요청 하나를 보내고 JSON 응답을 받는다. 쓰는 동안에는 통로를 닫지 않는다. */
  async function relayRequest(peer, method, path, headers = {}, { body = null, signal } = {}) {
    const entry = relayChannel(peer);
    entry.active++;
    clearTimeout(entry.timer);
    try {
      const client = await entry.client;
      const response = await client.request(method, path, { headers, body, signal });
      let json = null;
      try {
        json = await response.json();
      } catch {
        // JSON이 아닌 응답
      }
      return { status: response.status, json };
    } finally {
      entry.active--;
      if (entry.active === 0 && channels.get(peer.id) === entry) {
        entry.timer = setTimeout(() => closeChannel(peer.id), CHANNEL_IDLE_MS);
        entry.timer.unref?.();
      }
    }
  }

  /** 그 PC가 지금 자기 중계 서버에 연결되어 있는지 */
  async function relayOnline(peer) {
    try {
      const res = await fetch(`${peer.relay}/api/online/${peer.id}`, { signal: AbortSignal.timeout(5000) });
      return res.ok && (await res.json()).online === true;
    } catch {
      return false;
    }
  }

  /** 같은 네트워크에 있는 연결된 PC에게 중계 서버 주소를 묻는다 (그 PC에서 설정을 바꿨을 수 있다) */
  async function fetchInfo(peer) {
    infoAt.set(peer.id, Date.now());
    try {
      const { status, json } = await requestJson(peer, { path: '/api/peer/info', headers: peerHeaders(peer), pin: peer.cert, timeout: 3000 });
      if (status === 200 && json?.id === peer.id) book.setRelay(peer.id, cleanRelay(json.relay));
    } catch {
      // 다음에 다시 묻는다
    }
  }

  // ---- 상대 PC가 켜져 있는지, 주소가 바뀌었는지 ----

  /** UDP로 다른 PC를 발견했을 때 */
  function discovered(info) {
    const paired = book.getPaired(info.id);
    if (paired?.kind !== 'pc' || (paired.address === info.address && paired.port === info.port)) {
      if (paired?.kind !== 'app' && book.saw(info)) changed();
      return;
    }
    // 연결해 둔 PC가 다른 주소에서 나타났다. UDP 알림은 누구나 꾸밀 수 있으므로
    // 그 주소에 저장해 둔 인증서로 접속이 되는지(=진짜 그 PC인지) 확인한 뒤에만 새 주소를 쓴다.
    const now = Date.now();
    if (now - (lastVerify.get(info.id) || 0) < verifyCooldownMs) return;
    lastVerify.set(info.id, now);
    pingApp({ address: info.address, port: info.port }, { pin: paired.cert, timeout: 3000 }).then((pong) => {
      if (pong?.id !== info.id) return;
      book.moveTo(info.id, info.address, info.port);
      book.saw(info);
      changed();
    });
  }

  /** 연결된 PC들이 켜져 있는지 확인한다 (UDP가 막힌 네트워크에서도 상태가 맞도록) */
  async function refresh() {
    const before = book.signature();
    await Promise.all(
      [...book.paired.values()]
        .filter((peer) => peer.kind === 'pc')
        .map(async (peer) => {
          const info = peer.address ? await pingApp(peer, { pin: peer.cert }) : null;
          if (info?.id === peer.id) {
            book.saw({ id: peer.id, name: cleanName(info.name) || peer.name, address: peer.address, port: peer.port });
            book.lostRelay(peer.id);
            if (Date.now() - (infoAt.get(peer.id) || 0) > INFO_INTERVAL_MS) await fetchInfo(peer);
            return;
          }
          book.lost(peer.id);
          // 같은 네트워크에 없으면: 그 PC의 중계 서버에 붙어 있는지 본다 (붙어 있으면 '어디서나'로 보낼 수 있다)
          if (peer.relay && (await relayOnline(peer))) book.sawRelay(peer.id);
          else book.lostRelay(peer.id);
        }),
    );
    if (book.signature() !== before) changed();
  }

  function close() {
    if (pending?.stage === 'asking') pending.resolve('closing');
    clearTimeout(pending?.timer);
    for (const id of [...channels.keys()]) closeChannel(id);
  }

  return { authenticate, handlePublic, handle, snapshot, discovered, refresh, close };
}
