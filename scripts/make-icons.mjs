// public/icon.svg와 같은 모양의 PNG 아이콘(홈 화면 바로가기용)과 Windows 아이콘(icon.ico, 바탕 화면·시작 메뉴용)을 만든다.
// 사용법: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// icon.svg와 같은 좌표계(512×512)
const FROM = [0x4f, 0x7b, 0xff];
const TO = [0x8b, 0x5c, 0xf6];
const STROKE_RADIUS = 20;
const SEGMENTS = [
  [196, 368, 196, 144], [132, 208, 196, 144], [196, 144, 260, 208], // 위 화살표
  [316, 144, 316, 368], [252, 304, 316, 368], [316, 368, 380, 304], // 아래 화살표
];

function distToSegment(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inRoundedRect(x, y, size, r) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function render(size, { rounded, stroke = STROKE_RADIUS }) {
  const SAMPLES = 4;
  const scale = 512 / size;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const X = (x + (sx + 0.5) / SAMPLES) * scale;
          const Y = (y + (sy + 0.5) / SAMPLES) * scale;
          if (rounded && !inRoundedRect(X, Y, 512, 112)) continue;
          let color;
          if (SEGMENTS.some((s) => distToSegment(X, Y, s) <= stroke)) {
            color = [255, 255, 255];
          } else {
            const t = Math.min(1, Math.max(0, (X + Y) / 1024));
            color = FROM.map((c, i) => c + (TO[i] - c) * t);
          }
          r += color[0];
          g += color[1];
          b += color[2];
          covered++;
        }
      }
      const i = (y * size + x) * 4;
      if (covered) {
        pixels[i] = Math.round(r / covered);
        pixels[i + 1] = Math.round(g / covered);
        pixels[i + 2] = Math.round(b / covered);
        pixels[i + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
      }
    }
  }
  return encodePng(size, size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 비트 깊이
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // 필터 없음
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
  ['icon-maskable.png', 512, { rounded: false }], // 안드로이드가 원·둥근 사각형으로 잘라 쓴다
  ['apple-touch-icon.png', 180, { rounded: false }], // iOS가 모서리를 직접 둥글린다
];
for (const [name, size, options] of targets) {
  fs.writeFileSync(path.join(OUT, name), render(size, options));
  console.log(`만듦: public/${name}`);
}

// Windows 아이콘: 여러 크기의 PNG를 한 파일에 담는다. 작은 크기는 선을 굵게 해서 뭉개지지 않게 한다.
const ICO_SIZES = [16, 24, 32, 48, 64, 256];
const images = ICO_SIZES.map((size) => render(size, { rounded: true, stroke: size <= 32 ? 34 : size <= 64 ? 26 : STROKE_RADIUS }));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // 아이콘
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const size = ICO_SIZES[i];
  const at = 6 + 16 * i;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4); // 색 평면
  header.writeUInt16LE(32, at + 6); // 비트 수
  header.writeUInt32LE(png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([header, ...images]));
console.log('만듦: public/icon.ico');
