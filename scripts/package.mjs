// 나눠 줄 압축 파일을 만든다. 받는 사람이 Node.js를 따로 설치하지 않도록 공식 node.exe를 함께 넣는다.
// 사용법: node scripts/package.mjs  →  dist/Ssok-<버전>-windows-x64.zip
//
// 압축 안의 구성
//   쏙/쏙 시작.cmd      ← 받는 사람이 더블클릭하는 파일
//   쏙/node.exe         ← 이 PC의 Node.js 실행 파일 (OpenJS 재단 서명)
//   쏙/app/...          ← 프로그램
//   쏙/사용법.txt, NODE-LICENSE.txt
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_NAME, APP_DIR, RECEIVED_DIR_NAME } from '../src/brand.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DIST = path.join(ROOT, 'dist');
const TOP = APP_NAME;

if (process.platform !== 'win32') {
  console.error('Windows용 압축 파일은 Windows에서 만들어야 해요 (이 PC의 node.exe를 넣기 때문).');
  process.exit(1);
}

const entries = [];
const add = (name, data, mtime = new Date()) => entries.push({ name: `${TOP}/${name}`, data: Buffer.isBuffer(data) ? data : Buffer.from(data), mtime });

function addTree(zipDir, dir, keep = () => true) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const zipPath = `${zipDir}/${entry.name}`;
    if (entry.isDirectory()) addTree(zipPath, full, keep);
    else if (keep(entry.name)) add(zipPath, fs.readFileSync(full), fs.statSync(full).mtime);
  }
}

// 프로그램
add('app/server.js', fs.readFileSync(path.join(ROOT, 'server.js')));
add('app/package.json', fs.readFileSync(path.join(ROOT, 'package.json')));
addTree('app/src', path.join(ROOT, 'src'), (name) => name.endsWith('.js'));
addTree('app/public', path.join(ROOT, 'public'));

// 공식 Node.js 실행 파일과 라이선스
add('node.exe', fs.readFileSync(process.execPath));
add('NODE-LICENSE.txt', nodeLicense());

// 더블클릭하는 파일. 경로에 한글이 있어도 되도록 내용은 영어·기호만 쓴다.
add(
  `${APP_NAME} 시작.cmd`,
  ['@echo off', '"%~dp0node.exe" "%~dp0app\\server.js" --launch', 'if errorlevel 1 pause', ''].join('\r\n'),
);

add(
  '사용법.txt',
  '﻿' +
    [
      `${APP_NAME} ${version} — 휴대폰·PC와 파일 주고받기`,
      '',
      '1. 이 폴더를 원하는 곳(예: 문서)에 두고 "' + APP_NAME + ' 시작"을 더블클릭하세요.',
      '   - "Windows의 PC 보호" 또는 "게시자를 확인할 수 없습니다" 창이 뜨면 [추가 정보] → [실행]을 누르세요.',
      '   - Windows 방화벽 창이 뜨면 [허용]을 누르세요. 그래야 휴대폰과 다른 PC가 접속할 수 있어요.',
      '2. 브라우저에 PC 화면이 열려요. 휴대폰 카메라로 QR 코드를 스캔하면 휴대폰에서도 열려요.',
      '3. 처음 실행하면 시작 메뉴에 "' + APP_NAME + '"이 생기고, PC를 켤 때 자동으로 실행돼요.',
      '   자동 실행은 PC 화면의 [설정]에서 끌 수 있어요.',
      '',
      `받은 파일은 다운로드\\${RECEIVED_DIR_NAME} 폴더에 저장돼요.`,
      `설정과 기록은 %LOCALAPPDATA%\\${APP_DIR} 폴더에 있어요.`,
      '',
      '지우려면: PC 화면의 [설정]에서 끄기 → 이 폴더 삭제 → 시작 메뉴의 바로가기 삭제',
      '(자동 실행 바로가기: 실행 창(Win+R)에 shell:startup 입력)',
      '',
    ].join('\r\n'),
);

/** Node.js 라이선스 전문. 받아 오지 못하면 출처 안내만 넣는다. */
function nodeLicense() {
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  try {
    const text = execFileSync('curl.exe', ['-fsSL', '--max-time', '30', url], { encoding: 'utf8', windowsHide: true });
    if (text.includes('Node.js is licensed')) return text;
  } catch {
    // 인터넷이 안 되면 아래 안내로 대신한다
  }
  return `node.exe는 Node.js ${process.version}입니다 (MIT 라이선스, 함께 들어 있는 구성 요소는 각자의 라이선스).\r\n전문: ${url}\r\n`;
}

// ---- ZIP 쓰기 (파일 이름은 UTF-8로 표시해서 한글 이름이 깨지지 않게 한다) ----

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeZip(file, files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of files) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(entry.data);
    const { time, day } = dosTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 풀 때 필요한 버전
    local.writeUInt16LE(0x0800, 6); // 이름이 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(day, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, directory, end]));
}

fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, `Ssok-${version}-windows-x64.zip`);
writeZip(out, entries);
const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`만듦: ${path.relative(ROOT, out)} (${mb}MB, 파일 ${entries.length}개, Node.js ${process.version})`);
