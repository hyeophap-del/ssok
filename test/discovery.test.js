import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDiscovery, parseAnnouncement } from '../src/discovery.js';

test('알림 메시지를 검사한다', () => {
  const ok = Buffer.from(JSON.stringify({ app: 'galaxy-file', v: 1, t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: ' 거실 PC ', port: 8765 }));
  assert.deepEqual(parseAnnouncement(ok), { type: 'hello', id: 'a0a0a0a0a0a0a0a0', name: '거실 PC', port: 8765 });
  const bad = (msg) => parseAnnouncement(Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
  assert.equal(bad('not json'), null);
  assert.equal(bad({ app: 'other', t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: 'x', port: 1 }), null);
  assert.equal(bad({ app: 'galaxy-file', t: 'hello', id: '../etc', name: 'x', port: 1 }), null);
  assert.equal(bad({ app: 'galaxy-file', t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: '', port: 1 }), null);
  assert.equal(bad({ app: 'galaxy-file', t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: 'x', port: 70000 }), null);
  assert.equal(parseAnnouncement(Buffer.alloc(2000, 32)), null);
});

test('두 PC가 서로를 찾는다 (나중에 켠 쪽이 인사하면 먼저 켠 쪽이 바로 답한다)', async () => {
  const ports = {};
  const found = { A: [], B: [] };
  const targetsOf = (other) => () => (ports[other] ? [{ address: '127.0.0.1', port: ports[other] }] : []);

  const a = await startDiscovery({
    self: () => ({ id: 'a0a0a0a0a0a0a0a0', name: 'PC-A', port: 1111 }),
    onPeer: (p) => found.A.push(p),
    targets: targetsOf('B'),
    port: 0,
    bindAddress: '127.0.0.1',
  });
  ports.A = a.port;
  const b = await startDiscovery({
    self: () => ({ id: 'b0b0b0b0b0b0b0b0', name: 'PC-B', port: 2222 }),
    onPeer: (p) => found.B.push(p),
    targets: () => [{ address: '127.0.0.1', port: ports.A }, { address: '127.0.0.1', port: ports.B }],
    port: 0,
    bindAddress: '127.0.0.1',
  });
  ports.B = b.port;

  try {
    const end = Date.now() + 3000;
    while ((!found.A.length || !found.B.length) && Date.now() < end) {
      b.announce(); // 처음 알림은 포트를 알기 전에 나갔을 수 있어 한 번 더
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(found.A[0], { id: 'b0b0b0b0b0b0b0b0', name: 'PC-B', port: 2222, address: '127.0.0.1' });
    assert.deepEqual(found.B[0], { id: 'a0a0a0a0a0a0a0a0', name: 'PC-A', port: 1111, address: '127.0.0.1' });
    assert.ok(found.B.every((p) => p.id !== 'b0b0b0b0b0b0b0b0'), '자기 자신의 알림은 무시한다');
  } finally {
    a.close();
    b.close();
  }
});
