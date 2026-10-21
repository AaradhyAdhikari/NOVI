// Tech words from the user's projects for the speech hint (user's ChatGPT plan, 2026-10-21: coding by
// voice must hear "FastAPI", "WebSocket", "Firebase" and the project names right). No AI: names come
// from each project's package.json, requirements.txt, pyproject.toml and README.
import fs from 'node:fs';
import path from 'node:path';

// Package / word (lowercase) → how it is written. `*` = an everyday word too ("react", "express"):
// in a README it only counts written exactly so.
const KNOWN = {
  react: '*React', 'react-dom': '*React', 'react-native': 'React Native', next: '*Next.js', 'next.js': 'Next.js', vue: 'Vue', svelte: 'Svelte', angular: 'Angular',
  vite: 'Vite', tailwindcss: 'Tailwind', tailwind: 'Tailwind', express: '*Express', fastify: 'Fastify', 'socket.io': 'Socket.IO', ws: 'WebSocket', websocket: 'WebSocket', websockets: 'WebSocket',
  node: '*Node.js', 'node.js': 'Node.js', nodejs: 'Node.js', typescript: 'TypeScript', javascript: 'JavaScript', electron: 'Electron', three: '*Three.js', 'three.js': 'Three.js',
  axios: 'Axios', prisma: 'Prisma', mongoose: 'MongoDB', mongodb: 'MongoDB', firebase: 'Firebase', 'firebase-admin': 'Firebase', 'supabase-js': 'Supabase', supabase: 'Supabase',
  pg: 'PostgreSQL', postgres: 'PostgreSQL', postgresql: 'PostgreSQL', mysql: 'MySQL', mysql2: 'MySQL', sqlite: 'SQLite', sqlite3: 'SQLite', redis: 'Redis', graphql: 'GraphQL',
  vitest: 'Vitest', jest: 'Jest', playwright: 'Playwright', docker: 'Docker', vercel: 'Vercel', openai: 'OpenAI', langchain: 'LangChain', groq: 'Groq', 'groq-sdk': 'Groq',
  fastapi: 'FastAPI', uvicorn: 'Uvicorn', flask: '*Flask', django: 'Django', streamlit: 'Streamlit', pandas: 'pandas', numpy: 'NumPy', scikit: 'scikit-learn', 'scikit-learn': 'scikit-learn',
  tensorflow: 'TensorFlow', torch: 'PyTorch', pytorch: 'PyTorch', 'opencv-python': 'OpenCV', opencv: 'OpenCV', mediapipe: 'MediaPipe', pydantic: 'Pydantic', sqlalchemy: 'SQLAlchemy',
  flutter: 'Flutter', kotlin: 'Kotlin', arduino: 'Arduino', esp32: 'ESP32', tailscale: 'Tailscale', onnx: 'ONNX', onnxruntime: 'ONNX', whisper: '*Whisper', 'openai-whisper': 'Whisper',
};
const show = (key) => KNOWN[key]?.replace(/^\*/, '');

