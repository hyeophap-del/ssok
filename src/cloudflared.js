// Cloudflare 터널 (cloudflared) 다루기: 중계 서버를 공유기 설정 없이 https://<내 도메인> 으로 내보낸다.
//
// 처음 한 번 (중계 서버 관리 화면의 [연결하기]):
//   1. cloudflared.exe를 GitHub(Cloudflare 공식 릴리스)에서 내려받는다
//   2. cloudflared tunnel login       → 브라우저에서 Cloudflare 로그인, 도메인 선택 → cert.pem
//   3. cloudflared tunnel create       → 터널과 그 열쇠 파일(tunnel.json)
//   4. cloudflared tunnel route dns    → ssok.내도메인 → 터널 (DNS CNAME)
// 그 뒤로는 켤 때마다 cloudflared tunnel run 을 띄워 두고, 꺼지면 다시 띄운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';

export const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
export const TUNNEL_NAME = 'ssok-relay';
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 'https://Ssok.Example.com/' → 'ssok.example.com'. 이상하면 null. */
export function cleanHostname(input) {
  const text = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return HOSTNAME.test(text) ? text : null;
}

/** 로그인하면 cloudflared가 cert.pem을 두는 곳들 (버전에 따라 다르다) */
function defaultCertPaths() {
  const home = os.homedir();
  return [path.join(home, '.cloudflared', 'cert.pem'), path.join(home, '.cloudflare-warp', 'cert.pem'), path.join(home, 'cloudflare-warp', 'cert.pem')];
}

/** cloudflared 출력에서 브라우저로 열 로그인 주소를 찾는다 */
export function findLoginUrl(text) {
  return /https:\/\/dash\.cloudflare\.com\/argotunnel\S*/.exec(text)?.[0] ?? null;
}

/** 'cloudflared tunnel create' 출력에서 터널 번호를 찾는다 */
export function findTunnelId(text) {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(text)?.[1] ?? null;
}

