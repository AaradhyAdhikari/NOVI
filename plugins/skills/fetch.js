import AdmZip from 'adm-zip';

// Downloads from the skill libraries only: https, these hosts, every redirect checked, size capped.
export const ALLOWED_HOSTS = new Set(['clawhub.ai', 'api.github.com', 'raw.githubusercontent.com']);
const MAX_DOWNLOAD = 5 * 1024 * 1024;
const MAX_UNZIPPED = 10 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_HOPS = 3;

function allowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && !u.username && !u.password && (!u.port || u.port === '443');
}

export async function getSafe(url, { fetchImpl = fetch, max = MAX_DOWNLOAD, accept } = {}) {
  let at = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!allowed(at)) throw new Error(`That address is not allowed for skills (${String(at).slice(0, 80)}).`);
    const res = await fetchImpl(at, { redirect: 'manual', headers: { 'User-Agent': 'novi-skills', ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('A skill library sent a redirect with no address.');
      at = new URL(next, at).href;
      continue;
    }
    if (res.status !== 200) throw new Error(`The skill library answered ${res.status}.`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > max) throw new Error('That skill is too big to download.');
    // Read in pieces and stop at the cap (a reply with no length must not fill memory).
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { try { await reader.cancel(); } catch { /* gone */ } throw new Error('That skill is too big to download.'); }
        parts.push(Buffer.from(value));
      }
      return Buffer.concat(parts);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error('That skill is too big to download.');
    return buf;
  }
  throw new Error('Too many redirects.');
}

export const getJson = async (url, opts) => JSON.parse((await getSafe(url, { ...opts, accept: 'application/json' })).toString('utf8'));

// A skill zip → [{ path, data }]. Sizes come from the zip's own headers and are checked again on read, so a
// zip bomb stops before it unpacks. One top folder ("weather/SKILL.md") is dropped.
export function unzipSkill(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > MAX_FILES) throw new Error('That skill has too many files.');
  let total = 0;
  for (const e of entries) total += Number(e.header.size) || 0;
  if (total > MAX_UNZIPPED) throw new Error('That skill is too big once unpacked.');
  const files = [];
  let read = 0;
  for (const e of entries) {
    const data = e.getData();
    read += data.length;
    if (read > MAX_UNZIPPED) throw new Error('That skill is too big once unpacked.');
    files.push({ path: e.entryName.replace(/\\/g, '/'), data });
  }
  const tops = new Set(files.map((f) => f.path.split('/')[0]));
  if (tops.size === 1 && files.every((f) => f.path.includes('/'))) for (const f of files) f.path = f.path.split('/').slice(1).join('/');
  return files;
}

// "@owner/slug" / "owner/slug" (ClawHub), "github:owner/repo/path", a github.com link, or just a name.
export function parseSource(text) {
  const s = String(text || '').trim();
  let m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w.-]+)\/(.+?))?\/?$/.exec(s);
  if (m) return { kind: 'github', owner: m[1], repo: m[2], path: m[4] || '', ref: m[3] || null };
  m = /^github:([\w.-]+)\/([\w.-]+)(?:\/(.+?))?\/?$/.exec(s);
  if (m) return { kind: 'github', owner: m[1], repo: m[2], path: m[3] || '', ref: null };
  m = /^@?([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (m) return { kind: 'clawhub', owner: m[1], slug: m[2] };
  return { kind: 'name', name: s };
}

const clean = (x) => encodeURIComponent(String(x));

export async function clawhubSearch(query, { fetchImpl, limit = 5 } = {}) {
  const body = await getJson(`https://clawhub.ai/api/v1/search?q=${clean(query)}&limit=${limit}`, { fetchImpl });
  return (body.results || []).slice(0, limit).map((r) => {
    const skill = r.native?.skill || {};
    const owner = r.ownerHandle || r.native?.ownerHandle || '';
    return { ref: `@${owner}/${skill.slug || ''}`, name: r.displayName || skill.displayName || skill.slug, owner, summary: String(skill.summary || '').slice(0, 160), downloads: skill.stats?.downloads || 0, suspicious: Boolean(skill.isSuspicious) };
  }).filter((r) => r.owner && !r.ref.endsWith('/'));
}

export async function clawhubDownload(owner, slug, { fetchImpl } = {}) {
  return unzipSkill(await getSafe(`https://clawhub.ai/api/v1/download?slug=${clean(slug)}&ownerHandle=${clean(owner)}`, { fetchImpl }));
}

// A skill folder in a GitHub repo, file by file (contents API → raw files), at most 3 folders deep.
const plainPart = (x) => /^[\w.-]+$/.test(x) && x !== '.' && x !== '..';
export async function githubDownload({ owner, repo, path = '', ref = null }, { fetchImpl } = {}) {
  if (![owner, repo, ...(ref ? [ref] : []), ...String(path).split('/').filter(Boolean)].every(plainPart)) throw new Error('That GitHub address has odd parts in it.');
  const files = [];
  let total = 0;
  let requests = 0;
  async function walk(dir, depth) {
    if (++requests > 40) throw new Error('That skill folder is too big.');
    const q = ref ? `?ref=${clean(ref)}` : '';
    const list = await getJson(`https://api.github.com/repos/${clean(owner)}/${clean(repo)}/contents/${dir.split('/').map(clean).join('/')}${q}`, { fetchImpl });
    for (const item of Array.isArray(list) ? list : []) {
      if (files.length >= MAX_FILES) throw new Error('That skill has too many files.');
      if (item.type === 'dir' && depth < 3) await walk(item.path, depth + 1);
      else if (item.type === 'file' && item.download_url) {
        if (++requests > 240) throw new Error('That skill folder is too big.');
        if (typeof item.path !== 'string' || (path && !item.path.startsWith(`${path}/`))) continue; // only files inside the asked folder
        const data = await getSafe(item.download_url, { fetchImpl });
        total += data.length;
        if (total > MAX_UNZIPPED) throw new Error('That skill is too big.');
        files.push({ path: path ? item.path.slice(path.length).replace(/^\//, '') : item.path, data });
      }
    }
  }
  await walk(path, 0);
  return files;
}
