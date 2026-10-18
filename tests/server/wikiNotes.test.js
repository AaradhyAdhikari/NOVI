import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createWikiPlugin } from '../../plugins/wiki/index.js';

const NOW = new Date(2026, 9, 15, 9, 0);

function setup({ obsidian = false, answer = 'The DBMS exam is on 3 Nov.' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-notes-'));
  const vaultDir = path.join(root, 'Novi Memory');
  const prompts = [];
  const opened = [];
  const host = new PluginHost({ runtime: { privateComplete: async (p) => { prompts.push(p); return answer; } }, env: {}, logger: { warn() {} } });
  host.register(createWikiPlugin({ now: () => NOW, env: { NOVI_MEMORY_DIR: vaultDir }, openPath: async (p) => opened.push(p), obsidianInstalled: () => obsidian }));
  const note = (t) => fs.readFileSync(path.join(vaultDir, 'Notes', `${t}.md`), 'utf8');
  return { host, vaultDir, prompts, opened, note };
}

describe('Novi Memory: notes', () => {
  it('an all-lowercase title takes the capitals the next write gives it ("portfolio brief" → "Portfolio brief")', async () => {
    const { host, note, vaultDir } = setup();
    await host.get('note_write').run({ title: 'portfolio brief', text: 'Round 1.' });
    const out = await host.get('note_write').run({ title: 'Portfolio brief', text: 'Round 2.' });
    expect(out).toMatchObject({ title: 'Portfolio brief', created: false });
    expect(fs.readdirSync(path.join(vaultDir, 'Notes'))).toEqual(['Portfolio brief.md']);
    expect(note('Portfolio brief')).toMatch(/# Portfolio brief\n\nRound 1\.\n\nRound 2\.\n$/);
  });
  it('note_write makes a note with front matter; the same title appends', async () => {
    const { host, note } = setup();
    const out = await host.get('note_write').run({ title: 'DBMS plan', text: 'Exam on 3 Nov.' });
    expect(out).toMatchObject({ title: 'DBMS plan', created: true });
    expect(note('DBMS plan')).toMatch(/^---\ncreated: 2026-10-15\nupdated: 2026-10-15\nsource: novi\n---\n\n# DBMS plan\n\nExam on 3 Nov\./);
    const again = await host.get('note_write').run({ title: 'dbms plan', text: 'Unit 3 is normalization.' });
    expect(again.created).toBe(false);
    expect(note('DBMS plan')).toMatch(/Exam on 3 Nov\.\n\nUnit 3 is normalization\.\n$/);
  });

  it('title defaults to the first 6 words; unsafe characters are cleaned', async () => {
    const { host } = setup();
    expect((await host.get('note_write').run({ text: 'buy milk eggs bread and some fruit today please' })).title).toBe('buy milk eggs bread and some');
    expect((await host.get('note_write').run({ title: 'a/b:c?', text: 'x' })).title).toBe('abc');
  });

  it('links other notes by their full title', async () => {
    const { host, note } = setup();
    await host.get('note_write').run({ title: 'DBMS plan', text: 'Exam on 3 Nov.' });
    await host.get('note_write').run({ title: 'Tonight', text: 'Revise the DBMS plan tonight.' });
    expect(note('Tonight')).toContain('Revise the [[DBMS plan]] tonight.');
  });

  it('refuses secrets and writes nothing', async () => {
    const { host, vaultDir } = setup();
    const out = await host.get('note_write').run({ title: 'bank', text: 'my password is hunter2' });
    expect(out.note).toBe("I won't save passwords or codes in notes.");
    expect(fs.existsSync(path.join(vaultDir, 'Notes', 'bank.md'))).toBe(false);
  });

  it('asks once when the AI chooses to write a note', async () => {
    const { host } = setup();
    const gate = await host.get('note_write').gate({ title: 'DBMS plan', text: 'x' });
    expect(gate.approval.title).toBe('Write note DBMS plan');
  });

  it('notes_ask: sends at most 6 best notes (title matches first) to the private brain and names the sources', async () => {
    const { host, prompts } = setup();
    for (let i = 1; i <= 8; i++) await host.get('note_write').run({ title: `misc ${i}`, text: `exam reminder ${i}` });
    await host.get('note_write').run({ title: 'DBMS exam', text: 'On 3 Nov in hall B.' });
    const out = await host.get('notes_ask').run({ question: 'when is my DBMS exam?' });
    expect(out.sources[0]).toBe('DBMS exam');
    expect(out.sources.length).toBeLessThanOrEqual(6);
    expect(out.answer).toBe('The DBMS exam is on 3 Nov. From your notes: ' + out.sources.join(', ') + '.');
    expect(prompts[0]).toMatch(/ONLY from these notes/);
    expect(out.sensitive).toBe(true);
  });

  it('notes_ask with nothing relevant', async () => {
    const { host, prompts } = setup();
    await host.get('note_write').run({ title: 'groceries', text: 'milk' });
    expect((await host.get('notes_ask').run({ question: 'what about quantum physics?' })).answer).toBe("Your notes don't mention quantum physics.");
    expect(prompts).toHaveLength(0);
  });

  it('note_open: Obsidian when installed, else the file; notes_list', async () => {
    const a = setup({ obsidian: true });
    await a.host.get('note_write').run({ title: 'DBMS plan', text: 'x' });
    await a.host.get('note_open').run({ title: 'dbms plan' });
    expect(a.opened[0]).toMatch(/^obsidian:\/\/open\?path=.*DBMS%20plan\.md$/);
    const b = setup({ obsidian: false });
    await b.host.get('note_write').run({ title: 'DBMS plan', text: 'x' });
    await b.host.get('note_open').run({ title: 'DBMS plan' });
    expect(b.opened[0]).toBe(path.join(b.vaultDir, 'Notes', 'DBMS plan.md'));
    expect((await b.host.get('notes_list').run({})).notes.map((n) => n.title)).toEqual(['DBMS plan']);
    expect((await b.host.get('note_open').run({ title: 'nothing' })).note).toBe("I don't have a note called nothing.");
  });
});

// The orchestrator saves each brief as a note (2026-10-18), without the note_write approval card.
describe('Novi Memory for other plugins', () => {
  it('runtime.wikiWrite saves (and appends); wikiRead gives the text back; secrets are refused', async () => {
    const { host, note } = setup();
    expect(host.runtime.wikiWrite({ title: 'Portfolio brief', text: '## 2026-10-15\nGoal: a blog.' })).toMatchObject({ title: 'Portfolio brief', created: true });
    host.runtime.wikiWrite({ title: 'portfolio brief', text: '## 2026-10-16\nGoal: dark mode.' });
    expect(note('Portfolio brief')).toMatch(/Goal: a blog\.\n\n## 2026-10-16\nGoal: dark mode\.\n$/);
    expect(host.runtime.wikiRead('Portfolio Brief')).toMatch(/^# Portfolio brief\n\n## 2026-10-15/);
    expect(host.runtime.wikiRead('Nothing here')).toBe(null);
    expect(host.runtime.wikiWrite({ title: 'x', text: 'my password is hunter2' })).toEqual({ refused: true });
  });
});
