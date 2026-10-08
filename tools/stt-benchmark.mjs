// Speech-to-text benchmark on the user's own recordings (Settings → Voice test, data/voice-samples).
// Runs every clip through a few setups and scores word errors against what was meant to be said.
// Usage: node --env-file-if-exists=.env tools/stt-benchmark.mjs
// Results (private, they contain transcripts) go to data/stt-benchmark-<date>.json.
import fs from 'node:fs';
import path from 'node:path';
import { transcribe, DEFAULT_PROMPT } from '../server/voice/stt.js';
import { createGeminiStt } from '../server/voice/providers/geminiStt.js';
import { createSarvamStt } from '../server/voice/providers/sarvamStt.js';
import { createGroqWhisperStt } from '../server/voice/providers/groqWhisper.js';
import { createSpeechEngine } from '../server/voice/speechEngine.js';
import { createVocabulary } from '../server/voice/vocabulary.js';

const DIR = path.resolve('data/voice-samples');
const keys = (name) => String(process.env[name] || '').split(',').map((k) => k.trim()).filter(Boolean);
const groqKeys = keys('GROQ_API_KEYS').length ? keys('GROQ_API_KEYS') : keys('GROQ_API_KEY');
const geminiKeys = keys('GEMINI_API_KEYS').length ? keys('GEMINI_API_KEYS') : keys('GEMINI_API_KEY');
const sarvamKeys = keys('SARVAM_API_KEYS').length ? keys('SARVAM_API_KEYS') : keys('SARVAM_API_KEY');

// Names and words Novi hears a lot, in both scripts.
const RICH_PROMPT = 'Hey Novi. Novi, Novi Coder, Claude, Groq, Gemini, GitHub, LeetCode, YouTube, Gmail, Pune, Antigravity, reminder, timer, alarm, lofi. नोवी, पुणे, यूट्यूब, ईमेल, टाइमर.';

