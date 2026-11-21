// 중계 서버를 거친 '그대로 통과시키는 연결'을 Node 스트림(소켓처럼)으로 감싼다.
// 다른 곳의 PC와 처음 연결할 때, 이 위에서 평소와 똑같이 HTTPS로 연결 과정을 밟는다 (src/peer-api.js).
import { Duplex } from 'node:stream';

/** @param {import('../public/relay.js').RelayClient} client */
export function openTunnel(client) {
  let raw;
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      raw.write(chunk).then(() => callback(), callback);
    },
    final(callback) {
      raw.end();
      callback();
    },
    destroy(err, callback) {
      raw.abort();
      callback(err);
    },
  });
  raw = client.openRaw({
    onData: (bytes) => stream.push(Buffer.from(bytes)),
    onEnd: () => stream.push(null),
    onClose: (err) => stream.destroy(err),
  });
  // TLS가 소켓처럼 쓰는 것들
  stream.setTimeout = () => stream;
  stream.setNoDelay = () => stream;
  stream.setKeepAlive = () => stream;
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}
