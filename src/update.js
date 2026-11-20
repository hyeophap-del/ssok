// 새 버전 확인과 업데이트 (exe로 설치한 경우).
//
// GitHub 릴리스에 올린 latest.json(버전·변경 내용·exe의 크기와 SHA-256)과 그 서명(latest.json.sig)을 받아,
// 프로그램 안에 넣어 둔 공개 키로 서명을 확인한다. 서명이 맞고 더 새 버전이면 PC 화면에 알리고,
// 사용자가 [업데이트]를 누르면 exe를 내려받아 SHA-256까지 맞는지 본 뒤 실행한다.
// 새 exe는 실행되면 지금 돌고 있는 예전 버전을 끄고 자기 자신을 설치한다 (server.js의 launch 참고).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** "1.10.0" > "1.9.3" 처럼 버전을 비교한다 (a가 크면 양수) */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** 서명을 확인하고 내용을 검사한 업데이트 정보. 하나라도 이상하면 예외. */
export function readManifest(text, signatureBase64, publicKeyPem) {
  const signature = Buffer.from(String(signatureBase64).trim(), 'base64');
  const ok = crypto.verify(null, Buffer.from(text, 'utf8'), crypto.createPublicKey(publicKeyPem), signature);
  if (!ok) throw new Error('업데이트 정보의 서명이 맞지 않아요.');
  const manifest = JSON.parse(text);
  const file = manifest?.exe;
  if (
    !VERSION.test(manifest?.version || '') ||
    !file ||
    !SAFE_NAME.test(file.name || '') ||
    !/^[0-9a-f]{64}$/.test(file.sha256 || '') ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0
  ) {
    throw new Error('업데이트 정보가 올바르지 않아요.');
  }
  return { version: manifest.version, notes: typeof manifest.notes === 'string' ? manifest.notes.slice(0, 4000) : '', exe: file };
}

/**
 * @param {object} options
 * @param {string} options.currentVersion
 * @param {string} options.releasesUrl     예: https://github.com/<소유자>/<저장소>/releases
 * @param {string} options.publicKey       서명 확인용 공개 키 (PEM)
 * @param {string} options.downloadDir     내려받은 exe를 둘 폴더
 * @param {(state: object) => void} [options.onChange]  상태가 바뀔 때 (PC 화면에 알린다)
 * @param {typeof fetch} [options.fetch]
 */
export function createUpdater({ currentVersion, releasesUrl, publicKey, downloadDir, onChange = () => {}, fetch: fetchImpl = fetch }) {
  const state = { current: currentVersion, checking: false, available: null, error: null, progress: null, lastChecked: null };
  let manifest = null;
  const changed = () => onChange(publicState());
  const headers = { 'User-Agent': `ssok-updater/${currentVersion}` };

  function publicState() {
    const { current, checking, available, error, progress, lastChecked } = state;
    return { current, checking, available, error, progress, lastChecked };
  }

  async function getText(url) {
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.text();
  }

  /** 새 버전이 있는지 확인한다 */
  async function check() {
    if (state.checking || state.progress) return publicState();
    state.checking = true;
    state.error = null;
    changed();
    try {
      const [text, signature] = await Promise.all([
        getText(`${releasesUrl}/latest/download/latest.json`),
        getText(`${releasesUrl}/latest/download/latest.json.sig`),
      ]);
      const found = readManifest(text, signature, publicKey);
      manifest = compareVersions(found.version, currentVersion) > 0 ? found : null;
      state.available = manifest && { version: manifest.version, notes: manifest.notes, size: manifest.exe.size };
    } catch (err) {
      // 아직 릴리스가 없거나(404) 인터넷이 안 되면 조용히 넘어간다. 서명 문제는 알린다.
      state.error = err.status === 404 || err.name === 'TimeoutError' || err.cause ? null : err.message;
    } finally {
      state.checking = false;
      state.lastChecked = Date.now();
      changed();
    }
    return publicState();
  }

  /** 새 exe를 내려받아 확인하고 그 경로를 돌려준다. 실행은 부르는 쪽에서 한다. */
  async function download() {
    if (!manifest) throw new Error('새 버전이 없어요.');
    if (state.progress) throw new Error('이미 업데이트하는 중이에요.');
    const { exe, version } = manifest;
    fs.mkdirSync(downloadDir, { recursive: true });
    const target = path.join(downloadDir, exe.name);
    const partial = `${target}.part`;
    state.progress = { version, received: 0, size: exe.size };
    state.error = null;
    changed();
    try {
      const res = await fetchImpl(`${releasesUrl}/download/v${version}/${exe.name}`, { headers, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`내려받지 못했어요 (HTTP ${res.status}).`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(partial);
      let lastReport = 0;
      for await (const chunk of res.body) {
        hash.update(chunk);
        state.progress.received += chunk.length;
        if (state.progress.received > exe.size) throw new Error('받은 파일이 예상보다 커요.');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastReport > 300) {
          lastReport = Date.now();
          changed();
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (state.progress.received !== exe.size || hash.digest('hex') !== exe.sha256) {
        throw new Error('받은 파일이 올린 파일과 달라요. 다시 시도해 주세요.');
      }
      fs.renameSync(partial, target);
      return target;
    } catch (err) {
      fs.rmSync(partial, { force: true });
      state.progress = null;
      state.error = err.message;
      changed();
      throw err;
    }
  }

  /** 지난 업데이트 때 받아 둔 파일 정리 */
  function cleanup() {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  return { check, download, cleanup, state: publicState };
}
