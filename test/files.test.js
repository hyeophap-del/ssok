import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeFilename, uniquePath, moveIntoPlace, contentDisposition, mimeOf, isInlineSafe } from '../src/files.js';

test('경로와 금지 문자를 걸러낸다', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Windows\\win.ini'), 'win.ini');
  assert.equal(sanitizeFilename('what?<is>*this|"x":.txt'), 'what__is__this__x__.txt');
  assert.equal(sanitizeFilename('tab\there.txt'), 'tab_here.txt');
});

test('Windows 예약 이름과 끝의 점·공백을 고친다', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFilename('com1.tar.gz'), '_com1.tar.gz');
  assert.equal(sanitizeFilename('console.log'), 'console.log');
  assert.equal(sanitizeFilename('report. . '), 'report');
});

test('빈 이름은 기본 이름이 된다', () => {
  assert.equal(sanitizeFilename(''), '파일');
  assert.equal(sanitizeFilename(null), '파일');
  assert.equal(sanitizeFilename('..'), '파일');
  assert.equal(sanitizeFilename('/'), '파일');
});

test('macOS/iOS식 한글 자모 분리(NFD)를 합친다(NFC)', () => {
  const nfd = '사진.jpg'.normalize('NFD');
  assert.notEqual(nfd, '사진.jpg');
  assert.equal(sanitizeFilename(nfd), '사진.jpg');
});

test('너무 긴 이름은 확장자를 살려서 자른다', () => {
  const long = `${'가'.repeat(300)}.mp4`;
  const result = sanitizeFilename(long);
  assert.ok(Array.from(result).length <= 180);
  assert.ok(result.endsWith('.mp4'));
});

test('같은 이름이 있으면 번호를 붙인다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-files-'));
  try {
    fs.writeFileSync(path.join(dir, '사진.jpg'), 'a');
    fs.writeFileSync(path.join(dir, '사진 (1).jpg'), 'b');
    assert.equal(path.basename(uniquePath(dir, '사진.jpg')), '사진 (2).jpg');
    assert.equal(path.basename(uniquePath(dir, 'README')), 'README');

    const tmp = path.join(dir, 'upload.part');
    fs.writeFileSync(tmp, 'c');
    const moved = await moveIntoPlace(tmp, dir, '사진.jpg');
    assert.equal(path.basename(moved), '사진 (2).jpg');
    assert.equal(fs.readFileSync(moved, 'utf8'), 'c');
    assert.equal(fs.readFileSync(path.join(dir, '사진.jpg'), 'utf8'), 'a', '기존 파일을 덮어쓰지 않는다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Content-Disposition에 한글 이름을 안전하게 넣는다', () => {
  const value = contentDisposition('여행 사진 (1).jpg');
  assert.match(value, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.ok(value.includes(encodeURIComponent('여행').replace(/%/g, '%')));
  assert.ok(value.includes('%281%29'), '괄호도 인코딩한다');
  assert.match(contentDisposition('a"b\\c.txt', true), /^inline; filename="a_b_c.txt"/);
});

test('스크립트를 실행할 수 있는 형식은 브라우저에서 바로 열지 않는다', () => {
  assert.equal(isInlineSafe(mimeOf('photo.JPG')), true);
  assert.equal(isInlineSafe(mimeOf('clip.mp4')), true);
  assert.equal(isInlineSafe(mimeOf('page.html')), false);
  assert.equal(isInlineSafe(mimeOf('logo.svg')), false);
  assert.equal(mimeOf('unknown.xyz'), 'application/octet-stream');
});
