// What Claude Code is working on right now, in ANY session on this laptop (the Claude app, a terminal,
// or one Novi started): Claude Code writes every session to ~/.claude/projects/<folder>/<id>.jsonl, so a
// file changed in the last minutes is a session at work. Its folder, the user's last request and the
// step it is on are read from the end of the file. No AI. (Live 2026-10-29: "what is Claude working
// on?" got "isn't working on any task" while a Claude-app session was busy on NOVI.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RECENT_MS = 10 * 60_000;
const base = (p) => path.basename(String(p || '').replace(/\\/g, '/'));

// The last lines of a (possibly huge) session file.
function tailLines(file, bytes = 400_000) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // cut mid-line
    return lines.filter((l) => l.trim());
  } finally {
    fs.closeSync(fd);
  }
}

// The user's own words in a "user" line (not tool results, reminders or commands).
function askedText(entry) {
  const c = entry?.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((p) => p?.type === 'tool_result')) return '';
    text = c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
  }
  // The Claude app puts system notes (<system-reminder>…) before the words: cut them out, keep the words.
  text = text.replace(/<(system-reminder|pasted_content|command-[\w-]+|local-command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || /^</.test(text) || /^Caveat:/i.test(text)) return '';
  return text.length > 120 ? `${text.slice(0, 120).trimEnd()}…` : text;
}

function stepOf(name, input = {}) {
  if (/^(?:Write|NotebookEdit)$/.test(name)) return `writing ${base(input.file_path || input.notebook_path)}`;
  if (/^(?:Edit|MultiEdit)$/.test(name)) return `editing ${base(input.file_path)}`;
  if (name === 'Read') return `reading ${base(input.file_path)}`;
  if (/^(?:Bash|PowerShell)$/.test(name)) return `running a command${input.description ? `: ${input.description}` : ''}`;
  if (/^(?:Grep|Glob)$/.test(name)) return 'searching the code';
  if (/^(?:WebSearch|WebFetch)$/.test(name)) return 'looking something up online';
  if (name === 'TodoWrite') return 'planning its steps';
  if (/^(?:Task|Agent)$/.test(name)) return 'working with a helper';
  if (/^mcp__/.test(name)) return 'using one of its tools';
  return `using ${name}`;
}

function doingOf(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    const tools = e.message.content.filter((p) => p?.type === 'tool_use');
    if (tools.length) return stepOf(tools.at(-1).name, tools.at(-1).input);
    if (e.message.content.some((p) => p?.type === 'text')) return 'writing a reply';
  }
  return 'getting started';
}

const toolUses = (entries) => entries.flatMap((e, i) => (e.type === 'assistant' && Array.isArray(e.message?.content)
  ? e.message.content.filter((p) => p?.type === 'tool_use').map((p) => ({ ...p, at: i })) : []));

// The step it is on: the Claude app's own plan (update_plan: items, then advance / start / done) or a
// terminal session's TodoWrite list. { n, of, title, doing? } or null.
function stepOfPlan(uses) {
  let items = null;
  for (const u of uses) {
    const inp = u.input || {};
    if (u.name === 'TodoWrite' && Array.isArray(inp.todos)) items = inp.todos.map((t) => ({ title: t.content, doing: t.activeForm, status: t.status }));
    else if (/update_plan$/.test(u.name)) {
      if (Array.isArray(inp.items)) items = inp.items.map((t) => ({ title: t.content, status: t.status }));
      else if (items) {
        const cur = items.findIndex((t) => t.status === 'in_progress');
        if (inp.advance && cur >= 0) { items[cur].status = 'completed'; if (items[cur + 1]) items[cur + 1].status = 'in_progress'; }
        for (const d of [].concat(inp.done || [])) if (items[d - 1]) items[d - 1].status = 'completed';
        if (inp.start && items[inp.start - 1]) { items.forEach((t) => { if (t.status === 'in_progress') t.status = 'completed'; }); items[inp.start - 1].status = 'in_progress'; }
      }
    }
  }
  const i = items ? items.findIndex((t) => t.status === 'in_progress') : -1;
  if (i < 0) return null;
  return { n: i + 1, of: items.length, title: String(items[i].title || '').trim(), ...(items[i].doing ? { doing: String(items[i].doing).trim() } : {}) };
}

