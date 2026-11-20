#!/usr/bin/env node
// 같은 Wi-Fi에 있는 PC와 휴대폰이 파일·텍스트를 주고받게 해 주는 작은 서버.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp, newToken, isPartialUpload, VERSION } from './src/app.js';
import { Store } from './src/store.js';
import { lanAddresses, broadcastAddresses } from './src/net.js';
import { PeerBook, newPeerId, cleanName, pingApp } from './src/peers.js';
import { APP_NAME, APP_ID, APP_DIR, RECEIVED_DIR_NAME, REPO } from './src/brand.js';
import { startDiscovery } from './src/discovery.js';
import { loadIdentity } from './src/tls.js';
import { encodeQR, toTerminal } from './src/qr.js';
import { openPath, revealPath } from './src/open.js';
import { openAppWindow, startTray } from './src/window.js';
import { redactLog } from './src/logs.js';
import {
  publicNetworkAdapters,
  shortcutsSupported,
  startMenuShortcut,
  startupShortcut,
  createShortcut,
  removeShortcut,
} from './src/windows.js';
import { spawn } from 'node:child_process';
import { isExe, extractAssets, installedExePath, samePath, copyWithRetry } from './src/exe.js';
import { requestJson } from './src/peers.js';
import { createUpdater } from './src/update.js';
import { UPDATE_PUBLIC_KEY } from './src/update-key.js';

// exe로 배포했을 때는 코드와 화면 파일이 exe 안에 있다 (화면 파일은 처음 실행할 때 풀어 둔다)
const EXE = isExe();
let ROOT = EXE ? null : path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8765;
/** 같은 프로그램을 다시 실행할 때 붙이는 인자 (node.exe로 실행할 때는 server.js 경로가 필요하다) */
const selfArgs = () => (EXE ? [] : [path.join(ROOT, 'server.js')]);

const HELP = `
${APP_NAME} ${VERSION} — PC·휴대폰 사이 무선 파일 공유

사용법: node server.js [옵션]

  --launch           창 없이 뒤에서 실행하고 PC 화면을 연다 (이미 실행 중이면 화면만 연다).
                     처음 실행할 때 시작 메뉴 바로가기와 'PC 켤 때 자동 실행'을 등록한다.
  --dir <폴더>       휴대폰에서 받은 파일을 저장할 폴더 (기본: 다운로드\\${RECEIVED_DIR_NAME}, 한 번 정하면 기억)
  --port <번호>      사용할 포트 (기본: ${DEFAULT_PORT})
  --host <주소>      접속을 받을 주소 (기본: 0.0.0.0 = 모든 네트워크, 127.0.0.1 = 이 PC만)
  --name <이름>      다른 PC에 보일 이 PC의 이름 (기본: 컴퓨터 이름, 한 번 정하면 기억)
  --no-open          시작할 때 브라우저를 열지 않음
  --reset-token      접속 코드를 새로 만듦 (이미 연결된 휴대폰은 QR을 다시 스캔해야 함)
  -h, --help         이 도움말
`;

function parseCli() {
  try {
    const { values } = parseArgs({
      options: {
        dir: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        name: { type: 'string' },
        'no-open': { type: 'boolean' },
        'reset-token': { type: 'boolean' },
        launch: { type: 'boolean' },
        background: { type: 'boolean' }, // --launch가 띄우는 뒤쪽 프로세스 (직접 쓰지 않는다)
        help: { type: 'boolean', short: 'h' },
      },
    });
    return values;
  } catch (err) {
    console.error(`${err.message}\n${HELP}`);
    process.exit(2);
  }
}

