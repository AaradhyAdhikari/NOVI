import { execFile } from 'node:child_process';

// The title of the window in front on the laptop (e.g. "app.js - NOVI - Visual Studio Code").
// A short hidden PowerShell call, no screenshot. '' when it can't tell.
const SCRIPT = [
  "Add-Type -Name W -Namespace F -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);';",
  '$b = New-Object System.Text.StringBuilder 512;',
  '[void][F.W]::GetWindowText([F.W]::GetForegroundWindow(), $b, 512);',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  '$b.ToString()',
].join(' ');

export function activeWindowTitle({ run = execFile } = {}) {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}
