// "Bring my work in" (2026-11-12). The user worked somewhere else (an AI site, a tool, a file they made) and
// says "include that in <project>". Nothing here knows any site: the tab is matched on its own title and
// address, else the tab used last; the user's Downloads are looked at by time.
import fs from 'node:fs';
import path from 'node:path';
import { isPrivateFile } from '../commit/work.js';

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const FILLER = new Set('the a an my our on in at from of new ai tool tab site page app work stuff'.split(' '));

// The tab the user means. named: every meaningful word of it found in the title or address scores; the best
// score wins (ties: the one used last). Not named: the tab used last. Novi's own tabs (skip) never.
export function pickTab(tabs, named, skip = []) {
  const list = (tabs || []).filter((t) => t && /^https?:/i.test(t.url || '') && !skip.some((s) => String(t.url || '').includes(s)));
  const recent = (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0);
  const all = words(named);
  if (!all.length) return [...list].sort(recent)[0] || null;
  // Filler words don't count, unless that's all there is ("the new AI tool").
  const meaningful = all.filter((w) => !FILLER.has(w));
  const want = meaningful.length ? meaningful : all.filter((w) => !['the', 'a', 'an', 'my', 'our', 'on', 'in', 'at', 'from', 'of'].includes(w));
  // Whole words only (or the start of one, for 4+ letters): "no" never matches inside "non" (live 2026-11-12),
  // and at least half of what was said must match, so a name with no such tab gets none.
  const hit = (w, tokens) => tokens.some((tok) => tok === w || (w.length >= 4 && tok.length >= 4 && (tok.startsWith(w) || w.startsWith(tok))));
  const scored = list.map((t) => {
    const tokens = words(`${t.title || ''} ${t.url || ''}`);
    const joined = want.join('');
    const whole = joined.length >= 5 && tokens.join('').includes(joined) ? 1 : 0;
    const matched = want.filter((w) => hit(w, tokens)).length;
    return { t, matched, score: matched + whole };
  }).filter((x) => x.matched * 2 >= want.length && x.score > 0);
  return scored.sort((a, b) => b.score - a.score || recent(a.t, b.t))[0]?.t || null;
}

const PROGRAMS = /\.(?:exe|msi|bat|cmd|ps1|vbs|scr|com|jar|lnk|reg|dll|crdownload|part|tmp)$/i;
const SECRETISH = /(?:^|[\\/])(?:id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials.*|secrets?.*)$/i;
// Files downloaded in the last `minutes`: never programs, half-finished downloads or private-looking files.
export function recentDownloads(dir, { now = Date.now(), minutes = 30, max = 20, maxBytes = 50 * 1024 * 1024 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile() || st.size > maxBytes || now - st.mtimeMs > minutes * 60_000) continue;
    if (PROGRAMS.test(name) || SECRETISH.test(name) || isPrivateFile(name)) continue;
    out.push({ path: p, name, size: st.size, at: st.mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const name = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').replace(/\s+(?:project|app)$/i, '').trim();
// "include what I did on X in Y", "add the work from X to Y", "bring that into Y", "put this in Y",
// "save my X work to Y". Only for that/this/work/what-I-did words, so "add dark mode to Y" stays a build.
export function importCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[?!.]+$/, '').trim();
  const verb = '(?:include|add|bring|put|save|import|copy|move)';
  const into = '(?:in|into|to|inside)';
  let m;
  if ((m = new RegExp(`^${verb}\\s+(?:what i (?:did|made|have done)|the work|my work|the stuff|the results?)\\s+(?:on|in|from|at|with)\\s+(.+?)\\s+${into}\\s+(.+)$`, 'i').exec(t))) return { tool: 'project_import', args: { project: name(m[2]), from: m[1].trim() } };
  if ((m = new RegExp(`^${verb}\\s+(?:my|the)\\s+(.+?)\\s+(?:work|stuff|results?|images?|pictures?)\\s+${into}\\s+(.+)$`, 'i').exec(t))) return { tool: 'project_import', args: { project: name(m[2]), from: m[1].trim() } };
  if ((m = new RegExp(`^${verb}\\s+(?:that|this|it|those|these|what i (?:did|made))\\s+${into}\\s+(.+)$`, 'i').exec(t))) return { tool: 'project_import', args: { project: name(m[1]) } };
  return null;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function importCard({ project, source, images = 0, words: count = 0, files = [] }) {
  const parts = [images ? plural(images, 'picture') : '', count ? 'the text' : '', files.length ? plural(files.length, 'downloaded file') : ''].filter(Boolean);
  const from = source?.title || source?.host || 'your last tab';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return {
    title: `Add work from ${from} to ${project}?`,
    prompt: `Found ${list}${source ? ` from ${from}` : ''}. Add them to ${project}?`,
    detail: [source?.url ? `From: ${source.url}` : '', images ? `Pictures: ${images}` : '', count ? `Text: about ${count} words` : '', ...(files.length ? ['Downloaded files:', ...files.map((f) => `- ${f}`)] : []), '', `Saved in ${project}/assets/imported/ and noted on the board so every agent sees it.`].filter((l) => l !== '').join('\n'),
    source: 'project-import',
  };
}
