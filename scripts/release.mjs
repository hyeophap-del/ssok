// 새 버전을 올릴 준비: 테스트 → 안드로이드 앱 → exe → 서명한 업데이트 정보(latest.json)
//
// 사용법: node scripts/release.mjs --notes-file 바뀐점.md   (버전은 package.json의 version)
//   --skip-tests, --skip-android  시험 삼아 빨리 만들 때
// 결과: dist/release/v<버전>/
//   Ssok-<버전>.exe, ssok-<버전>.apk   받는 사람이 내려받는 파일
//   SsokRelay-<버전>.exe               중계 서버용 (같은 exe. 이름에 Relay가 들어 있으면 중계 서버로 실행된다)
//   latest.json, latest.json.sig       설치된 쏙이 새 버전을 확인할 때 읽는 정보와 그 서명
//   notes.md                           GitHub 릴리스 설명
// 마지막에 GitHub에 올리는 명령을 보여 준다 (올리는 것은 공개되는 일이라 따로 실행한다).
//
// 서명 키: %USERPROFILE%\.ssok-release\update-key.pem (또는 SSOK_RELEASE_KEY). 저장소 밖에 두고 따로 백업한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_NAME, REPO } from '../src/brand.js';
import { UPDATE_PUBLIC_KEY } from '../src/update-key.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    'notes-file': { type: 'string' },
    'skip-tests': { type: 'boolean' },
    'skip-android': { type: 'boolean' },
    out: { type: 'string' },
  },
});
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const notes = args['notes-file'] ? fs.readFileSync(args['notes-file'], 'utf8').trim() : '';
const OUT = args.out ? path.resolve(args.out) : path.join(ROOT, 'dist', 'release', `v${version}`);
// 결과 폴더는 통째로 지우고 다시 만드므로, dist 안만 허락한다 (경로를 잘못 써서 다른 폴더를 지우지 않게)
if (!OUT.startsWith(path.join(ROOT, 'dist') + path.sep)) {
  console.error(`--out은 ${path.join(ROOT, 'dist')} 안이어야 해요: ${OUT}`);
  process.exit(1);
}
const keyFile = process.env.SSOK_RELEASE_KEY ?? path.join(os.homedir(), '.ssok-release', 'update-key.pem');
const node = (script, extra = []) => execFileSync(process.execPath, [script, ...extra], { cwd: ROOT, stdio: 'inherit' });

if (!fs.existsSync(keyFile)) {
  console.error(`업데이트 서명 키가 없어요: ${keyFile}`);
  process.exit(1);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
// 키 짝이 맞는지 먼저 확인한다 (틀리면 설치된 쏙들이 업데이트를 거부한다)
const probe = Buffer.from('ssok-key-check');
if (!crypto.verify(null, probe, UPDATE_PUBLIC_KEY, crypto.sign(null, probe, privateKey))) {
  console.error('서명 키가 프로그램에 넣어 둔 공개 키(src/update-key.js)와 짝이 맞지 않아요.');
  process.exit(1);
}

console.log(`== ${APP_NAME} ${version} 릴리스 준비`);
if (!args['skip-tests']) execFileSync(process.execPath, ['--test', 'test/'], { cwd: ROOT, stdio: 'inherit' });
if (!args['skip-android']) execFileSync(process.execPath, ['android/build.mjs'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, SSOK_RELEASE: '1' } });
else {
  // 안드로이드를 다시 만들지 않으면, 넣을 APK가 이 버전으로 만든 것인지 확인한다 (예전 APK를 새 번호로 내보내지 않게)
  let built = '';
  try {
    built = fs.readFileSync(path.join(ROOT, 'android', 'build', 'version.txt'), 'utf8').trim();
  } catch {
    built = '';
  }
  if (built !== version) {
    console.error(`public/ssok.apk는 ${built || '알 수 없는'} 버전이에요. --skip-android 없이 다시 해 주세요.`);
    process.exit(1);
  }
}
node('scripts/build-exe.mjs');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const describe = (from, name) => {
  const data = fs.readFileSync(from);
  fs.writeFileSync(path.join(OUT, name), data);
  return { name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
};
const exe = describe(path.join(ROOT, 'dist', `${APP_NAME}.exe`), `Ssok-${version}.exe`);
// 중계 서버(늘 켜 둔 PC용)는 같은 exe를 이름만 바꿔 올린다. 업데이트 정보에는 넣지 않는다 (중계 서버도 Ssok exe로 업데이트한다)
describe(path.join(ROOT, 'dist', `${APP_NAME}.exe`), `SsokRelay-${version}.exe`);
const apk = fs.existsSync(path.join(ROOT, 'public', 'ssok.apk')) ? describe(path.join(ROOT, 'public', 'ssok.apk'), `ssok-${version}.apk`) : null;

// PC 화면에는 글자 그대로 보이므로 마크다운 굵게 표시(**)는 뺀다 (GitHub 설명에는 그대로 둔다)
const plainNotes = notes.split('**').join('');
const manifest = JSON.stringify({ version, date: new Date().toLocaleDateString('sv-SE'), notes: plainNotes, exe, ...(apk ? { apk } : {}) }, null, 2);
fs.writeFileSync(path.join(OUT, 'latest.json'), manifest);
fs.writeFileSync(path.join(OUT, 'latest.json.sig'), crypto.sign(null, Buffer.from(manifest), privateKey).toString('base64'));
fs.writeFileSync(
  path.join(OUT, 'notes.md'),
  [
    notes,
    '',
    '## 설치',
    `- **Windows**: \`Ssok-${version}.exe\`를 내려받아 실행하세요. 처음 실행하면 스스로 설치되고, 이미 설치되어 있으면 새 버전으로 바뀝니다.`,
    '  "Windows의 PC 보호" 창이 뜨면 [추가 정보] → [실행]을 누르세요.',
    '- **안드로이드 앱**: PC의 쏙 화면(휴대폰으로 QR 스캔)에서 받는 것을 권장합니다. 직접 받으려면 `ssok-' + version + '.apk`.',
    `- **중계 서버** (선택, 늘 켜 둔 PC용): \`SsokRelay-${version}.exe\`. 집 밖에서도 보내기 위한 것으로, 설정 방법은 README의 ‘어디서나 (중계 서버)’를 보세요.`,
    '',
    `<sub>exe SHA-256: \`${exe.sha256}\`</sub>`,
  ].join('\n'),
);

const files = fs.readdirSync(OUT).filter((n) => n !== 'notes.md').map((n) => `"${path.join(OUT, n)}"`);
console.log(`\n만듦: ${path.relative(ROOT, OUT)}`);
console.log(`올리기: gh release create v${version} ${files.join(' ')} --repo ${REPO} --title "${APP_NAME} ${version}" --notes-file "${path.join(OUT, 'notes.md')}"`);
