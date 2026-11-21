import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, isAllowedHost, isOwnAddress, broadcastAddresses, tailscaleAddress } from '../src/net.js';

const iface = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });

test('Wi-Fi 주소를 가장 먼저 고르고 가상·자동 할당 주소는 뒤로 미루거나 뺀다', () => {
  const result = lanAddresses({
    'vEthernet (WSL)': [iface('172.24.160.1')],
    'Bluetooth 네트워크 연결': [iface('169.254.33.0')],
    '로컬 영역 연결* 10': [iface('169.254.112.62')],
    'Wi-Fi': [iface('192.168.0.32'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    Loopback: [iface('127.0.0.1', { internal: true })],
  });
  assert.deepEqual(
    result.map((r) => r.address),
    ['192.168.0.32', '172.24.160.1'],
  );
});

test('Node 18의 숫자형 family도 처리한다', () => {
  const result = lanAddresses({ 이더넷: [{ address: '10.0.0.5', family: 4, internal: false }] });
  assert.deepEqual(result, [{ address: '10.0.0.5', iface: '이더넷' }]);
});

test('다른 PC를 찾을 브로드캐스트 주소를 네트워크마다 계산한다', () => {
  const result = broadcastAddresses({
    'Wi-Fi': [iface('192.168.0.32', { netmask: '255.255.255.0' })],
    이더넷: [iface('10.1.2.3', { netmask: '255.255.0.0' })],
    'Bluetooth 네트워크 연결': [iface('169.254.33.0', { netmask: '255.255.0.0' })],
    Loopback: [iface('127.0.0.1', { internal: true, netmask: '255.0.0.0' })],
  });
  assert.deepEqual(result, ['192.168.0.255', '10.1.255.255', '255.255.255.255']);
});

test('Host 헤더는 IP·localhost·PC 이름만 허용한다', () => {
  assert.equal(isAllowedHost('192.168.0.32:8765', 'MYPC'), true);
  assert.equal(isAllowedHost('localhost:8765', 'MYPC'), true);
  assert.equal(isAllowedHost('127.0.0.1', 'MYPC'), true);
  assert.equal(isAllowedHost('[::1]:8765', 'MYPC'), true);
  assert.equal(isAllowedHost('mypc.local:8765', 'MYPC'), true);
  assert.equal(isAllowedHost('MYPC:8765', 'MYPC'), true);
  assert.equal(isAllowedHost('evil.example.com:8765', 'MYPC'), false, 'DNS 리바인딩 차단');
  assert.equal(isAllowedHost('999.1.1.1:8765', 'MYPC'), false);
  assert.equal(isAllowedHost(undefined, 'MYPC'), false);
});

test('이 PC에서 온 요청인지 판단한다', () => {
  const interfaces = { 'Wi-Fi': [iface('192.168.0.32')] };
  assert.equal(isOwnAddress('127.0.0.1', interfaces), true);
  assert.equal(isOwnAddress('::ffff:127.0.0.1', interfaces), true);
  assert.equal(isOwnAddress('::1', interfaces), true);
  assert.equal(isOwnAddress('::ffff:192.168.0.32', interfaces), true);
  assert.equal(isOwnAddress('192.168.0.77', interfaces), false);
});

test('Tailscale 주소는 집 네트워크 목록에서 빼고 ‘어디서나’ 주소로 따로 찾는다', () => {
  const interfaces = {
    'Wi-Fi': [iface('192.168.0.32')],
    Tailscale: [iface('100.101.102.103'), { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }],
  };
  assert.deepEqual(lanAddresses(interfaces).map((a) => a.address), ['192.168.0.32']);
  assert.deepEqual(tailscaleAddress(interfaces), { address: '100.101.102.103', iface: 'Tailscale' });
  assert.equal(tailscaleAddress({ 'Wi-Fi': [iface('192.168.0.32')] }), null);
  assert.equal(tailscaleAddress({ 'Wi-Fi': [iface('100.70.1.2')] }), null, '통신사 주소(100.64/10)라도 Tailscale 어댑터가 아니면 아니다');
});
