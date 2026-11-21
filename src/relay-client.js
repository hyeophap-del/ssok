// PC 쪽: 중계 서버(예: ssok.hyeophap.com)에 늘 연결해 두고, 휴대폰이 들어오면
// 암호화된 통로(public/relay.js)로 받은 요청을 이 PC의 쏙 서버에 그대로 전달한다.
// 중계 서버는 휴대폰과 이 PC를 이어 주기만 하고, 내용(파일·텍스트)은 볼 수 없다.
import http from 'node:http';
import net from 'node:net';
import { pairChannelSecret } from './peers.js';
import { SecureSocket, FRAME, CHUNK } from '../public/relay.js';

const PASS_REQUEST = ['content-type', 'content-length', 'x-requested-with', 'range', 'accept', 'user-agent'];
const PASS_RESPONSE = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'last-modified'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);
// 연결된 다른 PC가 중계로 쓸 수 있는 것: 파일·텍스트 보내기, 연결 해제, 중계 주소 확인 (휴대폰 권한은 주지 않는다)
const PEER_ROUTES = new Set(['POST /api/upload', 'POST /api/text', 'POST /api/peer/unpair', 'GET /api/peer/info']);
const PEER_ID = /^[0-9a-f]{16}$/;

const pick = (headers, names) => Object.fromEntries(names.filter((n) => headers[n] !== undefined).map((n) => [n, String(headers[n])]));
const decode = (bytes) => new TextDecoder().decode(bytes);

/**
 * @param {object} options
 * @param {string} options.relayUrl   중계 서버 주소 (예: https://ssok.example.com)
 * @param {string} options.pcId       이 PC 번호
 * @param {string} options.pcAuth     중계 서버에 이 PC 번호의 주인임을 보이는 비밀 값
 * @param {string} options.invite     초대 코드
 * @param {Uint8Array} options.secret 휴대폰과 나눠 가진 비밀 열쇠 (QR 주소의 # 뒤)
 * @param {number} options.localPort  이 PC의 쏙 서버 포트
 * @param {string} options.cookie     이 PC의 쏙에 휴대폰처럼 들어가는 쿠키 (예: ssok=접속코드)
 * @param {string} options.relayKey   중계로 온 요청임을 표시하는 값 (PC 화면 권한을 주지 않으려고)
 * @param {(status: {state: string, error?: string}) => void} [options.onStatus]
 * @param {(peerId: string) => ({secret: Uint8Array, key: string} | null)} [options.peerLookup]
 *        연결된 다른 PC가 중계로 들어올 때: 그 PC와 나눠 가진 열쇠와, 그 PC가 이 PC에 내미는 키
 * @param {Set<number>} [options.tunnelPorts]  그대로 통과시키는 연결이 이 PC의 쏙에 붙은 포트 (쏙이 'PC 화면'이 아닌 바깥 요청으로 대한다)
 */
