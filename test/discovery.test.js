import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDiscovery, parseAnnouncement } from '../src/discovery.js';

test('알림 메시지를 검사한다', () => {
  const ok = Buffer.from(JSON.stringify({ app: 'ssok', v: 1, t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: ' 거실 PC ', port: 8765 }));
  assert.deepEqual(parseAnnouncement(ok), { type: 'hello', id: 'a0a0a0a0a0a0a0a0', name: '거실 PC', port: 8765 });
  const bad = (msg) => parseAnnouncement(Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
  assert.equal(bad('not json'), null);
  assert.equal(bad({ app: 'other', t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: 'x', port: 1 }), null);
  assert.equal(bad({ app: 'ssok', t: 'hello', id: '../etc', name: 'x', port: 1 }), null);
  assert.equal(bad({ app: 'ssok', t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: '', port: 1 }), null);
  assert.equal(bad({ app: 'ssok', t: 'hello', id: 'a0a0a0a0a0a0a0a0', name: 'x', port: 70000 }), null);
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

test('휴대폰 앱이 PC를 찾으면 답만 하고, 주변 PC 목록에는 넣지 않는다', async () => {
  const found = [];
  const pc = await startDiscovery({
    self: () => ({ id: 'a0a0a0a0a0a0a0a0', name: 'PC-A', port: 8765 }),
    onPeer: (p) => found.push(p),
    targets: () => [],
    port: 0,
    bindAddress: '127.0.0.1',
  });
  const dgram = await import('node:dgram');
  const phone = dgram.createSocket('udp4');
  await new Promise((r) => phone.bind(0, '127.0.0.1', r));
  try {
    const reply = new Promise((resolve) => phone.once('message', (buf) => resolve(JSON.parse(buf.toString('utf8')))));
    phone.send(Buffer.from(JSON.stringify({ app: 'ssok', v: 1, t: 'find' })), pc.port, '127.0.0.1');
    const answer = await reply;
    assert.equal(answer.t, 'here');
    assert.equal(answer.id, 'a0a0a0a0a0a0a0a0');
    assert.equal(answer.port, 8765);
    assert.deepEqual(found, []);
  } finally {
    phone.close();
    pc.close();
  }
});

test('같은 네트워크(사설·링크 로컬·Tailscale) 주소에만 답한다', async () => {
  const { isLocalNetworkAddress } = await import('../src/net.js');
  for (const a of ['192.168.0.5', '10.1.2.3', '172.20.0.1', '169.254.1.1', '100.101.102.103', '127.0.0.1', '::ffff:192.168.1.9', 'fe80::1', 'fd12::3', '::1']) {
    assert.equal(isLocalNetworkAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.2.3.4', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:8.8.4.4']) assert.equal(isLocalNetworkAddress(a), false, a);
});
