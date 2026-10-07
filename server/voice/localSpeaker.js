// Speaks text on the laptop's speakers with the built-in Windows voice (free, offline).
// Used when no Novi page is open. One PowerShell voice process stays running (starting one
// takes ~2.5 s); each line goes to it on stdin as data, never as code. One line at a time.
import { spawn } from 'node:child_process';

const SCRIPT = [
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'while ($null -ne ($line = [Console]::In.ReadLine())) { if ($line) { $s.Speak($line) }; [Console]::Out.WriteLine("done") }',
].join('; ');

export function createLocalSpeaker({ platform = process.platform, run = spawn } = {}) {
  if (platform !== 'win32') return null;
  let voice = null; // { child, waiting: [resolve...] }
  let queue = Promise.resolve();

  function start() {
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const v = { child, waiting: [] };
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim() === 'done') v.waiting.shift()?.();
    });
    const died = () => {
      if (voice === v) voice = null;
      for (const resolve of v.waiting.splice(0)) resolve();
    };
    child.on('exit', died);
    child.on('error', died);
    return v;
  }

  return (text) => {
    const line = String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 1000);
    queue = queue.then(() => new Promise((resolve) => {
      if (!voice) voice = start();
      voice.waiting.push(resolve);
      voice.child.stdin.write(`${line}\n`);
    }));
    return queue;
  };
}