export function startRelayClient({
  relayUrl,
  pcId,
  pcAuth,
  invite,
  secret,
  name,
  version,
  localPort,
  cookie,
  relayKey,
  onStatus = () => {},
  peerLookup = () => null,
  tunnelPorts = new Set(),
  log = () => {},
  WebSocketImpl = globalThis.WebSocket,
}) {
  const base = relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
  let control = null;
  let stopped = false;
  let retryMs = 3000;
  let retryTimer = null;
  let heartbeat = null;
  let lastHeard = 0; // 중계 서버에서 마지막으로 무언가 받은 때
  let pairCode = null; // 다른 곳의 PC가 처음 연결할 때 쓰는 코드 { code, expires } (이 PC가 만들었을 때만)
  let pairCodeWaiter = null;
  const sessions = new Set();
  let status = { state: 'connecting' };
  const setStatus = (next) => {
    status = next;
    onStatus(status);
  };

  function connect() {
    if (stopped) return;
    setStatus({ state: 'connecting' });
    let ws;
    try {
      ws = new WebSocketImpl(`${base}/ws/pc`);
    } catch (err) {
      setStatus({ state: 'error', error: `중계 서버 주소를 확인해 주세요 (${err.message})` });
      return;
    }
    control = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'register', id: pcId, auth: pcAuth, invite, name, version }));
    ws.onmessage = (event) => {
      lastHeard = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.t === 'ok') {
        retryMs = 3000;
        setStatus({ state: 'connected' });
      } else if (msg.t === 'error') {
        // 초대 코드가 틀렸거나 막힌 경우: 금방 다시 해도 소용없으니 천천히 다시 시도한다
        retryMs = 60_000;
        setStatus({ state: 'error', error: msg.message || '중계 서버가 연결을 거절했어요.' });
      } else if (msg.t === 'incoming' && typeof msg.sid === 'string') {
        accept(msg.sid);
      } else if (msg.t === 'pair-code' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(msg.code || '')) {
        pairCode = { code: msg.code, expires: Number(msg.expires) || Date.now() + 10 * 60_000 };
        pairCodeWaiter?.resolve(pairCode);
        pairCodeWaiter = null;
      }
    };
    ws.onerror = () => {};
    let dropped = false;
    // 끊겼을 때 한 번만: 잠시 뒤 다시 연결한다
    const drop = () => {
      if (dropped) return;
      dropped = true;
      clearInterval(heartbeat);
      if (control === ws) control = null;
      if (stopped) return;
      if (status.state !== 'error') setStatus({ state: 'connecting', error: '중계 서버와 연결이 끊겨 다시 연결하는 중이에요.' });
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    };
    ws.onclose = drop;
    clearInterval(heartbeat);
    lastHeard = Date.now();
    // Cloudflare 등은 오래 조용한 연결을 끊으므로 주기적으로 신호를 보낸다.
    // 답(pong)이 한동안 없으면 말없이 끊긴 연결로 보고 새로 연결한다 (네트워크가 바뀌었을 때 등)
    heartbeat = setInterval(() => {
      if (Date.now() - lastHeard > 65_000) {
        try {
          ws.close();
        } catch {
          // 이미 닫힘
        }
        return drop();
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }));
    }, 25_000);
    heartbeat.unref?.();
  }

  /** 휴대폰 하나가 들어왔다: 그 휴대폰 전용 연결을 열어 암호화된 통로를 만든다 */
  function accept(sid) {
    if (!/^[0-9a-f]{32}$/.test(sid)) return;
    const ws = new WebSocketImpl(`${base}/ws/pc-accept/${sid}`);
    ws.onerror = () => {};
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'accept', id: pcId, auth: pcAuth }));
      const session = serve(ws);
      sessions.add(session);
      session.closed.then(() => sessions.delete(session));
    };
  }

  /** 암호화된 통로로 들어온 요청을 이 PC의 쏙 서버에 전달하고, 응답을 그대로 돌려보낸다 */
  function serve(ws) {
    const streams = new Map();
    let resolveClosed;
    const closed = new Promise((r) => (resolveClosed = r));
    const secure = new SecureSocket(ws, {
      role: 'pc',
      // 휴대폰은 QR의 비밀 열쇠로, 연결된 PC는 자기 번호(kid)로 찾은 열쇠로, 처음 연결하는 PC는 연결 코드로 들어온다
      secret: (hello) => {
        if (hello.kid === undefined) return secret;
        if (hello.kid === 'pair') return pairCode && pairCode.expires > Date.now() ? pairChannelSecret(pairCode.code, pcId) : null;
        return PEER_ID.test(String(hello.kid)) ? (peerLookup(hello.kid)?.secret ?? null) : null;
      },
      onFrame: (type, id, payload) => {
        try {
          onFrame(type, id, payload);
        } catch (err) {
          log('error', err);
          secure.send(FRAME.CANCEL, id, {}).catch(() => {});
        }
      },
      onClose: () => {
        for (const socket of raws.values()) socket.destroy();
        raws.clear();
        for (const { req, res } of streams.values()) {
          req.destroy();
          res?.destroy();
        }
        streams.clear();
        resolveClosed();
      },
    });
    secure.ready.then((info) => !secure.hello?.kid && log('relay-phone', info?.device || '휴대폰')).catch(() => {});
    const refuse = (id, status) => secure.send(FRAME.RES_HEAD, id, { status, headers: {} }).then(() => secure.send(FRAME.RES_END, id, {})).catch(() => {});

    const raws = new Map(); // 그대로 통과시키는 연결 → 이 PC의 쏙 서버에 붙인 소켓

    /** 처음 연결하는 PC: 바이트를 그대로 이 PC의 쏙 포트로 넘긴다 (그 안에서 HTTPS로 연결 과정을 밟는다) */
    function openRaw(id) {
      const socket = net.connect({ host: '127.0.0.1', port: localPort });
      raws.set(id, socket);
      let port = null;
      socket.on('connect', () => {
        port = socket.localPort;
        tunnelPorts.add(port);
      });
      socket.on('data', (chunk) => {
        socket.pause();
        (async () => {
          for (let at = 0; at < chunk.length; at += CHUNK) await secure.send(FRAME.RAW_DATA, id, chunk.subarray(at, at + CHUNK));
          await secure.drain(1024 * 1024);
        })().then(
          () => socket.resume(),
          () => socket.destroy(),
        );
      });
      socket.on('end', () => secure.send(FRAME.RAW_END, id, {}).catch(() => {}));
      socket.on('error', () => {});
      socket.on('close', () => {
        if (port !== null) tunnelPorts.delete(port);
        if (raws.get(id) === socket) {
          raws.delete(id);
          secure.send(FRAME.CANCEL, id, {}).catch(() => {});
        }
      });
    }

    function onFrame(type, id, payload) {
      const pairing = secure.hello?.kid === 'pair';
      if (type === FRAME.RAW_OPEN) {
        if (!pairing || raws.size >= 4) return void secure.send(FRAME.CANCEL, id, {}).catch(() => {});
        return openRaw(id);
      }
      const raw = raws.get(id);
      if (raw) {
        if (type === FRAME.RAW_DATA) raw.write(Buffer.from(payload));
        else if (type === FRAME.RAW_END) raw.end();
        else if (type === FRAME.CANCEL) {
          raws.delete(id);
          raw.destroy();
        }
        return;
      }
      if (pairing) return type === FRAME.REQ_HEAD ? refuse(id, 403) : undefined; // 처음 연결하는 PC는 연결 과정만 밟을 수 있다
      if (type === FRAME.REQ_HEAD) {
        const head = JSON.parse(decode(payload));
        const path = String(head.path || '');
        if (!METHODS.has(head.method) || !path.startsWith('/') || path.startsWith('//')) return refuse(id, 400);
        const headers = pick(Object.fromEntries(Object.entries(head.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), PASS_REQUEST);
        headers.host = `127.0.0.1:${localPort}`;
        headers['x-ssok-relay'] = relayKey;
        const kid = secure.hello?.kid;
        if (kid) {
          // 연결된 다른 PC: 휴대폰 쿠키 없이, 그 PC의 키로 PC끼리 기능만 쓴다 (통로의 열쇠가 곧 그 PC라는 증명)
          if (!PEER_ROUTES.has(`${head.method} ${path.split('?')[0]}`)) return refuse(id, 403);
          const peer = peerLookup(kid);
          if (!peer) return refuse(id, 401);
          headers.authorization = `Bearer ${peer.key}`;
        } else {
          headers.cookie = cookie;
        }
        const req = http.request({ host: '127.0.0.1', port: localPort, method: head.method, path, headers });
        const entry = { req, res: null };
        streams.set(id, entry);
        req.on('response', async (res) => {
          entry.res = res;
          try {
            await secure.send(FRAME.RES_HEAD, id, { status: res.statusCode, headers: pick(res.headers, PASS_RESPONSE) });
          } catch {
            return res.destroy();
          }
          // 조각마다 암호화해 보내고, 휴대폰 쪽으로 못 나간 양이 많으면 잠깐 멈춘다
          res.on('data', (chunk) => {
            res.pause();
            (async () => {
              for (let at = 0; at < chunk.length; at += CHUNK) await secure.send(FRAME.RES_DATA, id, chunk.subarray(at, at + CHUNK));
              await secure.drain(2 * 1024 * 1024);
            })().then(
              () => res.resume(),
              () => res.destroy(),
            );
          });
          res.on('end', () => {
            secure.send(FRAME.RES_END, id, {}).catch(() => {});
            streams.delete(id);
          });
          res.on('error', () => streams.delete(id));
        });
        req.on('error', () => {
          if (streams.delete(id)) secure.send(FRAME.CANCEL, id, {}).catch(() => {});
        });
        if (head.method === 'GET' || head.method === 'HEAD') {
          if (!headers['content-length']) req.end();
        }
        return;
      }
      const entry = streams.get(id);
      if (!entry) return;
      if (type === FRAME.REQ_DATA) entry.req.write(Buffer.from(payload));
      else if (type === FRAME.REQ_END) {
        if (!entry.req.writableEnded) entry.req.end();
      } else if (type === FRAME.CANCEL) {
        streams.delete(id);
        entry.req.destroy();
        entry.res?.destroy();
      }
    }

    return { closed, close: () => secure.close() };
  }

  connect();
  return {
    status: () => status,
    /** 다른 곳의 PC가 처음 연결할 때 넣을 코드를 중계 서버에서 받는다 (10분 동안 유효) */
    requestPairCode() {
      if (!control || control.readyState !== 1 || status.state !== 'connected') {
        return Promise.reject(Object.assign(new Error('중계 서버에 연결되어 있지 않아요. [설정]의 ‘어디서나 (중계 서버)’를 확인해 주세요.'), { status: 409 }));
      }
      pairCodeWaiter?.reject(new Error('새 코드를 만들었어요'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pairCodeWaiter = null;
          reject(Object.assign(new Error('중계 서버가 응답하지 않아요. 잠시 뒤 다시 시도해 주세요.'), { status: 504 }));
        }, 10_000);
        pairCodeWaiter = {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (err) => (clearTimeout(timer), reject(err)),
        };
        control.send(JSON.stringify({ t: 'pair-code' }));
      });
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(heartbeat);
      try {
        control?.close();
      } catch {
        // 이미 닫힘
      }
      for (const session of sessions) session.close();
      setStatus({ state: 'stopped' });
    },
  };
}