// The files it changed lately (newest first, at most 2) and what kind of work that looks like.
const TEST_CMD = /\b(?:vitest|jest|pytest|mocha|npm (?:run )?test|yarn test|pnpm test|go test|cargo test)\b/i;
const FAILED = /\bFAIL\b|\bfailed\b|AssertionError|\bError:|Traceback|✗|×/;
function workOf(entries, uses) {
  const recent = uses.slice(-15);
  const files = [];
  for (const u of [...recent].reverse()) {
    const f = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/.test(u.name) && base(u.input?.file_path || u.input?.notebook_path);
    if (f && !files.includes(f)) files.push(f);
  }
  const failing = recent.some((u) => /^(?:Bash|PowerShell)$/.test(u.name) && TEST_CMD.test(u.input?.command || '') && entries.slice(u.at + 1, u.at + 3).some((e) => {
    const c = e.message?.content;
    return Array.isArray(c) && c.some((p) => p?.type === 'tool_result' && FAILED.test(typeof p.content === 'string' ? p.content : JSON.stringify(p.content || '')));
  }));
  const last = recent.at(-1);
  let kind = null;
  if (failing) kind = 'debugging failing tests';
  else if (last && /^(?:Bash|PowerShell)$/.test(last.name) && TEST_CMD.test(last.input?.command || '')) kind = 'running the tests';
  else if (files.length && files.every((f) => /\.(?:test|spec)\.|^test_/i.test(f))) kind = 'writing tests';
  else if (files.some((f) => /\.(?:css|scss|sass|less|html?|jsx|tsx|vue|svelte|kt|xml)$/i.test(f))) kind = 'working on the UI';
  else if (recent.length >= 3 && recent.slice(-3).every((u) => /^(?:Read|Grep|Glob)$/.test(u.name))) kind = 'reading the code';
  return { files: files.slice(0, 2), kind };
}

// [{ folder, asked, doing, step, kind, files, updatedAt, sessionId }] for sessions changed in the last `withinMs`, newest first.
export function activeSessions({ home = os.homedir(), dir = path.join(home, '.claude', 'projects'), now = Date.now(), withinMs = RECENT_MS } = {}) {
  const out = [];
  let folders = [];
  try { folders = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const f of folders) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, f.name)).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const name of files) {
      const file = path.join(dir, f.name, name);
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (now - mtime > withinMs) continue;
      // The end of the file, read further back (≤ 6 MB) when the request isn't in it: one big tool output
      // can fill the first 400 KB (live: a 9.6 MB Claude-app session showed only "running a command").
      const read = (bytes) => {
        const out = [];
        for (const line of tailLines(file, bytes)) {
          try {
            const e = JSON.parse(line);
            if (!e.isSidechain && !e.isMeta) out.push(e);
          } catch { /* a line still being written */ }
        }
        return out;
      };
      let entries = read(400_000);
      if (!entries.some((e) => e.type === 'user' && askedText(e))) entries = read(6_000_000);
      if (!entries.length) continue;
      const folder = [...entries].reverse().find((e) => e.cwd)?.cwd || null;
      let asked = '';
      let askedAt = -1;
      for (let i = entries.length - 1; i >= 0 && !asked; i -= 1) if (entries[i].type === 'user') { asked = askedText(entries[i]); if (asked) askedAt = i; }
      const uses = toolUses(entries);
      // The kind of work and its files: only what was done since that request.
      const { files, kind } = workOf(entries, uses.filter((u) => u.at > askedAt));
      out.push({ folder, asked, doing: doingOf(entries), step: stepOfPlan(uses), kind, files, updatedAt: mtime, sessionId: name.replace(/\.jsonl$/, '') });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// "In NOVI, Claude is on step 3 of 4, "Build X": editing a.js. You asked: "…"." — the specific thing first
// (its step, else the kind of work), then the file(s), then the request (user, 2026-10-29: "too generic").
export function activityLine(s, project) {
  const editing = s.files?.length ? `editing ${s.files.join(' and ')}` : '';
  const now = s.files?.length > 1 && /^(?:editing|writing) /.test(s.doing || '') ? editing : s.doing;
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  let what;
  if (s.step?.doing) what = `${lower(s.step.doing)} (step ${s.step.n} of ${s.step.of}): ${now}`;
  else if (s.step) what = `on step ${s.step.n} of ${s.step.of}, "${s.step.title}": ${now}`;
  else if (s.kind) what = `${s.kind}: ${now}`;
  else what = now;
  return `In ${project}, Claude is ${what}.${s.asked ? ` You asked: "${s.asked}".` : ''}`;
}
