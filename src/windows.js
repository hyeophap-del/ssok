// Windows 전용 기능: 공용 네트워크 감지, 시작 메뉴·자동 실행 바로가기
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function powershell(script, timeout = 15_000) {
  // 한글 경로가 깨지지 않도록 스크립트를 UTF-16LE로 인코딩해서 넘긴다
  const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)),
    );
  });
}

/** PowerShell 작은따옴표 문자열 */
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * Windows에서 '공용 네트워크'로 설정된 네트워크 어댑터 이름 목록.
 * 공용 네트워크에서는 방화벽이 휴대폰의 접속을 막는 경우가 많아서 미리 알려 주려고 쓴다.
 * Windows가 아니거나 확인에 실패하면 빈 목록을 돌려준다.
 */
export async function publicNetworkAdapters() {
  if (process.platform !== 'win32') return [];
  try {
    const out = await powershell("Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | ForEach-Object { $_.InterfaceAlias }", 10_000);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function programsDir() {
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null;
}

/** 시작 메뉴 바로가기 경로 */
export function startMenuShortcut(name) {
  const dir = programsDir();
  return dir && path.join(dir, `${name}.lnk`);
}

/** 로그인할 때 자동으로 실행되는 바로가기 경로 */
export function startupShortcut(name) {
  const dir = programsDir();
  return dir && path.join(dir, 'Startup', `${name}.lnk`);
}

export const shortcutsSupported = () => process.platform === 'win32' && Boolean(programsDir());

/**
 * 바로가기(.lnk)를 만든다. minimized면 잠깐 뜨는 실행 창이 작업 표시줄에 최소화된 채로 지나간다.
 */
export async function createShortcut({ file, target, args = '', workingDir, icon, description = '', minimized = true }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(file)})`,
    `$s.TargetPath = ${quote(target)}`,
    `$s.Arguments = ${quote(args)}`,
    `$s.WorkingDirectory = ${quote(workingDir ?? path.dirname(target))}`,
    icon ? `$s.IconLocation = ${quote(`${icon},0`)}` : '',
    `$s.Description = ${quote(description)}`,
    `$s.WindowStyle = ${minimized ? 7 : 1}`,
    '$s.Save()',
  ]
    .filter(Boolean)
    .join('; ');
  await powershell(script);
}

export function removeShortcut(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 이미 없음
  }
}
