// The stream's Edge (stream.js) must never pile up or show (live 2026-11-11: dozens were left running, from
// test runs and Novi restarts, since Windows keeps a program's children alive, and they showed on the taskbar
// with Edge's warning bar). The Edge Novi starts hands off to another process and exits, so its process id is
// no good: each stream is found by its own profile folder name ("novi-remote-XXXXXX"), which also means the
// user's own Edge is never touched.
import { execFile } from 'node:child_process';

const MARK = 'novi-remote-';
const ONE = /^novi-remote-[A-Za-z0-9]+$/;

const run = (script) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (err, out) => resolve(err ? '' : String(out || '').trim()));
});

const checked = (mark) => {
  if (!ONE.test(String(mark))) throw new Error('not a stream profile name');
  return mark;
};
const streamEdges = (filter) => `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { ${filter} }`;

// Every stream Edge except the profiles in `keep` (the stream running now).
export function leftoverScript(keep = []) {
  const spare = keep.map(checked).map((k) => ` -and $_.CommandLine -notmatch '${k}'`).join('');
  return `$p = ${streamEdges(`$_.CommandLine -match '${MARK}'${spare}`)}; foreach ($x in $p) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null }; @($p).Count`;
}

export function closeScript(mark) {
  return `${streamEdges(`$_.CommandLine -match '${checked(mark)}'`)} | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`;
}

export function hideScript(mark) {
  return 'Add-Type -Namespace NoviHide -Name W -MemberDefinition \'[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);\'; $n = 0; '
    + `${streamEdges(`$_.CommandLine -match '${checked(mark)}'`)} | ForEach-Object { $h = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle; if ($h -and $h -ne 0) { [NoviHide.W]::ShowWindow($h, 0) | Out-Null; $n++ } }; $n`;
}

const windows = process.platform === 'win32';

// Never throws. Windows only.
export async function closeLeftovers({ keep = [] } = {}) {
  return windows ? Number(await run(leftoverScript(keep))) || 0 : 0;
}
export async function closeStream(mark) {
  if (windows) await run(closeScript(mark));
}
export async function hideStream(mark) {
  return windows ? Number(await run(hideScript(mark))) || 0 : 0;
}