/** 터널 열쇠 파일에서 터널 번호를 읽는다. 없거나 이상하면 null. */
export function readTunnelId(credFile) {
  try {
    const data = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    return /^[0-9a-f-]{36}$/.test(data.TunnelID || '') && data.TunnelSecret ? data.TunnelID : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.dir        cloudflared.exe와 열쇠 파일을 둘 폴더
 * @param {number} options.localPort  터널이 넘겨줄 이 PC의 중계 서버 포트
 * @param {(line: string) => void} [options.onLog]
 * @param {(state: object) => void} [options.onChange]
 */
export function createTunnelManager({ dir, localPort, onLog = () => {}, onChange = () => {}, fetch: fetchImpl = fetch }) {
  const bin = path.join(dir, 'cloudflared.exe');
  const certFile = path.join(dir, 'cert.pem');
  const credFile = path.join(dir, 'tunnel.json');
  const pidFile = path.join(dir, 'cloudflared.pid');
  fs.mkdirSync(dir, { recursive: true });

  const state = { running: false, ready: false, connections: 0, error: null, lastLines: [] };
  let child = null;
  let stopped = true;
  let restartTimer = null;
  let readyTimer = null;
  let metrics = null; // cloudflared가 연 상태 확인 주소 (127.0.0.1:포트)
  let backoff = 2000;
  const changed = () => onChange({ ...state, lastLines: [...state.lastLines] });

  function remember(line) {
    state.lastLines.push(line);
    if (state.lastLines.length > 30) state.lastLines.shift();
    onLog(line);
  }

  /** cloudflared를 한 번 실행하고 끝날 때까지 출력을 모은다 */
  function run(args, { timeout = 120_000, onLine = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const take = (chunk) => {
        const text = chunk.toString('utf8');
        output += text;
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
      };
      proc.stdout.on('data', take);
      proc.stderr.on('data', take);
      const timer = setTimeout(() => proc.kill(), timeout);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  const installed = () => {
    try {
      return fs.statSync(bin).size > 1_000_000;
    } catch {
      return false;
    }
  };

  /** cloudflared.exe를 내려받는다 (이미 있으면 그대로) */
  async function install({ onProgress = () => {} } = {}) {
    if (installed()) return;
    const partial = `${bin}.part`;
    const res = await fetchImpl(DOWNLOAD_URL, { redirect: 'follow', headers: { 'User-Agent': 'ssok-relay' } });
    if (!res.ok || !res.body) throw new Error(`cloudflared를 내려받지 못했어요 (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(partial);
    let received = 0;
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress(received, total);
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      const head = Buffer.alloc(2);
      const fd = fs.openSync(partial, 'r');
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') !== 'MZ' || received < 1_000_000) throw new Error('받은 cloudflared 파일이 올바르지 않아요.');
      fs.renameSync(partial, bin);
    } catch (err) {
      out.destroy();
      fs.rmSync(partial, { force: true });
      throw err;
    }
  }

  /** 로그인 인증서가 있는지. 있으면 우리 폴더로 가져온다. */
  function findCert() {
    if (fs.existsSync(certFile)) return certFile;
    const found = defaultCertPaths().find((file) => fs.existsSync(file));
    if (!found) return null;
    fs.copyFileSync(found, certFile);
    return certFile;
  }

  /**
   * Cloudflare 로그인. 브라우저가 열리고, 사용자가 도메인을 고르면 끝난다.
   * fresh면 예전 인증서를 치워 두고 새로 로그인한다 (다른 도메인으로 로그인되어 있을 때).
   */
  async function login({ fresh = false, onUrl = () => {} } = {}) {
    if (!fresh && findCert()) return certFile;
    if (fresh) {
      fs.rmSync(certFile, { force: true });
      for (const file of defaultCertPaths()) if (fs.existsSync(file)) fs.renameSync(file, `${file}.old-${Date.now()}`);
    }
    let shown = false;
    const { code, output } = await run(['tunnel', 'login'], {
      timeout: 10 * 60_000, // 브라우저에서 로그인할 시간
      onLine: (line) => {
        const url = findLoginUrl(line);
        if (url && !shown) {
          shown = true;
          onUrl(url);
        }
      },
    });
    if (code !== 0 || !findCert()) throw new Error(`Cloudflare 로그인을 마치지 못했어요. ${lastMeaningful(output)}`);
    return certFile;
  }

  /** 터널을 만든다 (이미 같은 이름이 있으면 그 터널의 열쇠를 다시 받는다). 터널 번호를 돌려준다. */
  async function ensureTunnel() {
    const known = readTunnelId(credFile);
    if (known) return known;
    const common = ['tunnel', '--origincert', certFile];
    let { code, output } = await run([...common, 'create', '--cred-file', credFile, TUNNEL_NAME]);
    if (code !== 0 && /already exists/i.test(output)) {
      ({ code, output } = await run([...common, 'token', '--cred-file', credFile, TUNNEL_NAME]));
    }
    const id = readTunnelId(credFile);
    if (code !== 0 || !id) throw new Error(`터널을 만들지 못했어요. ${lastMeaningful(output)}`);
    return id;
  }

  /**
   * 주소(ssok.example.com)가 이 터널을 가리키게 DNS를 설정한다.
   * 이미 다른 기록이 있는 주소는 덮어쓰지 않는다 (www 같은 다른 웹사이트를 잘못 넣어 사이트가 멈추지 않게).
   * overwrite: 이 중계 서버가 전에 쓰던 그 주소일 때만 (터널을 다시 만든 경우)
   */
  async function routeDns(tunnelId, hostname, { overwrite = false } = {}) {
    const { code, output } = await run(['tunnel', '--origincert', certFile, 'route', 'dns', ...(overwrite ? ['--overwrite-dns'] : []), tunnelId, hostname]);
    if (code !== 0 && !overwrite && /already exists/i.test(output)) {
      throw new Error(
        `${hostname}에는 Cloudflare에 이미 다른 기록이 있어요. 지금 쓰는 웹사이트일 수 있어 덮어쓰지 않았어요. 다른 이름(예: ssok2.${hostname.split('.').slice(1).join('.')})을 쓰거나, 정말 안 쓰는 기록이면 Cloudflare 화면에서 지운 뒤 다시 해 주세요.`,
      );
    }
    const routed = routedHostname(output);
    // 로그인할 때 고른 도메인과 다른 주소를 넣으면 cloudflared가 'ssok.a.com.b.com'처럼 그 도메인 뒤에 붙여 버린다
    if (code === 0 && routed && routed !== hostname) {
      throw Object.assign(
        new Error(`Cloudflare에 로그인할 때 다른 도메인(${routed.slice(hostname.length + 1) || routed})을 골랐어요. [다시 로그인]을 누르고 ${hostname.split('.').slice(-2).join('.')}을(를) 골라 주세요.`),
        { zone: true },
      );
    }
    if (code !== 0) {
      const zone = /zone|not.*(found|exist)|authoriz|permission/i.test(output);
      throw Object.assign(
        new Error(
          zone
            ? `${hostname}의 DNS를 바꾸지 못했어요. Cloudflare에 로그인할 때 이 도메인을 골랐는지 확인하고 [다시 로그인]을 눌러 주세요. (${lastMeaningful(output)})`
            : `DNS를 설정하지 못했어요. ${lastMeaningful(output)}`,
        ),
        { zone },
      );
    }
  }

  // ---- 터널 켜 두기 ----

  /** 지난번에 비정상으로 끝나 남은 cloudflared가 있으면 끈다 */
  async function killLeftover() {
    let pid;
    try {
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
    } catch {
      return;
    }
    fs.rmSync(pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32') return;
    const image = await new Promise((resolve) =>
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => resolve(err ? '' : String(out))),
    );
    if (/^"cloudflared\.exe"/i.test(image.trim())) {
      try {
        process.kill(pid);
      } catch {
        // 이미 끝남
      }
    }
  }

  function start() {
    stopped = false;
    clearTimeout(restartTimer);
    const tunnelId = readTunnelId(credFile);
    if (!installed() || !tunnelId) {
      state.running = false;
      state.ready = false;
      changed();
      return false;
    }
    if (child) return true;
    metrics = null;
    // http2(TCP): QUIC(UDP)보다 느린 망·공용 Wi-Fi에서 훨씬 안정적이고 빨랐다 (올리기 0.17 → 3.5MB/s)
    const args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', 'run', '--cred-file', credFile, '--url', `http://127.0.0.1:${localPort}`, tunnelId];
    child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(pidFile, String(child.pid ?? ''));
    state.running = true;
    state.ready = false;
    state.error = null;
    changed();
    const take = (chunk) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        remember(line);
        const m = /metrics server on (127\.0\.0\.1:\d+)/i.exec(line);
        if (m) metrics = m[1];
        if (/Registered tunnel connection/i.test(line)) {
          backoff = 2000;
          checkReady();
        }
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const proc = child;
    proc.on('error', (err) => {
      state.error = err.message;
      changed();
    });
    proc.on('close', (code) => {
      if (child !== proc) return;
      child = null;
      fs.rmSync(pidFile, { force: true });
      state.running = false;
      state.ready = false;
      state.connections = 0;
      if (!stopped) {
        state.error = `cloudflared가 멈췄어요 (코드 ${code}). 잠시 뒤 다시 켜요.`;
        restartTimer = setTimeout(start, backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
      changed();
    });
    clearInterval(readyTimer);
    readyTimer = setInterval(checkReady, 15_000);
    readyTimer.unref?.();
    return true;
  }

  /** cloudflared의 /ready로 Cloudflare와 이어진 연결 수를 확인한다 */
  function checkReady() {
    if (!metrics || !child) return;
    const [host, port] = metrics.split(':');
    const req = http.get({ host, port: Number(port), path: '/ready', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let connections = 0;
        try {
          connections = JSON.parse(body).readyConnections ?? 0;
        } catch {
          connections = 0;
        }
        const ready = res.statusCode === 200 && connections > 0;
        if (ready !== state.ready || connections !== state.connections) {
          state.ready = ready;
          state.connections = connections;
          if (ready) state.error = null;
          changed();
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
  }

  function stop() {
    stopped = true;
    clearTimeout(restartTimer);
    clearInterval(readyTimer);
    const proc = child;
    child = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // 이미 끝남
      }
    }
    fs.rmSync(pidFile, { force: true });
    state.running = false;
    state.ready = false;
    state.connections = 0;
    changed();
  }

  return {
    paths: { bin, certFile, credFile },
    installed,
    install,
    login,
    hasCert: () => Boolean(findCert()),
    ensureTunnel,
    routeDns,
    killLeftover,
    start,
    stop,
    restart() {
      stop();
      return start();
    },
    state: () => ({ ...state, lastLines: [...state.lastLines] }),
    configured: () => installed() && Boolean(readTunnelId(credFile)),
  };
}

/** 'route dns' 출력에서 실제로 연결된 주소를 찾는다 ('Added CNAME x which will route…', 'x is already configured…') */
export function routedHostname(output) {
  const text = String(output || '');
  const m = /Added CNAME (\S+?)\.? which/i.exec(text) || /(\S+?)\.? is already configured to route/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** cloudflared 출력의 마지막 의미 있는 줄 (화면에 보여 줄 오류 설명) */
export function lastMeaningful(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /\bERR\b|error|failed|fail/i.test(l));
  return (err || lines.at(-1) || '').replace(/^\S+Z\s+(ERR|INF|WRN)\s+/, '').slice(0, 300);
}
