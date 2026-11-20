// 실행 파일(Ssok.exe) 하나로 배포할 때의 처리.
// exe 안에는 서버 코드와 화면 파일(public/…)이 함께 들어 있다 (Node.js 단일 실행 파일, scripts/build-exe.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sea from 'node:sea';
import { APP_DIR } from './brand.js';

/** 지금 exe로 실행 중인지 */
export function isExe() {
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

/**
 * exe 안에 든 화면 파일을 설정 폴더 아래에 풀고 그 폴더를 돌려준다.
 * 내용이 같으면 다시 풀지 않고, 예전 버전의 폴더는 지운다.
 */
export function extractAssets(home, version) {
  const keys = sea.getAssetKeys().sort();
  const hash = crypto.createHash('sha256');
  for (const key of keys) hash.update(key).update(Buffer.from(sea.getRawAsset(key)));
  const base = path.join(home, 'app');
  const dir = path.join(base, `${version}-${hash.digest('hex').slice(0, 10)}`);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    for (const key of keys) {
      const file = path.join(dir, ...key.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(sea.getRawAsset(key)));
    }
    fs.writeFileSync(path.join(dir, '.complete'), '');
  }
  for (const old of fs.readdirSync(base)) {
    if (old !== path.basename(dir)) fs.rmSync(path.join(base, old), { recursive: true, force: true });
  }
  return dir;
}

/** exe를 설치해 두는 곳 (관리자 권한이 필요 없는 사용자 폴더) */
export function installedExePath() {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, 'Programs', APP_DIR, `${APP_DIR}.exe`) : null;
}

export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 방금 끝난 프로세스가 파일을 놓아줄 때까지 몇 번 다시 시도하며 복사한다 */
export async function copyWithRetry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.copyFileSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 20 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
