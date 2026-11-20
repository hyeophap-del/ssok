import { execFile } from 'node:child_process';

/**
 * Windows에서 '공용 네트워크'로 설정된 네트워크 어댑터 이름 목록.
 * 공용 네트워크에서는 방화벽이 휴대폰의 접속을 막는 경우가 많아서 미리 알려 주려고 쓴다.
 * Windows가 아니거나 확인에 실패하면 빈 목록을 돌려준다.
 */
export function publicNetworkAdapters() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script =
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    "Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | ForEach-Object { $_.InterfaceAlias }";
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      },
    );
  });
}
