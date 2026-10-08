// Speaks on the laptop's speakers when no Novi page is open. Prefers the natural Edge voices
// (synth → MP3, played by the voice process); falls back to the built-in Windows voice (free, offline).
// One PowerShell voice process stays running (starting one takes ~2.5 s); each line goes to it on
// stdin as data, never as code: "PLAY:<path to our temp mp3>" or the text to say. One line at a time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const SCRIPT = [
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech, PresentationCore',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  'function Play($f) { $p.Open([Uri]$f); $p.Play(); $t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 50) { Start-Sleep -Milliseconds 100; $t++ }; if ($p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 150) }; $p.Close() }',
  'while ($null -ne ($line = [Console]::In.ReadLine())) { if ($line.StartsWith("PLAY:")) { Play $line.Substring(5) } elseif ($line) { $s.Speak($line) }; [Console]::Out.WriteLine("done") }',
].join('; ');

export function createLocalSpeaker({ platform = process.platform, run = spawn, synth = null, tmpDir = os.tmpdir() } = {}) {
  if (platform !== 'win32') return null;
  let voice = null; // { child, waiting: [resolve...] }
  let queue = Promise.resolve();
  let generation = 0; // bumped by stop(): lines queued before it are dropped

  function start() {
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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

  const send = (line) => new Promise((resolve) => {
    if (!voice) voice = start();
    voice.waiting.push(resolve);
    voice.child.stdin.write(`${line}\n`);
  });

  const say = (text) => {
    const line = String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 1000);
    const mine = generation;
    queue = queue.then(async () => {
      if (mine !== generation) return;
      if (synth && line) {
        let file = null;
        try {
          file = path.join(tmpDir, `novi-say-${crypto.randomUUID()}.mp3`);
          fs.writeFileSync(file, await synth(line));
          if (mine !== generation) return;
          await send(`PLAY:${file}`);
          return;
        } catch {
          // Edge voices unavailable: use the Windows voice below.
        } finally {
          if (file) fs.rmSync(file, { force: true });
        }
      }
      await send(line);
    });
    return queue;
  };

  // "Hey Novi" while Novi talks: silence it now. Killing the voice process is the only way to cut
  // a line short; a fresh one starts straight away so the next reply isn't 2.5 s late.
  say.stop = () => {
    generation += 1;
    if (!voice?.waiting.length) return;
    const old = voice;
    voice = start();
    try { old.child.kill(); } catch { /* already gone */ }
  };
  return say;
}
