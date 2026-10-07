// Speaks text on the laptop's speakers with the built-in Windows voice (free, offline).
// Used when no Novi page is open to speak replies. One line at a time.
import { spawn } from 'node:child_process';

const SCRIPT = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:NOVI_SAY_TEXT)';

export function createLocalSpeaker({ platform = process.platform, run = spawn } = {}) {
  if (platform !== 'win32') return null;
  let queue = Promise.resolve();
  return (text) => {
    // The text goes in an environment variable, never into the command line.
    queue = queue.then(() => new Promise((resolve) => {
      const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
        env: { ...process.env, NOVI_SAY_TEXT: String(text).slice(0, 1000) },
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('exit', resolve);
      child.on('error', resolve);
    }));
    return queue;
  };
}
