import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { encodeQR, toSvg, toTerminal, byteCapacity } from '../src/qr.js';

// QR 매트릭스를 픽셀로 그려서 실제 디코더(jsQR)로 다시 읽어 본다.
function decode(qr, scale = 4, border = 4) {
  const dim = (qr.size + border * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + border) * scale + dx;
          const py = (y + border) * scale + dy;
          const i = (py * dim + px) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  const result = jsQR(data, dim, dim, { inversionAttempts: 'dontInvert' });
  return result && result.data;
}

test('실제 접속 주소 형태를 인코딩하고 다시 읽을 수 있다', () => {
  const url = 'http://192.168.0.32:8765/?k=Abc-123_xyzQ';
  const qr = encodeQR(url);
  assert.equal(decode(qr), url);
});

test('한글(UTF-8)도 인코딩된다', () => {
  const text = 'http://192.168.0.32:8765/ 갤럭시 파일 공유';
  assert.equal(decode(encodeQR(text)), text);
});

test('모든 오류 정정 수준과 여러 버전에서 디코딩된다', () => {
  const lengths = [1, 10, 17, 30, 50, 80, 120, 200, 300, 400, 600, 900, 1200];
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    for (const len of lengths) {
      let text;
      try {
        text = Array.from({ length: len }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('');
        const qr = encodeQR(text, { ecl, boostEcl: false });
        assert.equal(decode(qr), text, `ecl=${ecl} len=${len} version=${qr.version}`);
      } catch (err) {
        if (err instanceof RangeError && /너무 깁니다/.test(err.message)) continue;
        throw err;
      }
    }
  }
});

test('버전 1부터 40까지 모두 디코딩된다', () => {
  for (let version = 1; version <= 40; version++) {
    // jsQR 1.4.0의 버전 23 정렬 패턴 좌표가 74로 잘못 들어 있다(표준은 6, 30, 54, 78, 102).
    // 디코더 쪽 오류라서 이 버전만 건너뛴다.
    if (version === 23) continue;
    const text = 'x'.repeat(byteCapacity(version, 'L'));
    const qr = encodeQR(text, { ecl: 'L', boostEcl: false });
    assert.equal(qr.version, version, '용량을 꽉 채우면 정확히 그 버전이 골라져야 한다');
    assert.equal(decode(qr), text, `version ${version}`);
    if (version < 40) assert.equal(encodeQR(text + 'x', { ecl: 'L', boostEcl: false }).version, version + 1);
  }
});

test('버전 23은 표준 정렬 패턴 좌표(78)에 그려진다', () => {
  const qr = encodeQR('x'.repeat(byteCapacity(23, 'L')), { ecl: 'L', boostEcl: false });
  assert.equal(qr.version, 23);
  // 정렬 패턴 중심은 어둡고, 중심에서 한 칸 떨어진 링은 밝고, 두 칸 떨어진 링은 어둡다.
  const at = (x, y) => qr.modules[y][x];
  assert.equal(at(78, 30), true);
  assert.equal(at(79, 30), false);
  assert.equal(at(80, 30), true);
  assert.equal(at(78, 54), true);
  assert.equal(at(77, 54), false);
});

test('너무 긴 데이터는 RangeError를 던진다', () => {
  assert.throws(() => encodeQR('x'.repeat(3000), { ecl: 'L' }), RangeError);
});

test('터미널에 찍은 QR(▀ + 색상 코드)을 다시 풀어도 읽힌다', () => {
  const url = 'http://192.168.0.32:8765/?k=aFCC-q0eS6QC';
  const qr = encodeQR(url);
  const border = 2;
  const dim = qr.size + border * 2;
  // 각 글자: 글자색(30=검정, 97=흰색) = 위 칸, 배경색(40=검정, 107=흰색) = 아래 칸
  const rows = toTerminal(qr, { border }).split('\n');
  const modules = Array.from({ length: dim }, () => new Array(dim).fill(false));
  rows.forEach((row, r) => {
    const cells = [...row.matchAll(/\x1b\[(\d+)m\x1b\[(\d+)m▀/g)];
    assert.equal(cells.length, dim);
    cells.forEach(([, fg, bg], x) => {
      modules[r * 2][x] = fg === '30';
      if (r * 2 + 1 < dim) modules[r * 2 + 1][x] = bg === '40';
    });
  });
  const unwrapped = { size: dim, modules };
  assert.equal(decode(unwrapped, 4, 2), url);
});

test('SVG와 터미널 출력이 만들어진다', () => {
  const qr = encodeQR('hello');
  assert.match(toSvg(qr), /^<svg [^>]*viewBox="0 0 29 29"/);
  const lines = toTerminal(qr).split('\n');
  assert.equal(lines.length, Math.ceil((qr.size + 4) / 2));
});
