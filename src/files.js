import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const MAX_NAME_LENGTH = 180; // " (12)" 같은 꼬리가 붙어도 Windows 255자 제한 안에 들도록 여유를 둔다

/**
 * 휴대폰이 보낸 파일 이름을 Windows/macOS/Linux 어디에 저장해도 안전한 이름으로 바꾼다.
 * 경로 부분은 버리고, 금지 문자·예약 이름·끝의 점/공백을 정리한다.
 */
export function sanitizeFilename(input, fallback = '파일') {
  let name = String(input ?? '').normalize('NFC');
  name = name.split(/[\\/]/).pop();
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
  name = name.replace(/^\s+/, '').replace(/[. ]+$/, '');
  if (!name || /^\.+$/.test(name)) name = fallback;

  if (WINDOWS_RESERVED.test(name.split('.')[0].trim())) name = `_${name}`;

  const chars = Array.from(name);
  if (chars.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name);
    const extChars = ext.length <= 20 ? Array.from(ext) : [];
    name = chars.slice(0, MAX_NAME_LENGTH - extChars.length).join('').replace(/[. ]+$/, '') + extChars.join('');
  }
  return name;
}

/** dir 안에서 겹치지 않는 경로를 찾는다. "사진.jpg"가 있으면 "사진 (1).jpg", "사진 (2).jpg" … */
export function uniquePath(dir, name, taken = new Set()) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    if (!taken.has(candidate.toLowerCase()) && !fs.existsSync(candidate)) return candidate;
  }
}

const reserved = new Set();

/**
 * 임시 파일을 dir 안의 겹치지 않는 이름으로 옮긴다.
 * Windows에서는 백신이 막 쓴 파일을 잠깐 잡고 있는 경우가 있어서 몇 번 다시 시도한다.
 */
export async function moveIntoPlace(tmpPath, dir, name) {
  const target = uniquePath(dir, name, reserved);
  const key = target.toLowerCase();
  reserved.add(key);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmpPath, target);
        return target;
      } catch (err) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  } finally {
    reserved.delete(key);
  }
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', dng: 'image/x-adobe-dng',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', '3gp': 'video/3gpp', wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', amr: 'audio/amr',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json', xml: 'application/xml',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  gz: 'application/gzip', tar: 'application/x-tar',
  apk: 'application/vnd.android.package-archive',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwp: 'application/x-hwp', hwpx: 'application/hwp+zip',
};

export function mimeOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// 브라우저에서 바로 열어도 안전한 형식. HTML·SVG처럼 스크립트를 실행할 수 있는 형식은 항상 내려받게 한다.
const INLINE_SAFE = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/flac',
  'application/pdf', 'text/plain; charset=utf-8',
]);

export const isInlineSafe = (mime) => INLINE_SAFE.has(mime);

/** RFC 6266 Content-Disposition 값 (한글 파일 이름 지원) */
export function contentDisposition(name, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
