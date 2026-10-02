import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeEvent, summarize, Narrator, firstSentence, plainText } from '../../server/narrator.js';

const use = (name, input) => ({ kind: 'tool_use', id: 'x', name, input });

describe('describeEvent', () => {
  it('describes common tools', () => {
    expect(describeEvent(use('Read', { file_path: 'C:\\p\\src\\app.js' })).text).toBe('Reading app.js');
    expect(describeEvent(use('Edit', { file_path: 'src/login.jsx' })).text).toBe('Editing login.jsx');
    expect(describeEvent(use('Write', { file_path: 'src/new.js' })).text).toBe('Writing new.js');
    expect(describeEvent(use('Grep', { pattern: 'x' })).text).toBe('Searching the project');
    expect(describeEvent(use('Bash', { command: 'npm test -- --run' })).text).toBe('Running the tests');
    expect(describeEvent(use('Bash', { command: 'npm install bcrypt' })).text).toBe('Running npm install bcrypt');
    expect(describeEvent(use('TodoWrite', {}))).toBeNull();
  });
  it('makes failures, results and crashes urgent', () => {
    expect(describeEvent({ kind: 'tool_result', isError: true, content: 'Error: boom\nstack' })).toEqual({ text: 'A step failed: Error: boom', urgent: true });
    expect(describeEvent({ kind: 'tool_result', isError: true, content: 'Permission denied by user' }).urgent).toBe(false);
    expect(describeEvent({ kind: 'tool_result', isError: false, content: 'ok' })).toBeNull();
    expect(describeEvent({ kind: 'result', isError: false, text: 'Added login. Also tests.' })).toEqual({ text: 'Claude finished. Added login.', urgent: true });
    expect(describeEvent({ kind: 'result', isError: true, text: 'Usage limit reached' }).text).toBe('Claude stopped: Usage limit reached');
    expect(describeEvent({ kind: 'exit', code: 0, error: null })).toBeNull();
    expect(describeEvent({ kind: 'exit', code: 1, error: null }).urgent).toBe(true);
  });
});

describe('spoken text', () => {
  it('strips markdown from finished summaries so TTS does not read symbols', () => {
    const d = describeEvent({ kind: 'result', isError: false, text: 'Created **math.js** exporting `add(a, b)`. Ran it.' }, 'Novi Coder');
    expect(d.text).toBe('Novi Coder finished. Created math.js exporting add(a, b).');
  });
  it('strips headings and list markers', () => {
    expect(plainText('## Done\n- added *x*')).toBe('Done added x');
  });
});

describe('summarize', () => {
  it('groups consecutive reads and edits', () => {
    const items = [
      { text: 'Reading a.js', group: 'read' }, { text: 'Reading b.js', group: 'read' },
      { text: 'Editing a.js', group: 'edit' },
    ];
    expect(summarize(items)).toBe('Reading 2 files, then Editing a.js');
  });
  it('shortens long sequences', () => {
    const items = ['A', 'B', 'C', 'D', 'E'].map((text) => ({ text }));
    expect(summarize(items)).toBe('A, then B, and 3 more steps');
  });
});

describe('firstSentence', () => {
  it('cuts at the first sentence end', () => {
    expect(firstSentence('One. Two.')).toBe('One.');
    expect(firstSentence('')).toBe('');
  });
});

describe('Narrator', () => {
  afterEach(() => vi.useRealTimers());

  it('feeds every update, batches routine speech, speaks urgent updates immediately', () => {
    vi.useFakeTimers();
    const fed = [];
    const spoken = [];
    const n = new Narrator({ onFeed: (t) => fed.push(t), onSpeak: (t) => spoken.push(t), intervalMs: 8000 });
    n.push(use('Read', { file_path: 'a.js' }));
    n.push(use('Read', { file_path: 'b.js' }));
    expect(spoken).toEqual([]);
    vi.advanceTimersByTime(8000);
    expect(spoken).toEqual(['Reading 2 files']);
    n.push(use('Edit', { file_path: 'a.js' }));
    n.push({ kind: 'result', isError: false, text: 'Done.' });
    expect(spoken).toEqual(['Reading 2 files', 'Claude finished. Done.']);
    vi.advanceTimersByTime(8000);
    expect(spoken).toHaveLength(2);
    expect(fed).toEqual(['Reading a.js', 'Reading b.js', 'Editing a.js', 'Claude finished. Done.']);
  });
});
