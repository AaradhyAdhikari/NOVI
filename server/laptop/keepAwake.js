import { spawn as nodeSpawn } from 'node:child_process';

// Keep the laptop from idle-sleeping for as long as Novi runs (the user wants it always reachable).
// Uses Windows' "don't sleep" request (SetThreadExecutionState) — no power settings are changed,
// the screen may still turn off, and closing the lid can still sleep the laptop.
// Its own hidden PowerShell (not the speaker's), so a speaker restart can't drop the request.
const SCRIPT = [
  "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';",
  '[void][W.P]::SetThreadExecutionState([uint32]2147483649);', // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED (PS 5.1 reads the hex as negative)
  '[void][Console]::In.ReadLine()', // hold until Novi closes stdin or exits
].join(' ');

export function startKeepAwake({ spawn = nodeSpawn } = {}) {
  let stopped = false;
  let restarts = 0;
  let proc = null;
  const launch = () => {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    proc.on('error', () => {});
    proc.on('exit', () => {
      if (stopped || restarts >= 1) return;
      restarts += 1;
      launch();
    });
  };
  launch();
  return {
    stop() {
      stopped = true;
      proc?.stdin?.end();
      proc?.kill();
    },
  };
}
