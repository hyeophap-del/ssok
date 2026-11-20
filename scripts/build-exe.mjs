// 나눠 줄 실행 파일 하나(dist/쏙.exe)를 만든다.
// 사용법: npm run exe
//
// 1. esbuild로 server.js와 src/를 파일 하나로 묶는다
// 2. Node.js 단일 실행 파일(SEA)로 이 PC의 node.exe에 코드와 화면 파일(public/)을 넣는다
// 3. 아이콘·이름(쏙)·버전을 바꾸고, 콘솔 창이 뜨지 않는 Windows 프로그램으로 표시한다
//
// 받는 사람은 이 exe를 더블클릭만 하면 된다. 처음 실행하면 %LOCALAPPDATA%\Programs\Ssok에 스스로 설치하고,
// 시작 메뉴와 자동 실행을 등록한 뒤 PC 화면을 연다.
// 참고: node.exe의 원래 서명은 코드를 넣으면서 사라진다. 서명이 없으므로 처음 실행할 때 Windows 경고가 뜰 수 있다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as ResEdit from 'resedit';
import { APP_NAME, APP_DIR } from '../src/brand.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const WORK = path.join(OUT, 'exe-build');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (process.platform !== 'win32') {
  console.error('Windows용 exe는 Windows에서 만들어야 해요 (이 PC의 node.exe를 바탕으로 만들기 때문).');
  process.exit(1);
}
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

console.log('1/4 코드 묶기');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'server.js')],
  outfile: path.join(WORK, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // exe 안에서는 import.meta.url을 쓰지 않는다 (src/exe.js가 화면 파일 위치를 정한다)
  define: { 'import.meta.url': '"file:///ssok/server.js"' },
  logLevel: 'warning',
});

console.log('2/4 실행 파일 만들기');
const assets = {};
for (const name of fs.readdirSync(path.join(ROOT, 'public'))) {
  const file = path.join(ROOT, 'public', name);
  if (fs.statSync(file).isFile()) assets[`public/${name}`] = file;
}
const rawExe = path.join(WORK, 'raw.exe');
const config = {
  main: path.join(WORK, 'main.cjs'),
  output: rawExe,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
};
fs.writeFileSync(path.join(WORK, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--build-sea', path.join(WORK, 'sea-config.json')], { stdio: 'inherit' });

console.log('3/4 아이콘·이름 바꾸기');
const exe = ResEdit.NtExecutable.from(fs.readFileSync(rawExe), { ignoreCert: true });
const resources = ResEdit.NtExecutableResource.from(exe);
const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'public', 'icon.ico')));
for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)) {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map((i) => i.data));
}
const [major, minor, patch] = version.split('.').map(Number);
for (const info of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)) {
  for (const lang of info.getAllLanguagesForStringValues()) {
    info.setStringValues(lang, {
      CompanyName: APP_NAME,
      ProductName: APP_NAME,
      // 작업 관리자와 방화벽 허용 창에 보이는 이름
      FileDescription: `${APP_NAME} — 휴대폰·PC 파일 주고받기`,
      FileVersion: version,
      ProductVersion: version,
      OriginalFilename: `${APP_DIR}.exe`,
      InternalName: APP_DIR,
      LegalCopyright: `Node.js ${process.version} 포함 (MIT 라이선스)`,
    });
  }
  info.setFileVersion(major, minor, patch, 0);
  info.setProductVersion(major, minor, patch, 0);
  info.outputToResourceEntries(resources.entries);
}
resources.outputResource(exe);
const binary = Buffer.from(exe.generate());

// 콘솔 창이 뜨지 않는 Windows(GUI) 프로그램으로 표시한다 (PE 헤더의 Subsystem: 3 → 2)
const pe = binary.readUInt32LE(0x3c);
if (binary.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('PE 헤더를 찾지 못했어요');
const subsystemOffset = pe + 24 + 68;
if (binary.readUInt16LE(subsystemOffset) !== 3) throw new Error('예상한 콘솔 프로그램 형식이 아니에요');
binary.writeUInt16LE(2, subsystemOffset);

console.log('4/4 저장');
const target = path.join(OUT, `${APP_NAME}.exe`);
fs.writeFileSync(target, binary);
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`만듦: ${path.relative(ROOT, target)} (${(binary.length / 1024 / 1024).toFixed(1)}MB, 버전 ${version}, Node.js ${process.version})`);