function appHome() {
  if (process.env.SSOK_HOME) return path.resolve(process.env.SSOK_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, APP_DIR);
  return path.join(os.homedir(), `.${APP_ID}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** 설정을 저장한다. 다른 프로세스(실행기·뒤쪽 서버)가 적어 둔 값은 지우지 않고 합친다. */
function saveConfig(file, config) {
  writeJson(file, { ...(readJson(file) ?? {}), ...config });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PC 화면 창의 제목 (알림 영역 아이콘이 이 제목으로 창을 찾아 앞으로 가져온다. public/app.js와 같아야 한다) */
const HOST_TITLE = `${APP_NAME} · PC`;

/** 돌고 있는 쏙에게 PC 화면 창을 보여 달라고 한다. 예전 버전이라 못 알아들으면 직접 연다. */
async function askToShow(port) {
  try {
    const { status } = await requestJson({ address: '127.0.0.1', port }, { method: 'POST', path: '/api/show', timeout: 3000 });
    if (status === 204) return;
  } catch {
    // 아래에서 직접 연다
  }
  openAppWindow(`http://localhost:${port}/`);
}

/** 시작 메뉴·자동 실행 바로가기: 지금 이 프로그램(exe, 또는 node.exe + server.js)을 --launch로 실행한다 */
function createLaunchShortcut(file, extraArgs = []) {
  return createShortcut({
    file,
    target: process.execPath,
    args: [...selfArgs().map((a) => `"${a}"`), '--launch', ...extraArgs].join(' '),
    workingDir: EXE ? path.dirname(process.execPath) : ROOT,
    icon: EXE ? process.execPath : path.join(ROOT, 'public', 'icon.ico'),
    description: `${APP_NAME} — 휴대폰·PC와 파일 주고받기`,
  });
}

/** 처음 실행했거나 프로그램 폴더를 옮겼으면 바로가기를 (다시) 만든다 */
async function ensureShortcuts(configPath) {
  if (!shortcutsSupported()) return;
  const config = readJson(configPath) ?? {};
  const location = EXE ? process.execPath : `${process.execPath}|${ROOT}`;
  const menu = startMenuShortcut(APP_NAME);
  const startup = startupShortcut(APP_NAME);
  if (config.shortcutsFor === location && fs.existsSync(menu)) return;
  await createLaunchShortcut(menu);
  // 처음에는 'PC 켤 때 자동 실행'을 켠다 (PC 화면의 설정에서 끌 수 있다). 폴더를 옮겼으면 기존 선택을 따른다.
  const autostart = config.autostart ?? true;
  if (autostart) await createLaunchShortcut(startup, ['--no-open']);
  saveConfig(configPath, { shortcutsFor: location, autostart });
}

/**
 * 창 없이 뒤에서 실행하고 PC 화면을 연다. 이미 실행 중이면 화면만 연다.
 * 시작 메뉴 바로가기, 자동 실행, 배포용 실행 파일이 모두 이 방식으로 실행한다.
 */
async function launch(args, home, configPath) {
  const portOf = () => (args.port ? Number(args.port) : (readJson(configPath)?.port ?? DEFAULT_PORT));
  let port = portOf();
  let running = await pingApp({ address: '127.0.0.1', port });

  // 받은 exe를 처음 실행했으면 사용자 폴더에 설치하고, 설치한 exe로 다시 실행한다.
  // (다운로드 폴더의 exe는 지워도 되고, 방화벽 허용도 설치한 위치 기준으로 한 번만 하면 된다)
  const installed = EXE && process.platform === 'win32' ? installedExePath() : null;
  if (installed && !samePath(process.execPath, installed)) {
    if (running && running.version === VERSION && running.exe && samePath(running.exe, installed)) {
      if (!args['no-open']) await askToShow(port);
      return; // 같은 버전이 이미 설치되어 돌고 있다
    }
    if (running) {
      // 예전 버전(또는 다른 위치의 쏙)이 돌고 있으면 끄고 바꾼다
      await requestJson({ address: '127.0.0.1', port }, { method: 'POST', path: '/api/quit', timeout: 3000 }).catch(() => {});
      for (let i = 0; i < 40 && (await pingApp({ address: '127.0.0.1', port }, { timeout: 500 })); i++) await sleep(250);
    }
    await copyWithRetry(process.execPath, installed);
    const passthrough = ['port', 'host'].flatMap((k) => (args[k] !== undefined ? [`--${k}`, args[k]] : []));
    spawn(installed, ['--launch', ...(args['no-open'] ? ['--no-open'] : []), ...passthrough], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  if (!running) {
    const logFile = path.join(home, `${APP_ID}.log`);
    try {
      if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
    } catch {
      // 기록 파일이 아직 없다
    }
    const out = fs.openSync(logFile, 'a');
    const passthrough = ['port', 'host'].flatMap((k) => (args[k] !== undefined ? [`--${k}`, args[k]] : []));
    const child = spawn(process.execPath, [...selfArgs(), '--background', '--no-open', ...passthrough], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    fs.closeSync(out);
    // 뜰 때까지 기다린다 (포트가 바뀌었을 수 있어 설정을 다시 읽는다)
    for (let i = 0; i < 60 && !running && child.exitCode === null; i++) {
      await sleep(250);
      port = portOf();
      running = await pingApp({ address: '127.0.0.1', port }, { timeout: 1000 });
    }
    if (!running) {
      console.error(`${APP_NAME} 프로그램을 시작하지 못했어요. 기록: ${logFile}`);
      openPath(logFile);
      process.exitCode = 1;
      return;
    }
  }
  if (!args['no-open']) await askToShow(port);
  await ensureShortcuts(configPath).catch((err) => console.error(`바로가기를 만들지 못했어요: ${err.message}`));
}

/**
 * 문제가 생겼을 때 보내 달라고 할 기록 파일을 만들어 메모장으로 연다.
 * 실행 기록에는 휴대폰 접속 주소(접속 코드 포함)가 찍혀 있으므로 접속 코드는 가린다.
 */
function openLogForSharing(home, token) {
  const logFile = path.join(home, `${APP_ID}.log`);
  const parts = [`${logFile}.old`, logFile].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
  if (!parts.length) throw Object.assign(new Error('아직 기록이 없어요. 시작 메뉴의 쏙으로 실행했을 때부터 기록이 남아요.'), { status: 404 });
  let text = parts.join('\n');
  text = redactLog(text, token).slice(-200_000);
  const header = [
    `${APP_NAME} ${VERSION} 실행 기록 · ${new Date().toLocaleString('ko-KR')}`,
    `Windows ${os.release()} · ${EXE ? 'exe' : 'Node.js ' + process.version}`,
    '접속 코드는 ●●●●로 가렸어요. 이 파일을 그대로 보내 주세요.',
    '',
  ].join('\r\n');
  const out = path.join(home, '문제 기록.txt');
  fs.writeFileSync(out, String.fromCharCode(0xfeff) + header + '\r\n' + text.replace(/\r?\n/g, '\r\n'));
  openPath(out);
}

/** 예전 이름(Galaxy File)으로 쓰던 설정·목록·받은 파일 폴더를 그대로 이어 쓴다 */
function migrateLegacyHome(home) {
  if (process.env.SSOK_HOME || !process.env.LOCALAPPDATA) return;
  const legacy = path.join(process.env.LOCALAPPDATA, 'GalaxyFile');
  if (!fs.existsSync(legacy) || fs.existsSync(home)) return;
  try {
    fs.renameSync(legacy, home);
  } catch {
    return; // 옮기지 못하면 새로 시작한다
  }
  const moves = [[legacy, home]];
  // 기본 위치(다운로드\Galaxy File)에 받아 둔 파일은 새 이름의 폴더로 옮긴다. 옮기지 못하면 예전 폴더를 계속 쓴다.
  const configPath = path.join(home, 'config.json');
  const config = readJson(configPath);
  const oldReceived = path.join(os.homedir(), 'Downloads', 'Galaxy File');
  const newReceived = path.join(os.homedir(), 'Downloads', RECEIVED_DIR_NAME);
  if (config && !config.dir && fs.existsSync(oldReceived)) {
    try {
      if (fs.existsSync(newReceived)) throw new Error('이미 있음');
      fs.renameSync(oldReceived, newReceived);
      moves.push([oldReceived, newReceived]);
    } catch {
      config.dir = oldReceived;
      writeJson(configPath, config);
    }
  }
  // 목록에 적힌 파일 경로도 옮긴 폴더로 고친다
  const itemsPath = path.join(home, 'items.json');
  const items = readJson(itemsPath);
  if (Array.isArray(items?.items)) {
    for (const item of items.items) {
      if (typeof item.path !== 'string') continue;
      const move = moves.find(([from]) => item.path.startsWith(from + path.sep));
      if (move) item.path = move[1] + item.path.slice(move[0].length);
    }
    writeJson(itemsPath, items);
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** 지난 실행에서 남은 찌꺼기 정리: 목록에 없는 보낼 파일, 끊긴 업로드의 임시 파일 */
async function cleanup(outboxDir, receivedDir, store) {
  const live = new Set(store.list().filter((i) => i.kind === 'file' && i.from === 'host').map((i) => i.id));
  for (const entry of await fsp.readdir(outboxDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !live.has(entry.name)) {
      await fsp.rm(path.join(outboxDir, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const name of await fsp.readdir(receivedDir).catch(() => [])) {
    if (isPartialUpload(name)) await fsp.rm(path.join(receivedDir, name), { force: true }).catch(() => {});
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function logEvent(type, payload) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  if (type === 'add') {
    const route = payload.from === 'host' ? 'PC → 휴대폰' : `${payload.device} → PC`;
    const what =
      payload.kind === 'file'
        ? `${payload.name} (${formatSize(payload.size)})`
        : `텍스트 "${payload.text.replace(/\s+/g, ' ').slice(0, 40)}${payload.text.length > 40 ? '…' : ''}"`;
    console.log(`  [${time}] ${route}  ${what}`);
  } else if (type === 'connect') {
    console.log(`  [${time}] ${payload} 연결됨`);
  } else if (type === 'peer-sent') {
    const { to, item } = payload;
    const what = item?.kind === 'file' ? `${item.name} (${formatSize(item.size)})` : '텍스트';
    console.log(`  [${time}] PC → ${to}  ${what}`);
  } else if (type === 'pair-request') {
    const who = payload.kind === 'app' ? `${payload.name}(휴대폰 앱, ${payload.address})` : `${payload.name}(${payload.address})`;
    console.log(`  [${time}] ${who}에서 연결을 요청했어요. 확인 숫자 ${payload.code.slice(0, 3)} ${payload.code.slice(3)} — ${APP_NAME} 화면에서 허용해 주세요.`);
  } else if (type === 'paired') {
    console.log(`  [${time}] ${payload} 연결됨 — 이제 서로 파일을 보낼 수 있어요`);
  } else if (type === 'unpaired') {
    console.log(`  [${time}] ${payload} 연결 해제됨`);
  } else if (type === 'upload-cancelled') {
    console.log(`  [${time}] 전송 취소됨: ${payload}`);
  } else if (type === 'error') {
    console.error(`  [${time}] 오류: ${payload?.stack || payload}`);
  }
}

async function main() {
  const args = parseCli();
  if (args.help) {
    console.log(HELP);
    return;
  }
  // exe는 창이 없는 프로그램이라, 그냥 더블클릭하면 --launch로 동작한다
  if (EXE && !args.background) args.launch = true;

  const home = appHome();
  migrateLegacyHome(home);
  fs.mkdirSync(home, { recursive: true });
  if (EXE) ROOT = extractAssets(home, VERSION);
  const configPath = path.join(home, 'config.json');
  const config = readJson(configPath) ?? {};
  if (!config.token || args['reset-token']) config.token = newToken();
  if (args.dir) config.dir = path.resolve(args.dir);
  if (!config.id) config.id = newPeerId();
  if (args.name !== undefined) config.name = cleanName(args.name) || undefined;
  let pcName = config.name || cleanName(os.hostname()) || '내 PC';

  if (args.launch) {
    saveConfig(configPath, config); // 뒤에서 뜰 프로세스가 같은 설정(접속 코드 등)을 쓰도록 먼저 저장
    return launch(args, home, configPath);
  }
  if (args.background) console.log(`\n=== ${APP_NAME} ${VERSION} 시작 ${new Date().toLocaleString('ko-KR')} ===`);

  const receivedDir = config.dir ?? path.join(os.homedir(), 'Downloads', RECEIVED_DIR_NAME);
  const outboxDir = path.join(home, 'outbox');
  fs.mkdirSync(receivedDir, { recursive: true });
  fs.mkdirSync(outboxDir, { recursive: true });

  const store = new Store(path.join(home, 'items.json')).load();
  const peerBook = new PeerBook(path.join(home, 'peers.json')).load();
  const identity = loadIdentity(home, pcName); // 다른 PC·앱과 암호화해서 주고받을 때 쓰는 인증서
  await cleanup(outboxDir, receivedDir, store);

  const host = args.host ?? '0.0.0.0';
  const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);

  // 네트워크가 '공용 네트워크'면 미리 알려 준다. 집 Wi-Fi라면 방화벽에 막히기 쉽고,
  // 정말 여러 사람이 쓰는 Wi-Fi라면 휴대폰 브라우저와 주고받는 내용(HTTP)을 엿볼 수 있다.
  let networkWarnings = [];
  const checkNetworks = () =>
    publicNetworkAdapters().then((adapters) => {
      networkWarnings = lanAddresses()
        .filter((a) => adapters.includes(a.iface))
        .map(
          ({ iface }) =>
            `‘${iface}’ 네트워크가 공용 네트워크로 설정되어 있어요. ` +
            `집 Wi-Fi라면 설정 → 네트워크 및 인터넷 → ${iface} → 연결된 네트워크 속성에서 ‘개인 네트워크’로 바꿔 주세요(휴대폰 접속이 막힐 수 있어요). ` +
            `카페·회사처럼 여러 사람이 쓰는 Wi-Fi라면 휴대폰 브라우저로 주고받는 내용은 암호화되지 않으니, 휴대폰 핫스팟에 PC를 연결해서 쓰세요. ` +
            `(PC끼리, 그리고 ${APP_NAME} 앱은 항상 암호화돼요)`,
        );
    });
  const publicCheck = localOnly ? Promise.resolve() : checkNetworks();
  if (!localOnly) setInterval(checkNetworks, 60_000).unref(); // 설정을 바꾸면 1분 안에 경고가 사라진다

  const self = { id: config.id, name: pcName }; // 이름은 PC 화면에서 바꿀 수 있다

  // 새 버전 확인 (exe로 설치했을 때만. 시험할 때는 SSOK_UPDATE_URL로 다른 곳을 가리킬 수 있다)
  const releasesUrl = process.env.SSOK_UPDATE_URL ?? (EXE ? `https://github.com/${REPO}/releases` : null);
  const updateCore = releasesUrl
    ? createUpdater({
        currentVersion: VERSION,
        releasesUrl,
        publicKey: UPDATE_PUBLIC_KEY,
        downloadDir: path.join(home, 'update'),
        onChange: (state) => app?.broadcastHost('update', state),
      })
    : null;
  try {
    updateCore?.cleanup(); // 지난번 업데이트 때 받아 둔 파일
  } catch {
    // 아직 그 파일이 실행 중이면 다음에 지운다
  }
  const updater = updateCore && {
    state: updateCore.state,
    check: updateCore.check,
    apply: async () => {
      const file = await updateCore.download();
      app.broadcastHost('update', { ...updateCore.state(), restarting: true });
      // 새 exe는 실행되면 이 프로세스를 끄고 자기 자신을 설치한 뒤 다시 켠다 (launch 참고)
      const keep = ['port', 'host'].flatMap((k) => (args[k] !== undefined ? [`--${k}`, args[k]] : [])); // 실행 옵션은 그대로
      spawn(file, ['--launch', '--no-open', ...keep], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    },
  };

  const app = createApp({
    token: config.token,
    receivedDir,
    outboxDir,
    store,
    publicDir: path.join(ROOT, 'public'),
    lanAddresses: () => (localOnly ? [{ address: '127.0.0.1', iface: '이 PC에서만 (--host 127.0.0.1)' }] : lanAddresses()),
    opener: { open: openPath, reveal: revealPath },
    warnings: () => networkWarnings,
    self,
    tls: identity,
    settings: {
      get: () => ({
        name: pcName,
        autostart: shortcutsSupported() ? fs.existsSync(startupShortcut(APP_NAME)) : null,
        autoUpdate: updater ? config.autoUpdate !== false : null,
        version: VERSION,
      }),
      set: async ({ name, autostart, autoUpdate }) => {
        if (autoUpdate !== undefined && updater) {
          config.autoUpdate = Boolean(autoUpdate);
          if (autoUpdate) updater.check();
        }
        if (name !== undefined) {
          const clean = cleanName(name);
          if (!clean) throw Object.assign(new Error('이름을 입력해 주세요.'), { status: 400 });
          pcName = self.name = config.name = clean;
          discovery?.announce(); // 주변 PC 목록에 새 이름이 바로 보이게
        }
        if (autostart !== undefined && shortcutsSupported()) {
          if (autostart) await createLaunchShortcut(startupShortcut(APP_NAME), ['--no-open']);
          else removeShortcut(startupShortcut(APP_NAME));
          config.autostart = Boolean(autostart);
        }
        saveConfig(configPath, config);
      },
    },
    onQuit: () => shutdown(),
    onShow: () => showWindow(),
    openLog: () => openLogForSharing(home, config.token),
    onHostPagesClosed: () => {
      // 창을 처음 닫았을 때 한 번만: 꺼진 게 아니라 알림 영역에서 계속 받고 있다고 알려 준다
      if (!tray || config.trayHintShown) return;
      config.trayHintShown = true;
      saveConfig(configPath, config);
      tray.balloon(`${APP_NAME}은(는) 계속 실행 중이에요`, '창을 닫아도 휴대폰·다른 PC에서 보내면 바로 받아요. 끄려면 이 아이콘을 오른쪽 클릭하세요.');
    },
    updater,
    peerBook,
    announce: () => discovery?.announce(),
    showHostPage: () => {
      // 다른 기기가 연결을 요청했는데 이 PC 화면이 닫혀 있으면 열어 준다 (너무 자주 열지는 않는다)
      if (Date.now() - lastShown < 5 * 60_000) return;
      lastShown = Date.now();
      showWindow();
    },
    log: logEvent,
  });
  let discovery = null;
  let lastShown = 0;
  let tray = null; // 알림 영역(작업 표시줄 오른쪽) 아이콘. 뒤에서 실행할 때만 띄운다.

  /** PC 화면을 '쏙' 전용 창으로 연다. 이미 열려 있으면 앞으로 가져온다. */
  function showWindow() {
    if (tray && app.hasHostPage()) tray.activate(HOST_TITLE);
    else openAppWindow(`http://localhost:${port}/`);
  }

  // 포트 고르기. 휴대폰 홈 화면 바로가기가 계속 동작하도록 한 번 쓴 포트를 기억해 둔다.
  const explicitPort = args.port !== undefined;
  const preferred = explicitPort ? Number(args.port) : (config.port ?? DEFAULT_PORT);
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    console.error(`올바르지 않은 포트 번호예요: ${args.port}`);
    process.exit(2);
  }
  let port;
  for (let candidate = preferred; candidate < Math.min(preferred + 20, 65536); candidate++) {
    try {
      await listen(app.server, candidate, host);
      port = candidate;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      if (await pingApp({ address: '127.0.0.1', port: candidate })) {
        const pcUrl = `http://localhost:${candidate}/`;
        if (args['no-open']) {
          console.log(`\n  ${APP_NAME} 프로그램이 이미 실행 중이에요. PC 화면: ${pcUrl}\n`);
        } else {
          console.log(`\n  ${APP_NAME} 프로그램이 이미 실행 중이에요. 브라우저에서 화면을 열게요.\n`);
          openAppWindow(pcUrl);
        }
        return;
      }
      if (explicitPort) {
        console.error(`포트 ${candidate}을(를) 다른 프로그램이 쓰고 있어요. --port로 다른 번호를 지정해 주세요.`);
        process.exit(1);
      }
    }
  }
  if (!port) {
    console.error('쓸 수 있는 포트를 찾지 못했어요. --port로 직접 지정해 주세요.');
    process.exit(1);
  }
  config.port = port;
  saveConfig(configPath, config);

  const addresses = localOnly ? [{ address: '127.0.0.1' }] : lanAddresses();
  const pcUrl = `http://localhost:${port}/`;
  console.log(`\n  ${APP_NAME} ${VERSION} 실행 중\n`);
  if (addresses.length) {
    const phoneUrl = `http://${addresses[0].address}:${port}/?k=${config.token}`;
    if (process.stdout.isTTY) {
      console.log(toTerminal(encodeQR(phoneUrl)).replace(/^/gm, '  '));
      console.log(`\n  휴대폰 카메라로 위 QR 코드를 스캔하세요 (PC 화면에도 같은 QR이 있어요)`);
    }
    console.log(`  휴대폰 주소   ${phoneUrl}`);
    for (const extra of addresses.slice(1)) console.log(`  다른 네트워크 http://${extra.address}:${port}/?k=${config.token}  (${extra.iface})`);
  } else {
    console.log('  ⚠ Wi-Fi나 유선 네트워크 연결을 찾지 못했어요. 네트워크에 연결한 뒤 다시 실행하세요.');
  }
  console.log(`  PC 화면       ${pcUrl}`);
  console.log(`  PC 이름       ${pcName}  (다른 PC에 이 이름으로 보여요)`);
  console.log(`  받은 파일     ${receivedDir}`);
  await publicCheck;
  for (const warning of networkWarnings) console.log(`\n  ⚠ ${warning}`);
  if (!args.background) console.log(`\n  이 창을 닫으면 공유가 멈춰요. 끝내려면 Ctrl+C\n`);

  // 같은 네트워크에서 이 프로그램을 켠 다른 PC 찾기
  if (!localOnly) {
    try {
      discovery = await startDiscovery({
        self: () => ({ id: config.id, name: pcName, port }),
        targets: () => broadcastAddresses(),
        onPeer: (info) => app.peers.discovered(info),
        log: logEvent,
      });
    } catch (err) {
      console.log(`  ⚠ 다른 PC 자동 찾기를 시작하지 못했어요 (${err.code || err.message}). 주소로 직접 연결은 할 수 있어요.`);
    }
  }
  // 새 버전은 켜고 잠시 뒤, 그리고 하루에 한 번 확인한다 (설정에서 끌 수 있다)
  if (updater) {
    const checkUpdate = () => config.autoUpdate !== false && updater.check();
    setTimeout(checkUpdate, 20_000).unref();
    setInterval(checkUpdate, 24 * 60 * 60 * 1000).unref();
  }

  app.peers.refresh();
  setInterval(() => app.peers.refresh(), 30_000).unref();

  // 카카오톡처럼: 창을 닫아도 알림 영역 아이콘으로 남아 계속 받는다. 아이콘을 누르면 창이 열리고, 오른쪽 클릭 → 끄기.
  if (args.background) {
    tray = startTray({
      iconPath: EXE ? process.execPath : path.join(ROOT, 'public', 'icon.ico'),
      tooltip: `${APP_NAME} — 휴대폰·PC 파일 주고받기`,
      onOpen: () => showWindow(),
      onQuit: () => shutdown(),
      log: logEvent,
    });
  }

  if (!args['no-open']) showWindow();

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    try {
      store.saveNow();
    } catch (err) {
      console.error(`목록을 저장하지 못했어요: ${err.message}`);
    }
    discovery?.close();
    tray?.close();
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 1000))]);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown); // Windows에서 창을 닫을 때
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
