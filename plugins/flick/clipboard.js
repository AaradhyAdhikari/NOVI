// Novi Flick v2: copy a flicked thing to the laptop's clipboard, and show it in its folder.
// A picture goes on the clipboard as a picture (paste it straight into ChatGPT, WhatsApp, Word…), a link as text,
// any other file as a file (paste it in a folder or a chat). The path or text reaches PowerShell only through an
// environment variable, never inside the script, so no name can turn into a command.
import { execFile, spawn } from 'node:child_process';

const SCRIPTS = {
  image: 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i = [System.Drawing.Image]::FromFile($env:NOVI_FLICK_VALUE); try { [System.Windows.Forms.Clipboard]::SetImage($i) } finally { $i.Dispose() }',
  file: 'Add-Type -AssemblyName System.Windows.Forms; $c = New-Object System.Collections.Specialized.StringCollection; [void]$c.Add($env:NOVI_FLICK_VALUE); [System.Windows.Forms.Clipboard]::SetFileDropList($c)',
  text: 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText($env:NOVI_FLICK_VALUE)',
};

// what = { image: path } | { file: path } | { text }. Resolves true when it worked.
export function copyScript(what) {
  const kind = ['image', 'file', 'text'].find((k) => what?.[k]);
  return kind ? { script: SCRIPTS[kind], value: String(what[kind]) } : null;
}

const run = (script, value) => new Promise((resolve) => {
  // The clipboard needs a single-threaded PowerShell (-STA).
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true, timeout: 15_000, env: { ...process.env, NOVI_FLICK_VALUE: value } }, (err) => resolve(!err));
});

export async function defaultCopy(what) {
  const s = copyScript(what);
  if (!s) return false;
  if (await run(s.script, s.value)) return true;
  // A picture Windows can't read (HEIC…) still goes on the clipboard as a file.
  return what.image ? run(SCRIPTS.file, what.image) : false;
}

export async function defaultShowInFolder(file) {
  const c = spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' });
  c.on('error', () => {});
  c.unref();
}
