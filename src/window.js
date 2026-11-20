// PC 화면을 '쏙' 전용 창으로 열기, 작업 표시줄 알림 영역(트레이) 아이콘 (Windows)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { openUrl } from './open.js';

/** 주소창·탭 없는 앱 창을 열 수 있는 브라우저 (Chrome → Edge 순서). 없으면 null. */
export function findAppBrowser(env = process.env) {
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

/** PC 화면을 전용 창으로 연다. 그런 브라우저가 없으면 기본 브라우저 탭으로 연다. */
export function openAppWindow(url) {
  const browser = process.platform === 'win32' ? findAppBrowser() : null;
  if (!browser) return openUrl(url);
  spawn(browser, [`--app=${url}`, '--window-size=1200,860'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// 알림 영역 아이콘은 PowerShell(WinForms)로 띄운다. Node에는 이 기능이 없고, Windows에는 PowerShell이 늘 있다.
// 쏙 → 아이콘: 표준 입력으로 'balloon\t제목\t내용', 'activate\t창 제목', 'exit'
// 아이콘 → 쏙: 표준 출력으로 'ready', 'open', 'quit'
const TRAY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$parentId = __PARENT__
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon(__ICON__)
$tray.Text = __TIP__
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add(__OPEN__)
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add('-')
$quitItem = $menu.Items.Add(__QUIT__)
$tray.ContextMenuStrip = $menu
function Send($message) { [Console]::Out.WriteLine($message); [Console]::Out.Flush() }
$openItem.add_Click({ Send 'open' })
$quitItem.add_Click({ Send 'quit' })
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send 'open' } })
$tray.Visible = $true
# [Console]::In.ReadLineAsync()는 실제로는 한 줄이 올 때까지 멈춘다. 표준 입력 스트림을 직접 열어야 정말로 기다리지 않는다.
$script:reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$script:pending = $script:reader.ReadLineAsync()
$script:ticks = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.add_Tick({
  $script:ticks++
  if ($script:pending.IsCompleted) {
    $line = $script:pending.Result
    if ($line -eq $null) { [System.Windows.Forms.Application]::Exit(); return }
    $parts = $line.Split([char]9)
    if ($parts[0] -eq 'balloon') { $tray.ShowBalloonTip(6000, $parts[1], $parts[2], [System.Windows.Forms.ToolTipIcon]::Info) }
    elseif ($parts[0] -eq 'activate') { $null = (New-Object -ComObject WScript.Shell).AppActivate($parts[1]) }
    elseif ($parts[0] -eq 'exit') { [System.Windows.Forms.Application]::Exit(); return }
    $script:pending = $script:reader.ReadLineAsync()
  }
  # 쏙이 갑자기 끝나도 아이콘이 남지 않게 한다
  if ($script:ticks % 12 -eq 0 -and -not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { [System.Windows.Forms.Application]::Exit() }
})
$timer.Start()
Send 'ready'
[System.Windows.Forms.Application]::Run()
$tray.Visible = $false
$tray.Dispose()
`;

const psString = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * 알림 영역 아이콘을 띄운다 (Windows만). 클릭하면 onOpen, [끄기]를 누르면 onQuit.
 * @returns {{ balloon(title: string, text: string): void, activate(title: string): void, close(): void, ready: Promise<boolean> }}
 */
export function startTray({ iconPath, tooltip, openLabel = '열기', quitLabel = '끄기', onOpen, onQuit, log = () => {} }) {
  const dummy = { balloon() {}, activate() {}, close() {}, ready: Promise.resolve(false) };
  if (process.platform !== 'win32') return dummy;
  const script = TRAY_SCRIPT.replace('__PARENT__', String(process.pid))
    .replace('__ICON__', psString(iconPath))
    .replace('__TIP__', psString(tooltip.slice(0, 63))) // 알림 영역 말풍선은 63자까지
    .replace('__OPEN__', psString(openLabel))
    .replace('__QUIT__', psString(quitLabel));
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.on('error', (err) => log('error', err));
  child.stdin.on('error', () => {}); // 아이콘이 먼저 끝났으면 무시
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    if (!text.includes('CLIXML')) log('error', `알림 영역 아이콘: ${text.trim()}`); // PowerShell 진행 표시는 무시
  });

  let resolveReady;
  const ready = new Promise((resolve) => (resolveReady = resolve));
  child.on('exit', () => resolveReady(false));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = line.trim();
    if (message === 'ready') resolveReady(true);
    else if (message === 'open') onOpen?.();
    else if (message === 'quit') onQuit?.();
  });

  const send = (...parts) => {
    if (child.exitCode === null && child.stdin.writable) child.stdin.write(`${parts.map((p) => String(p).replace(/[\t\r\n]+/g, ' ')).join('\t')}\n`);
  };
  return {
    ready,
    balloon: (title, text) => send('balloon', title, text),
    activate: (title) => send('activate', title),
    close() {
      send('exit');
      setTimeout(() => child.kill(), 1500).unref();
    },
  };
}
