// QR 코드 생성기 (바이트 모드 전용, 외부 의존성 없음).
// ISO/IEC 18004 알고리즘을 따르며, 구조는 Project Nayuki의 QR Code generator(MIT)를 참고했다.

const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_ORDER = ['L', 'M', 'Q', 'H'];
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// [ecl][version] — 인덱스 0은 사용하지 않는다.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver, ecl) {
  const e = ECL[ecl];
  return Math.floor(numRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

// 바이트 모드의 글자 수 필드 길이
const charCountBits = (ver) => (ver <= 9 ? 8 : 16);

/** 주어진 버전·오류 정정 수준에 담을 수 있는 최대 바이트 수 */
export function byteCapacity(version, ecl = 'M') {
  return Math.floor((numDataCodewords(version, ecl) * 8 - 4 - charCountBits(version)) / 8);
}

// ---- Reed-Solomon (GF(2^8), 원시 다항식 0x11D) ----

function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= rsMultiply(coef, factor);
    });
  }
  return result;
}

// ---- 인코딩 ----

/**
 * 텍스트를 QR 코드로 만든다.
 * @param {string} text
 * @param {{ ecl?: 'L'|'M'|'Q'|'H', boostEcl?: boolean }} [options]
 * @returns {{ version: number, size: number, ecl: string, mask: number, modules: boolean[][] }}
 */
export function encodeQR(text, { ecl = 'M', boostEcl = true } = {}) {
  if (!(ecl in ECL)) throw new RangeError(`알 수 없는 오류 정정 수준: ${ecl}`);
  const bytes = [...Buffer.from(String(text), 'utf8')];

  let version;
  for (let v = 1; v <= 40; v++) {
    const bits = 4 + charCountBits(v) + bytes.length * 8;
    if (bits <= numDataCodewords(v, ecl) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new RangeError('QR 코드에 담기에는 데이터가 너무 깁니다.');

  // 같은 버전(크기)에 들어가면 오류 정정 수준을 올려서 인식률을 높인다.
  const usedBits = 4 + charCountBits(version) + bytes.length * 8;
  if (boostEcl) {
    for (let i = ECL[ecl] + 1; i < ECL_ORDER.length; i++) {
      if (usedBits <= numDataCodewords(version, ECL_ORDER[i]) * 8) ecl = ECL_ORDER[i];
    }
  }

  // 비트열 구성
  const bb = [];
  const append = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, charCountBits(version));
  for (const b of bytes) append(b, 8);

  const capacityBits = numDataCodewords(version, ecl) * 8;
  append(0, Math.min(4, capacityBits - bb.length));
  append(0, (8 - (bb.length % 8)) % 8);
  for (let pad = 0xec; bb.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);

  const dataCodewords = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb[i + j];
    dataCodewords.push(byte);
  }

  return buildMatrix(version, ecl, addEccAndInterleave(dataCodewords, version, ecl));
}

function addEccAndInterleave(data, ver, ecl) {
  const e = ECL[ecl];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function buildMatrix(version, ecl, codewords) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // 타이밍 패턴
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // 위치 찾기 패턴(세 모서리)
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // 정렬 패턴
  const alignPos = alignmentPatternPositions(version, size);
  const n = alignPos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(alignPos[i] + dx, alignPos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  const drawFormat = (mask) => {
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i));
    setFunction(8, size - 8, true);
  };

  // 버전 정보 (버전 7 이상)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  drawFormat(0); // 자리 확보용 (마스크 선택 후 다시 그린다)

  // 데이터 배치 (오른쪽 아래에서 지그재그)
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  };

  // 벌점이 가장 낮은 마스크를 고른다
  let bestMask = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const penalty = penaltyScore(modules, size);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask); // XOR이므로 한 번 더 적용하면 원래대로 돌아온다
  }
  applyMask(bestMask);
  drawFormat(bestMask);

  return { version, size, ecl, mask: bestMask, modules };
}

function alignmentPatternPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function penaltyScore(modules, size) {
  let score = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(modules[y]);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]));

  const finderA = [true, false, true, true, true, false, true, false, false, false, false];
  const finderB = [false, false, false, false, true, false, true, true, true, false, true];

  for (const line of lines) {
    // 규칙 1: 같은 색이 5칸 이상 이어짐
    let runColor = line[0];
    let runLen = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        if (i < size) {
          runColor = line[i];
          runLen = 1;
        }
      }
    }
    // 규칙 3: 위치 찾기 패턴과 비슷한 1:1:3:1:1 패턴
    for (let i = 0; i + 11 <= size; i++) {
      let a = true;
      let b = true;
      for (let j = 0; j < 11 && (a || b); j++) {
        if (line[i + j] !== finderA[j]) a = false;
        if (line[i + j] !== finderB[j]) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  }

  // 규칙 2: 2×2 같은 색 블록
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }

  // 규칙 4: 어두운 모듈 비율
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;

  return score;
}

// ---- 출력 ----

/** QR 코드를 SVG 문자열로 만든다. */
export function toSvg(qr, { border = 4, dark = '#000', light = '#fff' } = {}) {
  const dim = qr.size + border * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path += `M${x + border},${y + border}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

/**
 * 터미널에 찍을 수 있는 QR 코드 문자열을 만든다.
 * 한 글자에 위아래 두 모듈을 담고(▀), 터미널 테마와 상관없이 읽히도록 색을 직접 지정한다.
 */
export function toTerminal(qr, { border = 2 } = {}) {
  const dim = qr.size + border * 2;
  const isDark = (x, y) => {
    const qx = x - border;
    const qy = y - border;
    return qx >= 0 && qy >= 0 && qx < qr.size && qy < qr.size && qr.modules[qy][qx];
  };
  const BLACK_FG = '\x1b[30m';
  const WHITE_FG = '\x1b[97m';
  const BLACK_BG = '\x1b[40m';
  const WHITE_BG = '\x1b[107m';
  const RESET = '\x1b[0m';

  const rows = [];
  for (let y = 0; y < dim; y += 2) {
    let row = '';
    for (let x = 0; x < dim; x++) {
      const top = isDark(x, y);
      const bottom = y + 1 < dim ? isDark(x, y + 1) : false;
      row += (top ? BLACK_FG : WHITE_FG) + (bottom ? BLACK_BG : WHITE_BG) + '▀';
    }
    rows.push(row + RESET);
  }
  return rows.join('\n');
}
