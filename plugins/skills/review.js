// What a downloaded skill contains, read without any AI and before any card. A skill (agentskills.io /
// OpenClaw / ClawHub) is a folder with SKILL.md (frontmatter + instructions) and maybe other files. Novi uses
// only the instructions; it never runs a skill's scripts. These checks are a guard, not proof: the user's
// card and Novi's normal approvals on every action stay the real protection.

const HIDDEN = /[​-‏‪-‮⁠-⁯﻿]/;
const PROGRAM = /\.(exe|dll|so|dylib|msi|scr|com|jar|bin|node|apk|app|deb|rpm|sys|pif)$/i;
const SCRIPT = /\.(py|js|mjs|cjs|ts|sh|bash|zsh|ps1|psm1|bat|cmd|rb|pl|php|vbs|lua|go)$/i;
const TEXT = /\.(md|txt|json|ya?ml|toml|csv|html?|xml)$|^[^.]+$/i;
const ACTION_WORDS = ['send', 'post', 'email', 'message', 'delete', 'remove', 'pay', 'purchase', 'buy', 'transfer', 'upload', 'publish', 'tweet', 'commit', 'push'];

// Red flags: instructions aimed at the AI to go around the user, hide actions or take secrets away.
const RED_FLAGS = [
  [/ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|your|system)\s+(?:instructions|rules|prompts?|guidelines)/i, 'tells the AI to ignore its rules'],
  [/(?:don'?t|do not|never)\s+(?:tell|inform|ask|show|notify|let)\s+(?:the\s+)?user/i, 'tells the AI to keep things from you'],
  [/without\s+(?:asking|telling|approval|confirmation|permission|the user knowing)/i, 'tells the AI to act without asking you'],
  [/(?:bypass|skip|disable|turn off|avoid)\s+(?:the\s+|any\s+|all\s+)?(?:approvals?|confirmations?|safety|security|permission|cards?)/i, 'tells the AI to get around approvals'],
  [/-e(?:nc(?:odedcommand)?)?\s+[A-Za-z0-9+/=]{24,}/i, 'contains an encoded command'],
  [/[A-Za-z0-9+/]{240,}={0,2}/, 'contains a long encoded blob'],
  [/(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|fetch|nc|scp)\b[^\n]{0,160}(?:\.env\b|id_rsa|\.ssh|passwords?\b|cookies?\b|\.aws|credentials)/i, 'sends secret files somewhere'],
  [/(?:iex|invoke-expression)\b|\|\s*(?:sh|bash|iex|powershell)\b/i, 'downloads and runs code'],
];

export const normalize = (text) => String(text).normalize('NFKC').replace(/[​-‏‪-‮⁠-⁯﻿]/g, '');

function parseValue(raw) {
  const v = raw.trim();
  if (/^[{[]/.test(v)) { try { return JSON.parse(v); } catch { return v; } }
  return v.replace(/^["']|["']$/g, '');
}

// The YAML frontmatter, read plainly: top-level "key: value" lines (JSON values allowed); nested YAML is kept
// as text under its key so the review can still search it.
export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) { key = top[1]; meta[key] = top[2] ? parseValue(top[2]) : ''; continue; }
    if (key && /^\s+/.test(line)) meta[key] = `${typeof meta[key] === 'string' ? meta[key] : JSON.stringify(meta[key])}\n${line}`;
  }
  return { meta, body: m[2] };
}

const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
// Relative, inside the folder, and a name Windows treats plainly (no streams "a:b", no trailing dot/space, no CON/NUL).
const safePath = (p) => p && !p.startsWith('/') && !p.startsWith('\\') && !p.includes(':') && !p.split(/[\\/]/).some((part) => part === '..' || part === '.' || part === '' || /[. ]$/.test(part) || RESERVED.test(part));

function unique(list, max = 12) { return [...new Set(list)].slice(0, max); }

function commandsIn(text) {
  const out = [];
  for (const block of text.matchAll(/```(?:bash|sh|shell|zsh|console|powershell|ps1|pwsh|cmd|bat)?\s*\n([\s\S]*?)```/gi)) {
    for (const line of block[1].split('\n')) {
      const cmd = line.trim().replace(/^\$\s+/, '');
      if (!cmd || cmd.startsWith('#')) continue;
      const word = /^([A-Za-z][\w.-]*)/.exec(cmd)?.[1];
      if (word && !/^(output|e\.g|note)$/i.test(word)) out.push(word.toLowerCase());
    }
  }
  return unique(out, 10);
}

function deepFind(value, key) {
  if (!value || typeof value !== 'object') return [];
  const found = Array.isArray(value[key]) ? value[key] : [];
  return [...found, ...Object.values(value).flatMap((v) => deepFind(v, key))];
}

// files: [{ path, data: Buffer }] with paths relative to the skill folder.
export function reviewSkill(files) {
  const refused = [];
  const skillFile = files.find((f) => f.path === 'SKILL.md');
  if (!skillFile) refused.push('it has no SKILL.md');
  for (const f of files) {
    if (!safePath(f.path)) refused.push(`a file has an unsafe path (${String(f.path).slice(0, 60)})`);
    else if (PROGRAM.test(f.path)) refused.push(`it carries a program (${f.path})`);
  }
  const texts = files.filter((f) => safePath(f.path) && TEXT.test(f.path.split('/').pop()) && !SCRIPT.test(f.path)).map((f) => ({ path: f.path, raw: f.data.toString('utf8') }));
  for (const t of texts) if (HIDDEN.test(t.raw)) { refused.push(`it has hidden characters (${t.path})`); break; }
  const allText = texts.map((t) => normalize(t.raw)).join('\n');
  for (const [re, why] of RED_FLAGS) if (re.test(allText)) refused.push(`it ${why}`);

  const { meta, body } = parseFrontmatter(skillFile ? normalize(skillFile.data.toString('utf8')) : '');
  const name = String(meta.name || '').trim().slice(0, 60);
  if (skillFile && !name) refused.push('its SKILL.md has no name');
  const metaText = JSON.stringify(meta);
  const env = unique([...deepFind(meta.metadata, 'env'), ...(metaText.match(/\b[A-Z][A-Z0-9_]*_(?:API_KEY|KEY|TOKEN|SECRET)\b/g) || [])].map(String));
  const bins = unique(deepFind(meta.metadata, 'bins').map(String));
  const hosts = unique([...allText.matchAll(/\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi), ...allText.matchAll(/\b((?:[a-z0-9-]+\.)+(?:in|io|com|org|net|dev|ai|app))\b(?=[/?"'\s])/gi)].map((m) => m[1].toLowerCase()));
  const lower = allText.toLowerCase();
  return {
    refused: unique(refused, 20),
    name,
    description: String(meta.description || '').trim().slice(0, 300),
    files: files.map((f) => f.path),
    scripts: files.filter((f) => SCRIPT.test(f.path)).map((f) => f.path),
    commands: unique([...commandsIn(body), ...bins]),
    hosts,
    env,
    actions: ACTION_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)),
    instructions: body.trim(),
  };
}

// The card's detail: what the skill can do, in plain words.
export function reviewText(r, source = '') {
  const list = (a, none = 'none') => (a.length ? a.join(', ') : none);
  return [
    `What it does: ${r.description || '(no description)'}`,
    source ? `From: ${source}` : '',
    `Files: ${r.files.length} (${r.files.slice(0, 6).join(', ')}${r.files.length > 6 ? ', …' : ''})`,
    `Scripts: ${r.scripts.length ? `${r.scripts.length}, never run by Novi (${r.scripts.slice(0, 5).join(', ')})` : 'none'}`,
    `Commands it tells the AI to use: ${list(r.commands)}${r.commands.length ? '. Each one asks you first.' : ''}`,
    `Websites it mentions: ${list(r.hosts)}`,
    `Keys it wants: ${list(r.env)}`,
    `Sends, changes or deletes: ${r.actions.length ? `${r.actions.join(', ')}. Novi asks you each time.` : 'none mentioned'}`,
    'While a skill is in use, every step Novi takes for it asks you first.',
  ].filter(Boolean).join('\n');
}
