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
