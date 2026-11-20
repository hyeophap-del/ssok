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
import { APP_NAME, APP_ID, APP_DIR, RECEIVED_DIR_NAME } from './src/brand.js';
import { startDiscovery } from './src/discovery.js';
import { encodeQR, toTerminal } from './src/qr.js';
import { openUrl, openPath, revealPath } from './src/open.js';
import { publicNetworkAdapters } from './src/windows.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8765;

const HELP = `
${APP_NAME} ${VERSION} — PC·휴대폰 사이 무선 파일 공유

사용법: node server.js [옵션]

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
  const configPath = path.join(home, 'config.json');
  const config = readJson(configPath);
  const oldReceived = path.join(os.homedir(), 'Downloads', 'Galaxy File');
  if (config && !config.dir && fs.existsSync(oldReceived)) {
    config.dir = oldReceived;
    writeJson(configPath, config);
  }
  // 목록에 적힌 '휴대폰으로 보낼 파일' 경로도 새 폴더로 고친다
  const itemsPath = path.join(home, 'items.json');
  const items = readJson(itemsPath);
  if (Array.isArray(items?.items)) {
    for (const item of items.items) {
      if (typeof item.path === 'string' && item.path.startsWith(legacy + path.sep)) item.path = home + item.path.slice(legacy.length);
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
    console.log(`  [${time}] ${payload.name}(${payload.address})에서 연결을 요청했어요. 확인 숫자 ${payload.code} — ${APP_NAME} 화면에서 허용해 주세요.`);
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

  const home = appHome();
  migrateLegacyHome(home);
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(home, 'config.json');
  const config = readJson(configPath) ?? {};
  if (!config.token || args['reset-token']) config.token = newToken();
  if (args.dir) config.dir = path.resolve(args.dir);
  if (!config.id) config.id = newPeerId();
  if (args.name !== undefined) config.name = cleanName(args.name) || undefined;
  const pcName = config.name || cleanName(os.hostname()) || '내 PC';

  const receivedDir = config.dir ?? path.join(os.homedir(), 'Downloads', RECEIVED_DIR_NAME);
  const outboxDir = path.join(home, 'outbox');
  fs.mkdirSync(receivedDir, { recursive: true });
  fs.mkdirSync(outboxDir, { recursive: true });

  const store = new Store(path.join(home, 'items.json')).load();
  const peerBook = new PeerBook(path.join(home, 'peers.json')).load();
  await cleanup(outboxDir, receivedDir, store);

  const host = args.host ?? '0.0.0.0';
  const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);

  // 휴대폰이 접속할 네트워크가 '공용 네트워크'면 방화벽에 막히기 쉬워서 미리 알려 준다.
  let networkWarnings = [];
  const checkNetworks = () =>
    publicNetworkAdapters().then((adapters) => {
      networkWarnings = lanAddresses()
        .filter((a) => adapters.includes(a.iface))
        .map(
          ({ iface }) =>
            `‘${iface}’ 네트워크가 공용 네트워크로 설정되어 있어요. 휴대폰이 접속하지 못하면 ` +
            `설정 → 네트워크 및 인터넷 → ${iface} → 연결된 네트워크 속성에서 ‘개인 네트워크’로 바꿔 주세요.`,
        );
    });
  const publicCheck = localOnly ? Promise.resolve() : checkNetworks();
  if (!localOnly) setInterval(checkNetworks, 60_000).unref(); // 설정을 바꾸면 1분 안에 경고가 사라진다

  const app = createApp({
    token: config.token,
    receivedDir,
    outboxDir,
    store,
    publicDir: path.join(ROOT, 'public'),
    lanAddresses: () => (localOnly ? [{ address: '127.0.0.1', iface: '이 PC에서만 (--host 127.0.0.1)' }] : lanAddresses()),
    opener: { open: openPath, reveal: revealPath },
    warnings: () => networkWarnings,
    self: { id: config.id, name: pcName },
    peerBook,
    announce: () => discovery?.announce(),
    showHostPage: () => {
      // 다른 PC가 연결을 요청했는데 이 PC 화면이 닫혀 있으면 열어 준다 (너무 자주 열지는 않는다)
      if (args['no-open'] || Date.now() - lastShown < 5 * 60_000) return;
      lastShown = Date.now();
      openUrl(`http://localhost:${port}/`);
    },
    log: logEvent,
  });
  let discovery = null;
  let lastShown = 0;

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
          openUrl(pcUrl);
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
  writeJson(configPath, config);

  const addresses = localOnly ? [{ address: '127.0.0.1' }] : lanAddresses();
  const pcUrl = `http://localhost:${port}/`;
  console.log(`\n  ${APP_NAME} ${VERSION} 실행 중\n`);
  if (addresses.length) {
    const phoneUrl = `http://${addresses[0].address}:${port}/?k=${config.token}`;
    console.log(toTerminal(encodeQR(phoneUrl)).replace(/^/gm, '  '));
    console.log(`\n  휴대폰 카메라로 위 QR 코드를 스캔하세요 (PC 화면에도 같은 QR이 있어요)`);
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
  console.log(`\n  이 창을 닫으면 공유가 멈춰요. 끝내려면 Ctrl+C\n`);

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
  app.peers.refresh();
  setInterval(() => app.peers.refresh(), 30_000).unref();

  if (!args['no-open']) openUrl(pcUrl);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      store.saveNow();
    } catch (err) {
      console.error(`목록을 저장하지 못했어요: ${err.message}`);
    }
    discovery?.close();
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 1000))]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown); // Windows에서 창을 닫을 때
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
