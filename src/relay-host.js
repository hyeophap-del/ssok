// '쏙 중계 서버' 모드: 늘 켜 둔 PC(예: 본가 PC)에서 돌리는 중계 서버와 그 관리 화면.
//
//   SsokRelay.exe 더블클릭 → %LOCALAPPDATA%\Programs\SsokRelay에 설치 → 뒤에서 실행 → 관리 화면(전용 창)
//   - 중계 서버      127.0.0.1:8780  (Cloudflare 터널이 https://<내 주소> 를 여기로 넘겨준다)
//   - 관리 화면      127.0.0.1:8781  (이 PC에서만 열린다. 터널 연결, 초대 코드 관리)
//   - 알림 영역 아이콘, 로그인할 때 자동 실행, 새 버전이 나오면 쉬는 동안 알아서 업데이트
// 같은 exe(Ssok.exe)라도 파일 이름에 'relay'가 들어 있거나 --relay로 실행하면 이 모드로 돈다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { APP_NAME, APP_ID, APP_DIR, REPO } from './brand.js';
import { createRelayServer } from './relay-server.js';
import { createTunnelManager, cleanHostname } from './cloudflared.js';
import { createAdminServer } from './relay-admin.js';
import { createUpdater } from './update.js';
import { UPDATE_PUBLIC_KEY } from './update-key.js';
import { copyWithRetry, samePath } from './exe.js';
import { openAppWindow, startTray } from './window.js';
import { openPath, openUrl } from './open.js';
import { createShortcut, removeShortcut, startMenuShortcut, startupShortcut, shortcutsSupported } from './windows.js';

export const RELAY_DIR = `${APP_DIR}Relay`;
export const RELAY_NAME = `${APP_NAME} 중계 서버`;
export const RELAY_PORT = 8780;
export const ADMIN_PORT = 8781;
const RELAY_APP_ID = `${APP_ID}-relay`;

/** exe 이름에 relay가 들어 있으면 중계 서버로 동작한다 (Ssok-Relay.exe, SsokRelay.exe 등) */
export const isRelayExe = (execPath) => /relay/i.test(path.basename(execPath));

export function relayHome() {
  if (process.env.SSOK_RELAY_HOME) return path.resolve(process.env.SSOK_RELAY_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, RELAY_DIR);
  return path.join(os.homedir(), `.${APP_ID}-relay`);
}

function installedRelayPath() {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, 'Programs', RELAY_DIR, `${RELAY_DIR}.exe`) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(file, patch) {
  const merged = { ...(readJson(file) ?? {}), ...patch };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, file);
  return merged;
}