// What Novi actually does now: Whisper first (with your word list as hint), Hindi / Marathi
// re-sent to Sarvam, then your word-list fixes (Settings → Words).
const vocabulary = createVocabulary({ file: path.resolve('data/vocabulary.json') });
const noviEngine = () => {
  const sarvam = createSarvamStt({ keys: sarvamKeys });
  return createSpeechEngine({ stt: [createGroqWhisperStt({ keys: groqKeys, prompt: vocabulary.prompt }), sarvam], indic: sarvam });
};
const MIME = { wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg' };

// The latest voice-test recording per phrase, plus real commands marked "Wrong" (data/voice-samples/real).
export function loadClips(dir) {
  const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
  let index = [];
  try { index = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  const tests = [...new Map(index.map((c) => [c.phraseId, c])).values()]
    .filter((c) => c.expected && fs.existsSync(path.join(dir, c.file)))
    .map((c) => ({ ...c, mimeType: 'audio/wav' }));
  const real = readJson(path.join(dir, 'real', 'expected.json'), [])
    .filter((r) => r.said && fs.existsSync(path.join(dir, 'real', r.file)))
    .map((r) => ({ phraseId: `real:${r.file}`, lang: 'real', expected: r.said, file: path.join('real', r.file), mimeType: MIME[r.file.split('.').pop()] || 'audio/wav' }));
  return [...tests, ...real];
}

const SETUPS = [
  { name: 'Novi now (Whisper, then Sarvam for hi/mr)', run: async (a, mimeType) => vocabulary.apply((await noviEngine().transcribe({ audio: a, mimeType })).text), gapMs: 3200 },
  { name: 'today: turbo + short hint', run: (a, mimeType) => transcribe({ audio: a, mimeType, keys: groqKeys }), gapMs: 3200 },
  { name: 'full v3 + short hint', run: (a, mimeType) => transcribe({ audio: a, mimeType, keys: groqKeys, model: 'whisper-large-v3' }), gapMs: 3200 },
  { name: 'turbo + rich hint', run: (a, mimeType) => transcribe({ audio: a, mimeType, keys: groqKeys, prompt: RICH_PROMPT }), gapMs: 3200 },
  { name: 'full v3 + rich hint', run: (a, mimeType) => transcribe({ audio: a, mimeType, keys: groqKeys, model: 'whisper-large-v3', prompt: RICH_PROMPT }), gapMs: 3200 },
  { name: 'Sarvam v4 (auto language)', run: (a, mimeType) => createSarvamStt({ keys: sarvamKeys }).transcribe({ audio: a, mimeType }), gapMs: 1500, skip: !sarvamKeys.length },
  { name: 'Sarvam v3 codemix', run: (a, mimeType) => createSarvamStt({ keys: sarvamKeys, model: 'saaras:v3', mode: 'codemix' }).transcribe({ audio: a, mimeType }), gapMs: 1500, skip: !sarvamKeys.length },
  { name: 'Gemini (backup)', run: (a, mimeType) => createGeminiStt({ keys: geminiKeys }).transcribe({ audio: a, mimeType }), gapMs: 4500, skip: !geminiKeys.length },
];

// Lowercase, no punctuation (incl. Devanagari danda), single spaces.
export const normalize = (t) => String(t || '').toLowerCase().normalize('NFC').replace(/[.,!?;:"'’“”()¿¡।॥-]/g, ' ').replace(/\s+/g, ' ').trim();

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export const wordErrorRate = (expected, heard) => {
  const e = normalize(expected).split(' ').filter(Boolean);
  return e.length ? Math.min(1, editDistance(e, normalize(heard).split(' ').filter(Boolean)) / e.length) : 0;
};

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
const chosen = () => SETUPS.filter((s) => !s.skip && (!only || s.name.toLowerCase().includes(only)));

async function main() {
  if (!groqKeys.length && !only) throw new Error('No GROQ_API_KEYS in .env');
  const clips = loadClips(DIR);
  console.log(`${clips.length} clips × ${chosen().length} setups (paced for the free tier, a few minutes)…`);
  const results = [];
  for (const setup of chosen()) {
    for (const clip of clips) {
      const audio = fs.readFileSync(path.join(DIR, clip.file));
      let heard = '';
      let error = null;
      const t0 = Date.now();
      try { heard = String(await setup.run(audio, clip.mimeType)); } catch (err) { error = err.message; }
      results.push({ setup: setup.name, phrase: clip.phraseId, lang: clip.lang, expected: clip.expected, heard, wer: error ? 1 : wordErrorRate(clip.expected, heard), ms: Date.now() - t0, error });
      await new Promise((r) => setTimeout(r, setup.gapMs));
    }
    process.stdout.write(`  done: ${setup.name}\n`);
  }
  const out = path.resolve(`data/stt-benchmark-${new Date().toISOString().slice(0, 10)}${only ? `-${only.replace(/W+/g, '-')}` : ''}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));

  const langs = ['en', 'hinglish', 'hi', 'mr', 'real'];
  console.log(`\nWord error rate (lower is better)\n${'setup'.padEnd(28)}${['all', ...langs].map((l) => l.padStart(10)).join('')}${'avg ms'.padStart(9)}  errors`);
  for (const setup of chosen()) {
    const rows = results.filter((r) => r.setup === setup.name);
    const avg = (rs) => (rs.length ? `${Math.round((rs.reduce((n, r) => n + r.wer, 0) / rs.length) * 100)}%` : '-');
    const ms = Math.round(rows.reduce((n, r) => n + r.ms, 0) / rows.length);
    console.log(`${setup.name.padEnd(28)}${[avg(rows), ...langs.map((l) => avg(rows.filter((r) => r.lang === l)))].map((v) => v.padStart(10)).join('')}${String(ms).padStart(9)}  ${rows.filter((r) => r.error).length}`);
  }
  console.log(`\nDetails: ${path.relative(process.cwd(), out)}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch((err) => { console.error(err.message); process.exit(1); });
