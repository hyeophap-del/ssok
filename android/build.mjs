// 안드로이드 앱(APK)을 Gradle 없이 SDK 도구로 바로 빌드한다.
// 사용법: npm run android   →  public/ssok.apk (PC의 쏙이 휴대폰에 이 파일을 내려준다)
//
// 필요한 것 (모두 사용자 폴더에 설치, 관리자 권한 필요 없음)
//   JDK 17 이상          JAVA_HOME 또는 %LOCALAPPDATA%\Programs\jdk-*
//   Android SDK          ANDROID_HOME 또는 %LOCALAPPDATA%\Android\Sdk  (platforms;android-35, build-tools;35.0.0)
// 서명 키는 저장소 밖(%USERPROFILE%\.ssok-android)에 처음 한 번 만든다. 이 키를 잃어버리면
// 이미 설치한 휴대폰에서 앱을 업데이트할 수 없으니(지우고 다시 설치해야 함) 꼭 따로 보관하자.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'build');
const BUILD_TOOLS = '35.0.0';
const PLATFORM = 'android-35';
const MIN_SDK = 26;

const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const sdk = process.env.ANDROID_HOME ?? path.join(local, 'Android', 'Sdk');
const javaHome =
  process.env.JAVA_HOME ??
  fs
    .readdirSync(path.join(local, 'Programs'))
    .filter((name) => /^jdk-(1[7-9]|2\d)/.test(name))
    .map((name) => path.join(local, 'Programs', name))
    .sort()
    .at(-1);
const exe = process.platform === 'win32' ? '.exe' : '';
const tools = {
  java: path.join(javaHome ?? '', 'bin', `java${exe}`),
  javac: path.join(javaHome ?? '', 'bin', `javac${exe}`),
  keytool: path.join(javaHome ?? '', 'bin', `keytool${exe}`),
  aapt: path.join(sdk, 'build-tools', BUILD_TOOLS, `aapt${exe}`),
  aapt2: path.join(sdk, 'build-tools', BUILD_TOOLS, `aapt2${exe}`),
  zipalign: path.join(sdk, 'build-tools', BUILD_TOOLS, `zipalign${exe}`),
  d8: path.join(sdk, 'build-tools', BUILD_TOOLS, 'lib', 'd8.jar'),
  apksigner: path.join(sdk, 'build-tools', BUILD_TOOLS, 'lib', 'apksigner.jar'),
  androidJar: path.join(sdk, 'platforms', PLATFORM, 'android.jar'),
  // 람다를 javac가 컴파일할 수 있게 해 주는 빈 껍데기 (실제 동작은 d8이 바꿔 넣는다)
  lambdaStubs: path.join(sdk, 'build-tools', BUILD_TOOLS, 'core-lambda-stubs.jar'),
};
for (const [name, file] of Object.entries(tools)) {
  if (!fs.existsSync(file)) {
    console.error(`${name}을(를) 찾지 못했어요: ${file}\nJDK와 Android SDK(${PLATFORM}, build-tools ${BUILD_TOOLS})를 설치해 주세요.`);
    process.exit(1);
  }
}

const run = (file, args, options = {}) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
const javaEnv = { ...process.env, JAVA_HOME: javaHome };

function filesUnder(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full, ext) : full.endsWith(ext) ? [full] : [];
  });
}

// 버전은 PC 프로그램과 같이 간다 (1.2.3 → 10203)
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const [major, minor, patch] = version.split('.').map(Number);
// 1.2.3 → 10203: 부 번호가 100을 넘으면 다른 버전과 번호가 겹치므로 멈춘다
if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0) || minor > 99 || patch > 99) {
  console.error(`안드로이드 버전 번호로 바꿀 수 없는 버전이에요: ${version} (가운데·끝 번호는 0~99)`);
  process.exit(1);
}
const versionCode = String(major * 10000 + minor * 100 + patch);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'gen'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'classes'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'dex'), { recursive: true });

