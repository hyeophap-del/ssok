// 서버 여러 곳에서 쓰는 작은 HTTP 도구들

export function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

export function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

export function sendEmpty(res, status = 204) {
  res.writeHead(status);
  res.end();
}

/** 거절하는 요청의 본문을 처리한다. 작은 본문은 읽어 버리고, 큰 업로드는 응답 뒤에 연결을 끊는다. */
export function rejectBody(req, res) {
  if (req.complete) return;
  const length = Number(req.headers['content-length'] || 0);
  if (length > 1024 * 1024) {
    res.setHeader('Connection', 'close');
    res.on('finish', () => req.destroy());
  } else {
    req.resume();
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** JSON 본문을 읽는다. 형식이 틀리면 null. */
export async function readJson(req, limit) {
  try {
    return JSON.parse(await readBody(req, limit));
  } catch (err) {
    if (err.code === 'TOO_LARGE') throw err;
    return null;
  }
}

/** 다른 기기에 붙을 수 있게 ::ffff: 접두어를 뗀 IPv4 주소 */
export function plainAddress(address = '') {
  return address.replace(/^::ffff:/, '');
}

/** 이름(PC·기기)에서 줄바꿈 같은 제어 문자를 뺀다 (기록에 가짜 줄이 끼지 않게) */
export const cleanName = (value, fallback) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40) || fallback;

/** 접속 주소를 세는 단위: IPv6는 /64 (한 집이 주소를 무수히 바꿔 쓸 수 있으므로) */
export function addressKey(address) {
  const a = String(address || '').replace(/%.*$/, '');
  if (!a.includes(':')) return a;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(a)) return a.slice(7);
  // 줄여 쓴 주소(2001:db8::1)를 펼친 뒤 앞 네 덩어리만
  const [head, tail = ''] = a.split('::');
  const front = head ? head.split(':') : [];
  const back = a.includes('::') && tail ? tail.split(':') : [];
  const groups = [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
