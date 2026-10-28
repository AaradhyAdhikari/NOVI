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

// [{ folder, asked, doing, updatedAt, sessionId }] for sessions changed in the last `withinMs`, newest first.
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
      const entries = [];
      for (const line of tailLines(file)) {
        try {
          const e = JSON.parse(line);
          if (!e.isSidechain && !e.isMeta) entries.push(e);
        } catch { /* a line still being written */ }
      }
      if (!entries.length) continue;
      const folder = [...entries].reverse().find((e) => e.cwd)?.cwd || null;
      let asked = '';
      for (let i = entries.length - 1; i >= 0 && !asked; i -= 1) if (entries[i].type === 'user') asked = askedText(entries[i]);
      out.push({ folder, asked, doing: doingOf(entries), updatedAt: mtime, sessionId: name.replace(/\.jsonl$/, '') });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function activityLine(s, project) {
  return `Claude Code is working on ${project}${s.asked ? `: "${s.asked}"` : ''}. Right now it is ${s.doing}.`;
}
