import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactLog } from '../src/logs.js';

test('보낼 기록에서는 접속 코드를 가린다', () => {
  const log = [
    '  휴대폰 주소   http://192.168.0.32:8765/?k=Abc-123_xyzQ',
    '  다른 네트워크 http://10.0.0.5:8765/?k=Abc-123_xyzQ  (이더넷)',
    '  오류: token Abc-123_xyzQ 이 찍힌 줄',
    '  [12:00:00] 휴대폰 → PC  사진.jpg (1.2 MB)',
  ].join('\n');
  const out = redactLog(log, 'Abc-123_xyzQ');
  assert.ok(!out.includes('Abc-123_xyzQ'));
  assert.match(out, /\?k=●●●●/);
  assert.match(out, /사진\.jpg/, '다른 내용은 그대로 둔다');
  assert.match(redactLog('http://x/?k=OtherToken1', null), /k=●●●●/, '설정의 접속 코드를 몰라도 주소 속 코드는 가린다');
});