function fromPackageJson(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return []; }
  return [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]
    .map((n) => n.toLowerCase().replace(/^@[^/]+\//, '')).filter((n) => KNOWN[n]).map(show);
}
const fromRequirements = (text) => String(text).split('\n').map((l) => l.trim().toLowerCase().split(/[\s<>=!~;[#]/)[0]).filter((n) => KNOWN[n]).map(show);
const fromPyproject = (text) => [...String(text).matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[<>=!~[][^"']*)?["']/g)].map((m) => m[1].toLowerCase()).filter((n) => KNOWN[n]).map(show);
function fromReadme(text) {
  const out = [];
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9.+-]*[A-Za-z0-9]/g)) {
    const key = m[0].toLowerCase().replace(/\.$/, '');
    const name = KNOWN[key];
    if (!name) continue;
    if (name.startsWith('*') ? m[0] === name.slice(1) || m[0] === name.slice(1).replace(/\.js$/, '') : true) out.push(name.replace(/^\*/, ''));
  }
  return out;
}

// files: { 'package.json': text, 'requirements.txt': text, 'pyproject.toml': text, 'README.md': text }
export function techWordsFrom(files = {}) {
  const all = [
    ...fromPackageJson(files['package.json'] || '{}'),
    ...fromRequirements(files['requirements.txt'] || ''),
    ...fromPyproject(files['pyproject.toml'] || ''),
    ...fromReadme(files['README.md'] || ''),
  ];
  return [...new Set(all)];
}

const FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'README.md'];
const read = (file) => { try { const st = fs.statSync(file); return st.size <= 64 * 1024 ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; } };

// Every project with a folder; words used by more projects come first.
export function projectTechWords(projects = [], { max = 15 } = {}) {
  const count = new Map();
  for (const p of projects) {
    if (!p?.path) continue;
    const files = Object.fromEntries(FILES.map((f) => [f, read(path.join(p.path, f))]));
    for (const w of techWordsFrom(files)) count.set(w, (count.get(w) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, max);
}

// The word-accuracy test: was each expected name heard? Spaces, dots and capitals don't matter
// ("web socket" = WebSocket, "node js" = Node.js).
const squash = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function termHits(terms, transcript) {
  const heard = squash(transcript);
  const hit = terms.filter((t) => squash(t).length >= 2 && heard.includes(squash(t)));
  return { hit, missed: terms.filter((t) => !hit.includes(t)) };
}

// What the speech hint gets after the user's own words: project folder names (or names), the
// claude.ai project names, then the projects' tech words.
// No empty or two-letter names ("cc", "AI"), each name once whatever its capitals.
export function hintNames(projects = [], claudeNames = [], { max = 15 } = {}) {
  const all = [...projects.map((p) => (p.path ? path.basename(p.path) : p.name)), ...claudeNames, ...projectTechWords(projects, { max })];
  const out = [];
  for (const n of all) {
    if (String(n || '').replace(/[^\p{L}]/gu, '').length < 3) continue;
    const at = out.findIndex((x) => x.toLowerCase() === String(n).toLowerCase());
    if (at < 0) out.push(n);
    else if (out[at] === out[at].toLowerCase() && n !== n.toLowerCase()) out[at] = n; // "FLEXR" over the folder's "flexr"
  }
  return out;
}

// After hearing: a near-miss of one of the user's names becomes the name (word-accuracy run
// 2026-10-21: "tracebytes" → TraceBites, "Sinesync" → Signsync, "Flexer" → FLEXR, "Versil" → Vercel).
// Only names of 5+ letters, same first letter. Up to two words joined: one letter off at most
// ("trace bytes", "medi kiosk"). One word: also the same consonant sounds ("Versil"), or two letters
// off for names of 8+ letters. A word that already is the name stays as said ("react").
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}
const skeleton = (s) => s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
  .replace(/(.)(?=.)/, '$1').replace(/^(.)|[aeiouy]/g, (m, first) => first || '').replace(/(.)\1+/g, '$1');

export function fixNames(text, names = []) {
  const known = [...new Set(names)].map((n) => ({ name: n, key: squash(n) })).filter((n) => n.key.length >= 5);
  if (!known.length) return String(text);
  const tokens = String(text).split(/(\s+)/);
  const words = tokens.map((t, i) => (i % 2 === 0 ? t : null));
  const core = (t) => /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(t);
  for (let i = 0; i < words.length; i += 2) {
    if (!words[i]) continue;
    for (const span of [2, 1]) {
      const last = i + (span - 1) * 2;
      if (last >= words.length || !words[last]) continue;
      const parts = [];
      for (let k = i; k <= last; k += 2) parts.push(words[k]);
      const heard = squash(parts.join(''));
      if (heard.length < 4) continue;
      const match = known.find(({ key }) => {
        if (key[0] !== heard[0] || Math.abs(key.length - heard.length) > 2) return false;
        if (span === 1 && heard === key) return false; // already right
        const d = distance(heard, key);
        if (span === 2) return d <= 1;
        return d <= 1 || (key.length >= 8 && d <= 2) || (skeleton(heard) === skeleton(key) && skeleton(key).length >= 3);
      });
      if (!match) continue;
      const lead = core(parts[0])[1];
      const tail = core(parts[parts.length - 1])[3];
      tokens[i] = `${lead}${match.name}${tail}`;
      for (let k = i + 1; k <= last; k++) tokens[k] = '';
      for (let k = i + 2; k <= last; k += 2) words[k] = null;
      break;
    }
  }
  return tokens.join('').replace(/\s{2,}/g, ' ');
}
