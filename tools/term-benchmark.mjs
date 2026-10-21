// Are project names and tech words heard right? (user's ChatGPT plan, 2026-10-21: the IndicContextEval
// idea — score names separately from plain word errors.) Novi's own voice (Edge TTS, en-IN) says each
// line of tools/term-sentences.json; Whisper hears it with three hints:
//   basic  = Whisper's built-in hint only
//   before = + your words (Settings → Words) + project names (what Novi sent until 2026-10-21)
//   now    = + the projects' tech words (server/voice/techWords.js)
// A name counts when it is in the transcript after Novi's own word fixes (case/spaces/dots ignored).
// Usage: node --env-file-if-exists=.env tools/term-benchmark.mjs
// Clips are kept in data/term-benchmark/ (a rerun only re-asks Whisper); results go to
// data/term-benchmark-<date>.json (private: they hold your project names).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { transcribe, DEFAULT_PROMPT } from '../server/voice/stt.js';
import { createEdgeTts } from '../server/voice/edgeTts.js';
import { createVocabulary } from '../server/voice/vocabulary.js';
import { hintNames, projectTechWords, termHits, fixNames } from '../server/voice/techWords.js';

const keys = String(process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
if (!keys.length) { console.error('No Groq key in .env (GROQ_API_KEYS).'); process.exit(1); }

const sentences = JSON.parse(fs.readFileSync('tools/term-sentences.json', 'utf8'));
const vocabulary = createVocabulary({ file: path.resolve('data/vocabulary.json') });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const projects = Object.entries(readJson('data/memory.json').projects || {}).map(([name, p]) => ({ name, ...p }));
const claude = readJson('data/claude-link.json');
const claudeNames = (claude.webProjects || []).map((p) => p.name || p).filter((n) => typeof n === 'string');
const names = hintNames(projects, claudeNames).filter((n) => !projectTechWords(projects).includes(n));

const hints = {
  basic: DEFAULT_PROMPT,
  before: vocabulary.prompt(DEFAULT_PROMPT, names),
  now: vocabulary.prompt(DEFAULT_PROMPT, hintNames(projects, claudeNames)),
};

const dir = path.resolve('data/term-benchmark');
fs.mkdirSync(dir, { recursive: true });
const edge = createEdgeTts({ timeoutMs: 20_000 });
// Edge's voice first; Microsoft refused it on 2026-10-21 (403), so the built-in Windows voice is the
// fallback (a .wav, the words passed in an environment variable, never in the command).
const windowsVoice = (text, file) => {
  const ps = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:NOVI_OUT); $s.Speak($env:NOVI_SAY); $s.Dispose()";
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { env: { ...process.env, NOVI_SAY: text, NOVI_OUT: file }, windowsHide: true });
};
let voice = 'edge';
const clipFor = async (text) => {
  const mp3 = path.join(dir, `${slug(text)}.mp3`);
  const wav = path.join(dir, `${slug(text)}.wav`);
  if (fs.existsSync(mp3)) return { file: mp3, mime: 'audio/mpeg' };
  if (fs.existsSync(wav)) return { file: wav, mime: 'audio/wav' };
  if (voice === 'edge') {
    try { fs.writeFileSync(mp3, await edge(text)); return { file: mp3, mime: 'audio/mpeg' }; } catch (err) { console.log(`(Edge voice failed: ${err.message.slice(0, 60)} — using the Windows voice)`); voice = 'windows'; }
  }
  windowsVoice(text, wav);
  return { file: wav, mime: 'audio/wav' };
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const modes = [...Object.keys(hints), 'fixed'];
const totals = Object.fromEntries(modes.map((m) => [m, { hit: 0, of: 0 }]));
for (const s of sentences) {
  const clip = await clipFor(s.say);
  const row = { say: s.say, terms: s.terms, modes: {} };
  for (const [mode, prompt] of Object.entries(hints)) {
    const heard = vocabulary.apply(await transcribe({ audio: fs.readFileSync(clip.file), mimeType: clip.mime, keys, prompt, language: 'en' }));
    const { hit, missed } = termHits(s.terms, heard);
    totals[mode].hit += hit.length;
    totals[mode].of += s.terms.length;
    row.modes[mode] = { heard, missed };
    // fixed = "now" + the name fixer after hearing (what Novi does since 2026-10-21)
    if (mode === 'now') {
      const fixed = fixNames(heard, hintNames(projects, claudeNames));
      const f = termHits(s.terms, fixed);
      totals.fixed.hit += f.hit.length;
      totals.fixed.of += s.terms.length;
      row.modes.fixed = { heard: fixed, missed: f.missed };
    }
    await pause(3500); // Groq's free speech limit is about 20 a minute
  }
  results.push(row);
  const miss = Object.entries(row.modes).map(([m, r]) => `${m}: ${r.missed.length ? r.missed.join(', ') : 'all'}`).join(' | ');
  console.log(`${s.say}\n   missed → ${miss.replace(/: all/g, ': none')}`);
}

const pct = (t) => `${Math.round((t.hit / t.of) * 100)}% (${t.hit}/${t.of})`;
console.log('\nNames heard right:');
for (const [mode, t] of Object.entries(totals)) console.log(`  ${mode.padEnd(6)} ${pct(t)}`);
const out = path.resolve(`data/term-benchmark-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), voice, hints, totals, results }, null, 2));
console.log(`\nDetails: ${out}`);
