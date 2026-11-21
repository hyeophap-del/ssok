// PC 쪽: 중계 서버(예: ssok.hyeophap.com)에 늘 연결해 두고, 휴대폰이 들어오면
// 암호화된 통로(public/relay.js)로 받은 요청을 이 PC의 쏙 서버에 그대로 전달한다.
// 중계 서버는 휴대폰과 이 PC를 이어 주기만 하고, 내용(파일·텍스트)은 볼 수 없다.
import http from 'node:http';
import { SecureSocket, FRAME, CHUNK } from '../public/relay.js';

const PASS_REQUEST = ['content-type', 'content-length', 'x-requested-with', 'range', 'accept', 'user-agent'];
const PASS_RESPONSE = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'last-modified'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);

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
      secret,
      onFrame: (type, id, payload) => {
        try {
          onFrame(type, id, payload);
        } catch (err) {
          log('error', err);
          secure.send(FRAME.CANCEL, id, {}).catch(() => {});
        }
      },
      onClose: () => {
        for (const { req, res } of streams.values()) {
          req.destroy();
          res?.destroy();
        }
        streams.clear();
        resolveClosed();
      },
    });
    secure.ready.then((info) => log('relay-phone', info?.device || '휴대폰')).catch(() => {});

    function onFrame(type, id, payload) {
      if (type === FRAME.REQ_HEAD) {
        const head = JSON.parse(decode(payload));
        const path = String(head.path || '');
        if (!METHODS.has(head.method) || !path.startsWith('/') || path.startsWith('//')) {
          secure.send(FRAME.RES_HEAD, id, { status: 400, headers: {} }).then(() => secure.send(FRAME.RES_END, id, {}));
          return;
        }
        const headers = pick(Object.fromEntries(Object.entries(head.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), PASS_REQUEST);
        headers.host = `127.0.0.1:${localPort}`;
        headers.cookie = cookie;
        headers['x-ssok-relay'] = relayKey;
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
