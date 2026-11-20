import { spawn } from 'node:child_process';
import path from 'node:path';

function run(command, args, options = {}) {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 열기 실패는 치명적이지 않다
  }
}

/** 기본 브라우저로 주소를 연다. */
export function openUrl(url) {
  if (process.platform === 'win32') run('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  else if (process.platform === 'darwin') run('open', [url]);
  else run('xdg-open', [url]);
}

/** 파일은 기본 앱으로, 폴더는 탐색기로 연다. */
export function openPath(target) {
  if (process.platform === 'win32') run('explorer.exe', [target]);
  else if (process.platform === 'darwin') run('open', [target]);
  else run('xdg-open', [target]);
}

/** 탐색기에서 파일이 선택된 상태로 폴더를 연다. */
export function revealPath(target) {
  if (process.platform === 'win32') {
    // explorer는 /select,"경로" 형태만 제대로 해석한다. Windows 파일 이름에는 "가 들어갈 수 없다.
    run('explorer.exe', [`/select,"${target}"`], { windowsVerbatimArguments: true });
  } else if (process.platform === 'darwin') {
    run('open', ['-R', target]);
  } else {
    run('xdg-open', [path.dirname(target)]);
  }
}