/** 이 PC의 관리 화면 서버에 요청한다 (http, 127.0.0.1) */
function adminRequest(method, urlPath, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: ADMIN_PORT, method, path: urlPath, timeout, headers: { 'X-Requested-With': APP_ID } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function pingRelay(timeout) {
  const res = await adminRequest('GET', '/api/ping', timeout);
  return res?.status === 200 && res.json?.app === RELAY_APP_ID ? res.json : null;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * @param {object} options
 * @param {object} options.args         명령줄 옵션 (server.js의 parseCli)
 * @param {boolean} options.exe         exe로 실행 중인지
 * @param {string|null} options.sourceRoot  exe가 아닐 때 프로그램 폴더 (server.js가 있는 곳)
 * @param {string} options.version
 * @param {(home: string, version: string) => string} options.extractAssets
 */
export async function runRelayHost({ args, exe, sourceRoot, version, extractAssets }) {
  const home = relayHome();
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(home, 'config.json');
  const selfArgs = exe ? ['--relay'] : [path.join(sourceRoot, 'server.js'), '--relay'];
  if (exe && !args.background) args.launch = true; // exe를 더블클릭하면 뒤에서 실행하고 관리 화면을 연다

  const showAdmin = async () => {
    const res = await adminRequest('POST', '/api/show', 3000);
    if (res?.status !== 204) openAppWindow(`http://127.0.0.1:${ADMIN_PORT}/`);
  };

  function launchShortcut(file, extra = []) {
    return createShortcut({
      file,
      target: process.execPath,
      args: [...selfArgs.map((a) => (a.startsWith('--') ? a : `"${a}"`)), '--launch', ...extra].join(' '),
      workingDir: exe ? path.dirname(process.execPath) : sourceRoot,
      icon: exe ? process.execPath : path.join(sourceRoot, 'public', 'icon.ico'),
      description: `${RELAY_NAME} — 집 밖에서도 ${APP_NAME}으로 주고받게 이어 주는 서버`,
    });
  }

  async function ensureShortcuts() {
    if (!shortcutsSupported()) return;
    const config = readJson(configPath) ?? {};
    const location = exe ? process.execPath : `${process.execPath}|${sourceRoot}`;
    const menu = startMenuShortcut(RELAY_NAME);
    if (config.shortcutsFor === location && fs.existsSync(menu)) return;
    await launchShortcut(menu);
    const autostart = config.autostart ?? true; // 중계 서버는 늘 켜져 있어야 하므로 처음부터 자동 실행
    if (autostart) await launchShortcut(startupShortcut(RELAY_NAME), ['--no-open']);
    saveConfig(configPath, { shortcutsFor: location, autostart });
  }

  // ---- 실행기: 설치하고, 뒤에서 띄우고, 관리 화면을 연다 ----
  if (args.launch) {
    let running = await pingRelay();
    const installed = exe && process.platform === 'win32' ? installedRelayPath() : null;
    if (installed && !samePath(process.execPath, installed)) {
      if (running && running.version === version && running.exe && samePath(running.exe, installed)) {
        if (!args['no-open']) await showAdmin();
        return;
      }
      if (running) {
        await adminRequest('POST', '/api/quit', 3000);
        for (let i = 0; i < 40 && (await pingRelay(500)); i++) await sleep(250);
        await sleep(500); // cloudflared가 끝날 시간
      }
      await copyWithRetry(process.execPath, installed);
      spawn(installed, ['--relay', '--launch', ...(args['no-open'] ? ['--no-open'] : [])], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return;
    }
    if (!running) {
      const logFile = path.join(home, 'relay.log');
      try {
        if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
      } catch {
        // 기록 파일이 아직 없다
      }
      const out = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, [...selfArgs, '--background', '--no-open'], { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
      child.unref();
      fs.closeSync(out);
      for (let i = 0; i < 60 && !running && child.exitCode === null; i++) {
        await sleep(250);
        running = await pingRelay(1000);
      }
      if (!running) {
        console.error(`${RELAY_NAME}를 시작하지 못했어요. 기록: ${logFile}`);
        openPath(logFile);
        process.exitCode = 1;
        return;
      }
    }
    if (!args['no-open']) await showAdmin();
    await ensureShortcuts().catch((err) => console.error(`바로가기를 만들지 못했어요: ${err.message}`));
    return;
  }

  // ---- 중계 서버 본체 ----
  const root = exe ? extractAssets(home, version) : sourceRoot;
  const publicDir = path.join(root, 'public');
  const log = (type, payload) => {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    if (type === 'error') console.error(`  [${time}] 오류: ${payload?.stack || payload}`);
    else console.log(`  [${time}] ${payload}`);
  };
  if (args.background) console.log(`\n=== ${RELAY_NAME} ${version} 시작 ${new Date().toLocaleString('ko-KR')} ===`);
  let config = readJson(configPath) ?? {};

  const relay = createRelayServer({ dataDir: home, publicDir, version, log });
  const tunnel = createTunnelManager({
    dir: path.join(home, 'cloudflared'),
    localPort: RELAY_PORT,
    onLog: (line) => {
      if (/\b(ERR|WRN)\b|Registered tunnel connection/.test(line)) console.log(`  [cloudflared] ${line}`);
    },
    onChange: (state) => {
      if (state.ready && config.hostname && !reach.ok && !reach.checking && !setup.running) checkPublic().catch(() => {});
    },
  });

  // 바깥(인터넷)에서 이 중계 서버가 보이는지: https://<주소>/api/ping
  const reach = { ok: false, checking: false, checkedAt: null, error: null };
  async function checkPublic({ tries = 1 } = {}) {
    const hostname = config.hostname;
    if (!hostname) return reach;
    reach.checking = true;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(`https://${hostname}/api/ping`, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': RELAY_APP_ID } });
          const json = res.ok ? await res.json() : null;
          if (json?.app !== RELAY_APP_ID) throw new Error(`https://${hostname} 이 이 중계 서버로 이어지지 않아요 (HTTP ${res.status}).`);
          Object.assign(reach, { ok: true, error: null });
          break;
        } catch (err) {
          const message = err.name === 'TimeoutError' ? '응답이 없어요.' : err.cause?.code === 'ENOTFOUND' ? '주소(DNS)를 아직 찾지 못해요. 몇 분 걸릴 수 있어요.' : err.message;
          Object.assign(reach, { ok: false, error: message });
          if (attempt >= tries) break;
          await sleep(10_000);
        }
      }
    } finally {
      reach.checking = false;
      reach.checkedAt = Date.now();
    }
    return reach;
  }

  // 처음 한 번: Cloudflare 터널 연결
  const setup = { running: false, step: null, error: null, loginUrl: null, progress: null, needsRelogin: false };
  function runSetup({ hostname: input, freshLogin = false }) {
    if (setup.running) throw Object.assign(new Error('이미 연결하는 중이에요.'), { status: 409 });
    const hostname = cleanHostname(input);
    if (!hostname) throw Object.assign(new Error('주소를 확인해 주세요. 예: ssok.example.com'), { status: 400 });
    if (hostname.split('.').length < 3) {
      throw Object.assign(new Error(`도메인 앞에 이름을 붙여 주세요. 예: ssok.${hostname} (도메인 자체는 다른 용도로 쓰고 있을 수 있어요)`), { status: 400 });
    }
    Object.assign(setup, { running: true, step: 'download', error: null, loginUrl: null, progress: null, needsRelogin: false });
    (async () => {
      try {
        await tunnel.install({ onProgress: (received, total) => (setup.progress = total ? Math.round((received / total) * 100) : null) });
        setup.progress = null;
        setup.step = 'login';
        await tunnel.login({ fresh: freshLogin, onUrl: (url) => (setup.loginUrl = url) });
        setup.loginUrl = null;
        setup.step = 'tunnel';
        const id = await tunnel.ensureTunnel();
        setup.step = 'dns';
        await tunnel.routeDns(id, hostname);
        config = saveConfig(configPath, { hostname });
        setup.step = 'start';
        tunnel.restart();
        for (let i = 0; i < 60 && !tunnel.state().ready; i++) await sleep(1000);
        if (!tunnel.state().ready) {
          throw new Error(`터널이 Cloudflare에 연결되지 않아요. 인터넷 연결을 확인해 주세요. ${tunnel.state().lastLines.at(-1) ?? ''}`);
        }
        setup.step = 'check';
        Object.assign(reach, { ok: false, error: null });
        await checkPublic({ tries: 12 }); // DNS가 퍼지는 데 1~2분 걸릴 수 있다
        setup.step = 'done';
      } catch (err) {
        log('error', err.message);
        setup.error = err.message;
        setup.needsRelogin = Boolean(err.zone);
      } finally {
        setup.running = false;
      }
    })();
  }

  // 업데이트: 공식 릴리스의 같은 exe를 받아 SsokRelay.exe라는 이름으로 실행한다 (서명·SHA-256 확인은 updater가 한다)
  const releasesUrl = process.env.SSOK_UPDATE_URL ?? (exe ? `https://github.com/${REPO}/releases` : null);
  const updater = releasesUrl
    ? createUpdater({ currentVersion: version, releasesUrl, publicKey: UPDATE_PUBLIC_KEY, downloadDir: path.join(home, 'update') })
    : null;
  try {
    updater?.cleanup();
  } catch {
    // 아직 실행 중이면 다음에 지운다
  }
  let updating = false;
  async function applyUpdate() {
    if (!updater || updating) return;
    updating = true;
    try {
      const file = await updater.download();
      const relayFile = path.join(path.dirname(file), `${RELAY_DIR}.exe`);
      fs.copyFileSync(file, relayFile);
      log('info', `새 버전 ${updater.state().available?.version}으로 바꿔요`);
      // 새 exe가 이 프로세스를 끄고 자기 자신을 설치한 뒤 다시 켠다
      spawn(relayFile, ['--relay', '--launch', '--no-open'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    } catch (err) {
      updating = false;
      log('error', `업데이트하지 못했어요: ${err.message}`);
    }
  }

  let lastPoll = 0; // 관리 화면이 마지막으로 상태를 물어본 때 (열려 있는지 판단)
  let tray = null;
  const adminUrl = `http://127.0.0.1:${ADMIN_PORT}/`;
  function showWindow() {
    if (tray && Date.now() - lastPoll < 6000) tray.activate(RELAY_NAME);
    else openAppWindow(adminUrl);
  }

  let relayError = null;
  const admin = createAdminServer({
    publicDir,
    port: ADMIN_PORT,
    version,
    ping: () => ({ app: RELAY_APP_ID, version, exe: exe ? process.execPath : null }),
    state: () => {
      lastPoll = Date.now();
      const t = tunnel.state();
      return {
        version,
        hostname: config.hostname ?? null,
        relayError,
        tunnel: { installed: tunnel.installed(), configured: tunnel.configured(), running: t.running, ready: t.ready, connections: t.connections, error: t.error, lastLines: t.lastLines.slice(-8) },
        setup: { ...setup },
        reach: { ...reach },
        invites: relay.overview().invites,
        web: relay.webOverview(),
        activeSessions: relay.activeSessions(),
        settings: {
          autostart: shortcutsSupported() ? fs.existsSync(startupShortcut(RELAY_NAME)) : null,
          autoUpdate: updater ? config.autoUpdate !== false : null,
        },
        update: updater ? { ...updater.state(), updating } : null,
      };
    },
    actions: {
      setup: (body) => runSetup({ hostname: body?.hostname, freshLogin: Boolean(body?.freshLogin) }),
      check: () => checkPublic(),
      openLogin: () => setup.loginUrl && openUrl(setup.loginUrl),
      createInvite: (label) => relay.createInvite(label),
      setInviteDisabled: (code, disabled) => relay.setInviteDisabled(code, disabled),
      setWebPin: (pin) => relay.setWebPin(pin),
      removePc: (id) => relay.removePc(id),
      settings: async ({ autostart, autoUpdate }) => {
        if (typeof autostart === 'boolean' && shortcutsSupported()) {
          if (autostart) await launchShortcut(startupShortcut(RELAY_NAME), ['--no-open']);
          else removeShortcut(startupShortcut(RELAY_NAME));
          config = saveConfig(configPath, { autostart });
        }
        if (typeof autoUpdate === 'boolean' && updater) config = saveConfig(configPath, { autoUpdate });
      },
      update: () => applyUpdate(),
      checkUpdate: () => updater?.check(),
      openLog: () => openPath(path.join(home, 'relay.log')),
      show: () => showWindow(),
      quit: () => shutdown(),
    },
    log,
  });

  try {
    await listen(admin, ADMIN_PORT, '127.0.0.1');
  } catch (err) {
    if (err.code === 'EADDRINUSE' && (await pingRelay())) {
      console.log(`${RELAY_NAME}가 이미 실행 중이에요. 관리 화면: ${adminUrl}`);
      if (!args['no-open']) await showAdmin();
      return;
    }
    throw new Error(`관리 화면 포트 ${ADMIN_PORT}을(를) 열지 못했어요: ${err.message}`);
  }
  try {
    await listen(relay.server, RELAY_PORT, '127.0.0.1');
  } catch (err) {
    relayError = `중계 포트 ${RELAY_PORT}을(를) 다른 프로그램이 쓰고 있어요 (${err.code}). 그 프로그램을 끄고 ${RELAY_NAME}를 다시 켜 주세요.`;
    log('error', relayError);
  }
  await tunnel.killLeftover();
  if (config.hostname && !relayError) tunnel.start();

  console.log(`\n  ${RELAY_NAME} ${version} 실행 중`);
  console.log(`  관리 화면     ${adminUrl}`);
  console.log(`  중계 서버     http://127.0.0.1:${RELAY_PORT}  →  ${config.hostname ? `https://${config.hostname}` : '(아직 Cloudflare 터널을 연결하지 않았어요)'}\n`);

  // 바깥에서 보이는지 가끔 확인하고, 새 버전이 있으면 쉬는 동안(주고받는 중이 아닐 때) 업데이트한다
  setInterval(() => config.hostname && tunnel.state().ready && checkPublic().catch(() => {}), 10 * 60_000).unref();
  if (updater) {
    const tick = async () => {
      if (config.autoUpdate === false || updating) return;
      if (!updater.state().available) await updater.check();
      if (updater.state().available && relay.activeSessions() === 0) applyUpdate();
    };
    setTimeout(tick, 60_000).unref();
    setInterval(tick, 6 * 60 * 60_000).unref();
  }

  if (args.background) {
    tray = startTray({
      iconPath: exe ? process.execPath : path.join(root, 'public', 'icon.ico'),
      tooltip: RELAY_NAME,
      openLabel: '관리 화면 열기',
      onOpen: () => showWindow(),
      onQuit: () => shutdown(),
      log,
    });
  }
  if (!args['no-open']) showWindow();

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    tray?.close();
    tunnel.stop();
    await Promise.race([Promise.all([relay.close(), new Promise((r) => admin.close(() => r()))]), sleep(1500)]);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}