console.log('1/6 리소스 컴파일');
run(tools.aapt2, ['compile', '--dir', path.join(HERE, 'res'), '-o', path.join(OUT, 'res.zip')]);
run(tools.aapt2, [
  'link',
  '-I', tools.androidJar,
  '--manifest', path.join(HERE, 'AndroidManifest.xml'),
  '--min-sdk-version', String(MIN_SDK),
  '--target-sdk-version', PLATFORM.split('-')[1],
  '--version-code', versionCode,
  '--version-name', version,
  '--java', path.join(OUT, 'gen'),
  '-o', path.join(OUT, 'unsigned.apk'),
  path.join(OUT, 'res.zip'),
]);

console.log('2/6 자바 컴파일');
const sources = [...filesUnder(path.join(HERE, 'java'), '.java'), ...filesUnder(path.join(OUT, 'gen'), '.java')];
run(tools.javac, ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options', '-bootclasspath', [tools.androidJar, tools.lambdaStubs].join(path.delimiter), '-d', path.join(OUT, 'classes'), ...sources], { env: javaEnv });

console.log('3/6 DEX 변환');
run(tools.java, ['-cp', tools.d8, 'com.android.tools.r8.D8', '--release', '--min-api', String(MIN_SDK), '--lib', tools.androidJar, '--output', path.join(OUT, 'dex'), ...filesUnder(path.join(OUT, 'classes'), '.class')], { env: javaEnv });

console.log('4/6 APK에 코드 넣기');
run(tools.aapt, ['add', path.join(OUT, 'unsigned.apk'), 'classes.dex'], { cwd: path.join(OUT, 'dex') });
run(tools.zipalign, ['-f', '-p', '4', path.join(OUT, 'unsigned.apk'), path.join(OUT, 'aligned.apk')]);

console.log('5/6 서명');
const keyDir = process.env.SSOK_ANDROID_KEYS ?? path.join(os.homedir(), '.ssok-android');
const keystore = path.join(keyDir, 'release.jks');
const passFile = path.join(keyDir, 'password.txt');
if (!fs.existsSync(keystore) && process.env.SSOK_RELEASE === '1') {
  // 릴리스 중에 새 키를 만들면, 이미 설치한 휴대폰이 업데이트를 거부한다 (서명이 달라서)
  console.error(`안드로이드 서명 키가 없어요: ${keystore}\n백업해 둔 키를 이 자리에 넣거나 SSOK_ANDROID_KEYS로 알려 주세요.`);
  process.exit(1);
}
if (!fs.existsSync(keystore)) {
  fs.mkdirSync(keyDir, { recursive: true });
  const password = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(passFile, password, { mode: 0o600 });
  run(tools.keytool, ['-genkeypair', '-keystore', keystore, '-storepass', password, '-keypass', password, '-alias', 'ssok', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Ssok'], { env: javaEnv });
  console.log(`   새 서명 키를 만들었어요: ${keystore}  (꼭 따로 백업해 두세요)`);
}
const apk = path.join(ROOT, 'public', 'ssok.apk');
run(tools.java, ['-jar', tools.apksigner, 'sign', '--ks', keystore, '--ks-pass', `file:${passFile}`, '--ks-key-alias', 'ssok', '--out', apk, path.join(OUT, 'aligned.apk')], { env: javaEnv });
fs.rmSync(`${apk}.idsig`, { force: true });

console.log('6/6 확인');
run(tools.java, ['-jar', tools.apksigner, 'verify', '--min-sdk-version', String(MIN_SDK), apk], { env: javaEnv });
fs.writeFileSync(path.join(OUT, 'version.txt'), version); // 릴리스가 APK 버전을 확인한다 (--skip-android일 때)
console.log(`만듦: public/ssok.apk (${(fs.statSync(apk).size / 1024).toFixed(0)}KB, 버전 ${version})`);
