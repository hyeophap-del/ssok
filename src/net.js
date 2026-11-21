import os from 'node:os';

// 휴대폰에서 접속할 수 없는 가상 어댑터들 (Hyper-V, WSL, VPN, 블루투스 등)
const VIRTUAL = /(vEthernet|Virtual|VMware|Hyper-V|WSL|Loopback|Bluetooth|블루투스|Tailscale|ZeroTier|Docker|VPN|TAP-|Npcap|Radmin|Hamachi)/i;
const WIRELESS = /(Wi-?Fi|WLAN|Wireless|무선)/i;
const WIRED = /(Ethernet|이더넷|^eth|^en\d)/i;

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * 휴대폰이 이 PC에 접속할 때 쓸 수 있는 IPv4 주소 목록. 가능성이 높은 순서로 정렬한다.
 * @returns {{ address: string, iface: string }[]}
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'number' ? `IPv${entry.family}` : entry.family;
      if (family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue; // 자동 할당(APIPA) 주소: 실제 네트워크가 아님
      if (isTailscale(iface, entry.address)) continue; // Tailscale은 '어디서나' 주소로 따로 보여 준다
      let score = 0;
      if (WIRELESS.test(iface)) score += 3;
      if (WIRED.test(iface)) score += 2;
      if (VIRTUAL.test(iface)) score -= 10;
      if (entry.address.startsWith('192.168.')) score += 2;
      else if (isPrivateIPv4(entry.address)) score += 1;
      found.push({ address: entry.address, iface, score });
    }
  }
  return found
    .sort((a, b) => b.score - a.score)
    .map(({ address, iface }) => ({ address, iface }));
}

/** Tailscale이 준 주소인지 (100.64.0.0/10 대역, Tailscale 어댑터) */
function isTailscale(iface, address) {
  const [a, b] = address.split('.').map(Number);
  const cgnat = a === 100 && b >= 64 && b <= 127;
  return cgnat && (/tailscale/i.test(iface) || /^utun/.test(iface));
}

/**
 * Tailscale 주소. Tailscale을 켠 휴대폰·PC는 집 밖에서도 이 주소로 이 PC에 바로 들어올 수 있다.
 * Tailscale이 없거나 꺼져 있으면 null.
 * @returns {{ address: string, iface: string } | null}
 */
export function tailscaleAddress(interfaces = os.networkInterfaces()) {
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'number' ? `IPv${entry.family}` : entry.family;
      if (family === 'IPv4' && !entry.internal && isTailscale(iface, entry.address)) return { address: entry.address, iface };
    }
  }
  return null;
}

const ipToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/**
 * 같은 네트워크의 다른 PC를 찾을 때 알림을 보낼 브로드캐스트 주소들.
 * 네트워크마다의 주소(예: 192.168.0.255)와, 혹시 모를 경우를 위한 255.255.255.255.
 */
export function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const found = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'number' ? `IPv${entry.family}` : entry.family;
      if (family !== 'IPv4' || entry.internal || !entry.netmask) continue;
      if (entry.address.startsWith('169.254.')) continue;
      const broadcast = (ipToInt(entry.address) | (~ipToInt(entry.netmask) >>> 0)) >>> 0;
      found.add(intToIp(broadcast));
    }
  }
  found.add('255.255.255.255');
  return [...found];
}

/** 이 PC 자신의 주소인지 (localhost 포함) */
export function isOwnAddress(remoteAddress, interfaces = os.networkInterfaces()) {
  if (!remoteAddress) return false;
  const addr = remoteAddress.replace(/^::ffff:/, '');
  if (addr === '::1' || addr.startsWith('127.')) return true;
  return Object.values(interfaces).some((entries) => (entries || []).some((e) => e.address === addr));
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Host 헤더 검사. IP 주소·localhost·이 PC 이름으로 들어온 요청만 받는다.
 * 악성 웹사이트가 DNS 리바인딩으로 이 서버에 접근하는 것을 막는다.
 */
export function isAllowedHost(hostHeader, hostname = os.hostname()) {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  let name;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false;
    return /^[0-9a-f:.]+$/.test(host.slice(1, end));
  }
  name = host.replace(/:\d+$/, '');
  if (name === 'localhost') return true;
  if (IPV4.test(name)) return name.split('.').every((n) => Number(n) <= 255);
  const own = hostname.toLowerCase();
  return name === own || name === `${own}.local`;
}
