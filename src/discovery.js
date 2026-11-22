// 같은 네트워크에서 이 프로그램을 실행 중인 다른 PC를 자동으로 찾는다 (UDP 브로드캐스트).
// 찾은 정보는 "여기 이런 PC가 있다"는 안내일 뿐이고, 실제로 주고받기 전에는 반드시 연결(페어링)과 키 확인을 거친다.
import dgram from 'node:dgram';
import { cleanName, isValidPort, PEER_ID } from './peers.js';
import { APP_ID } from './brand.js';
import { isLocalNetworkAddress } from './net.js';

export const DISCOVERY_PORT = 8765;
const APP = APP_ID;
const ANNOUNCE_EVERY_MS = 30_000;

/** 받은 UDP 메시지를 검사해서 { type, id, name, port }로 돌려준다. 이상하면 null. */
export function parseAnnouncement(buffer) {
  if (buffer.length > 1024) return null;
  let msg;
  try {
    msg = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (msg?.app !== APP) return null;
  // 휴대폰 앱이 IP가 바뀐 PC를 다시 찾을 때 보내는 질문. 앱은 PC가 아니므로 목록에 넣지 않고 답만 한다.
  if (msg.t === 'find') return { type: 'find' };
  if (msg.t !== 'hello' && msg.t !== 'here') return null;
  if (typeof msg.id !== 'string' || !PEER_ID.test(msg.id) || !isValidPort(msg.port)) return null;
  const name = cleanName(msg.name);
  if (!name) return null;
  return { type: msg.t, id: msg.id, name, port: msg.port };
}

/**
 * @param {object} options
 * @param {() => {id: string, name: string, port: number}} options.self   이 PC를 알릴 정보
 * @param {(peer: {id, name, port, address}) => void} options.onPeer      다른 PC를 발견했을 때
 * @param {() => (string | {address: string, port: number})[]} options.targets  알림을 보낼 브로드캐스트 주소들
 * @param {number} [options.port]         받을 UDP 포트 (0이면 아무 포트)
 * @param {string} [options.bindAddress]  받을 주소 (기본: 모든 네트워크)
 * @returns {Promise<{ announce: () => void, close: () => void, port: number }>}
 */
export async function startDiscovery({ self, onPeer, targets, port = DISCOVERY_PORT, bindAddress, log = () => {} }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const message = (type) => Buffer.from(JSON.stringify({ app: APP, v: 1, t: type, ...self() }));
  const ignore = () => {}; // 보낼 수 없는 네트워크(연결 끊김 등)는 조용히 넘어간다

  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, bindAddress, () => {
      socket.off('error', reject);
      resolve();
    });
  });
  socket.setBroadcast(true);
  socket.on('error', (err) => log('discovery-error', err));

  // 답하는 횟수 제한 (보낸 주소를 속인 요청으로 다른 곳에 패킷을 쏟아붓는 데 쓰이지 않게)
  let replyWindow = 0;
  let replies = 0;
  const canReply = () => {
    const now = Date.now();
    if (now - replyWindow > 1000) {
      replyWindow = now;
      replies = 0;
    }
    return ++replies <= 20;
  };
  socket.on('message', (buffer, rinfo) => {
    if (!isLocalNetworkAddress(rinfo.address)) return; // 같은 네트워크에서 온 것만
    const msg = parseAnnouncement(buffer);
    if (!msg || msg.id === self().id) return;
    if (msg.type === 'find') {
      if (canReply()) socket.send(message('here'), rinfo.port, rinfo.address, ignore); // 휴대폰 앱에게 이 PC의 주소를 알려 준다
      return;
    }
    // 새로 켜진 PC가 인사하면 바로 답해서, 서로 30초를 기다리지 않고 찾게 한다
    if (msg.type === 'hello' && canReply()) socket.send(message('here'), rinfo.port, rinfo.address, ignore);
    onPeer({ id: msg.id, name: msg.name, port: msg.port, address: rinfo.address });
  });

  const announce = () => {
    const hello = message('hello');
    for (const target of targets()) {
      const address = typeof target === 'string' ? target : target.address;
      const targetPort = typeof target === 'string' ? DISCOVERY_PORT : target.port;
      try {
        socket.send(hello, targetPort, address, ignore);
      } catch {
        // 소켓이 이미 닫혔다
      }
    }
  };
  announce();
  const timer = setInterval(announce, ANNOUNCE_EVERY_MS);
  timer.unref();

  return {
    announce,
    port: socket.address().port,
    close() {
      clearInterval(timer);
      try {
        socket.close();
      } catch {
        // 이미 닫힘
      }
    },
  };
}
