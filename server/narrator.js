import path from 'node:path';

const TEST_RE = /\b(test|tests|jest|vitest|pytest|mocha)\b/i;
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const base = (file) => (file ? path.win32.basename(path.posix.basename(String(file))) : 'a file');

// Models often answer in markdown; speech should not read out the symbols.
export function plainText(text = '') {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function firstSentence(text = '') {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const match = /^.*?[.!?](?=\s|$)/s.exec(trimmed);
  return short(match ? match[0] : trimmed, 160);
}

export function describeEvent(event, agentName = 'Claude') {
  switch (event.kind) {
    case 'tool_use': {
      const { name, input = {} } = event;
      const file = input.file_path || input.notebook_path || input.path;
      if (name === 'Read') return { text: `Reading ${base(file)}`, urgent: false, group: 'read' };
      if (name === 'Glob' || name === 'Grep') return { text: 'Searching the project', urgent: false, group: 'search' };
      if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return { text: `Editing ${base(file)}`, urgent: false, group: 'edit' };
      if (name === 'Write') return { text: `Writing ${base(file)}`, urgent: false, group: 'edit' };
      if (name === 'Bash' || name === 'PowerShell') {
        const command = String(input.command || '');
        return TEST_RE.test(command) ? { text: 'Running the tests', urgent: false } : { text: `Running ${short(command, 40)}`, urgent: false };
      }
      if (name === 'TodoWrite') return null;
      return { text: `Using ${name}`, urgent: false };
    }
    case 'tool_result': {
      if (!event.isError) return null;
      const line = (event.content || 'error').split('\n')[0];
      if (/denied/i.test(line)) return { text: 'Skipped a step you denied', urgent: false };
      return { text: `A step failed: ${short(line, 80)}`, urgent: true };
    }
    case 'result':
      return event.isError
        ? { text: `${agentName} stopped: ${short(event.text || 'an error occurred', 120)}`, urgent: true }
        : { text: `${agentName} finished. ${firstSentence(plainText(event.text))}`.trim(), urgent: true };
    case 'exit':
      if (!event.error && (event.code === 0 || event.code === null)) return null;
      return { text: `${agentName} exited unexpectedly${event.error ? `: ${short(event.error, 80)}` : ''}.`, urgent: true };
    default:
      return null;
  }
}

const GROUP_PHRASE = { read: (n) => `Reading ${n} files`, edit: (n) => `Editing ${n} files`, search: () => 'Searching the project' };

export function summarize(items) {
  const parts = [];
  for (const item of items) {
    const prev = parts[parts.length - 1];
    if (prev && item.group && prev.group === item.group) prev.count += 1;
    else parts.push({ ...item, count: 1 });
  }
  const phrases = parts.map((p) => (p.count > 1 ? GROUP_PHRASE[p.group](p.count) : p.text));
  if (phrases.length <= 3) return phrases.join(', then ');
  return `${phrases.slice(0, 2).join(', then ')}, and ${phrases.length - 2} more steps`;
}

// Turns Claude events into feed lines (all of them) and spoken lines (throttled).
export class Narrator {
  constructor({ onFeed, onSpeak, intervalMs = 8000, agentName = 'Claude' }) {
    this.agentName = agentName;
    this.onFeed = onFeed;
    this.onSpeak = onSpeak;
    this.intervalMs = intervalMs;
    this.pending = [];
    this.timer = null;
  }

  push(event) {
    const d = describeEvent(event, this.agentName);
    if (!d) return;
    this.onFeed(d.text);
    if (d.urgent) {
      this.pending = [];
      this._clearTimer();
      this.onSpeak(d.text);
      return;
    }
    this.pending.push(d);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  flush() {
    this._clearTimer();
    if (!this.pending.length) return;
    const text = summarize(this.pending);
    this.pending = [];
    this.onSpeak(text);
  }

  dispose() {
    this._clearTimer();
    this.pending = [];
  }

  _clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
