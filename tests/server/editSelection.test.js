import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createRewritePlugin } from '../../plugins/rewrite/index.js';
import { editCommand } from '../../server/brain/editCommand.js';

// Edit selected text by voice (checklist, 2026-11-04): select, say "make it shorter", it is replaced.
describe('edit words', () => {
  const e = (how) => ({ tool: 'text_edit_selection', args: { how } });
  it('takes the ways it is said', () => {
    for (const t of ['make it shorter', 'Make this shorter.', 'shorten this', 'make that a bit shorter', 'isko chhota karo']) expect(editCommand(t), t).toEqual(e('shorter'));
    for (const t of ['turn it into bullets', 'make this bullet points', 'convert this to a list']) expect(editCommand(t), t).toEqual(e('bullets'));
    expect(editCommand('make it more formal')).toEqual(e('formal'));
    expect(editCommand('make this professional')).toEqual(e('formal'));
    expect(editCommand('make it casual')).toEqual(e('casual'));
    expect(editCommand('fix the grammar')).toEqual(e('grammar'));
    expect(editCommand('translate this to Hindi')).toEqual(e('translate:Hindi'));
    expect(editCommand('translate it into french')).toEqual(e('translate:french'));
  });
  it('leaves everything else alone', () => {
    for (const t of ['fix it', 'make it blue', 'make a folder', 'translate hello to hindi', 'make it shorter in the navbar']) expect(editCommand(t), t).toBe(null);
  });
});

describe('text_edit_selection', () => {
  function setup({ selected = 'A long sentence that says something simple in many extra words.', before = 'my copied text', answer = 'A short sentence.', readsSecret = false, emptyReads = 0, typeFails = false } = {}) {
    let clip = before;
    let kept = null;
    let empty = 0;
    const did = [];
    const asked = [];
    const callTool = async (name, p) => {
      did.push(p.do);
      if (p.do === 'read' && empty > 0) { empty -= 1; return { note: "There's no text on the clipboard." }; }
      if (p.do === 'read') return readsSecret ? { note: "That looks like a password, I won't read it out." } : clip ? { text: clip } : { note: 'empty' };
      if (p.do === 'set') { clip = p.text; return {}; }
      if (p.do === 'keep') { kept = clip; return {}; }
      if (p.do === 'restore') { clip = kept; return {}; }
      if (p.do === 'copy') { if (selected) clip = selected; empty = emptyReads; return { note: 'Copied.', window: 77 }; }
      if (p.do === 'type') { did.push(['pasted', p.text, p.id, p.reselect]); return typeFails ? { error: 'That window is not in front.' } : { note: 'Typed.' }; }
      return {};
    };
    const llama = { ask: async (sys, text) => { asked.push([sys, text]); if (answer instanceof Error) throw answer; return answer; }, warm: async () => {}, stop() {} };
    const host = new PluginHost({ runtime: { callTool }, logger: { warn() {}, info() {} } });
    expect(host.register(createRewritePlugin({ llama }))).toBe(true);
    return { tool: host.get('text_edit_selection'), did, asked, clip: () => clip };
  }

  it('copies the selection, rewrites it, pastes over it, and puts the old copy back', async () => {
    const s = setup();
    const out = await s.tool.run({ how: 'shorter' });
    expect(out.note).toBe('Rewrote it.');
    expect(s.did.find((d) => d[0] === 'pasted')).toEqual(['pasted', 'A short sentence.', 77, true]); // only where it was copied from, and left selected for the next edit
    expect(s.asked[0][1]).toMatch(/^A long sentence/);
    expect(s.clip()).toBe('my copied text');
  });

  // Live 2026-11-04: the model took 32 s, another window came forward, and the words went there.
  it('never claims success when the first window could not take the words', async () => {
    const s = setup({ typeFails: true });
    expect((await s.tool.run({ how: 'shorter' })).error).toMatch(/in front/);
    expect(s.clip()).toBe('my copied text');
  });

  // Live 2026-11-04: right after Ctrl+C the clipboard reads empty for a moment.
  it('waits for a slow copy instead of calling it a password', async () => {
    const s = setup({ emptyReads: 2 });
    expect((await s.tool.run({ how: 'shorter' })).note).toBe('Rewrote it.');
  });

  it('an empty clipboard stays empty, with no Novi marker left on it', async () => {
    const s = setup({ before: '', selected: '' });
    await s.tool.run({ how: 'shorter' });
    expect(s.clip()).toBe('');
  });

  it('nothing selected: says so, changes nothing, old copy back', async () => {
    const s = setup({ selected: '' });
    expect((await s.tool.run({ how: 'shorter' })).error).toMatch(/select all/i);
    expect(s.asked).toEqual([]);
    expect(s.clip()).toBe('my copied text');
  });

  it('a selection that looks like a password is never touched', async () => {
    const s = setup({ readsSecret: true });
    expect((await s.tool.run({ how: 'shorter' })).error).toMatch(/password/);
    expect(s.asked).toEqual([]);
    expect(s.clip()).toBe('my copied text');
  });

  it('a bad or failed answer leaves the text exactly as it was', async () => {
    for (const answer of ['', 'Sure! Here is your text.', new Error('down')]) {
      const s = setup({ answer });
      expect((await s.tool.run({ how: 'grammar' })).error).toMatch(/couldn't/i);
      expect(s.did.some((d) => d[0] === 'pasted')).toBe(false);
      expect(s.clip()).toBe('my copied text');
    }
  });

  it('a selection too long to read whole is refused, never cut off', async () => {
    const s = setup({ selected: 'x'.repeat(2000) });
    expect((await s.tool.run({ how: 'grammar' })).error).toMatch(/too much/);
    expect(s.asked).toEqual([]);
    expect(s.clip()).toBe('my copied text');
  });

  it('"shorter" that isn\'t shorter is not pasted', async () => {
    const s = setup({ selected: 'Short.', answer: 'A much longer sentence than before.' });
    expect((await s.tool.run({ how: 'shorter' })).error).toMatch(/couldn't/i);
  });

  it('the AI choosing it by itself asks first; the user\'s own words do not', async () => {
    const s = setup();
    expect((await s.tool.gate({ how: 'shorter' })).approval).toBeTruthy();
    expect(await s.tool.gate({ how: 'shorter' }, { direct: true })).toEqual({});
  });
});

describe('select and copy by voice', () => {
  const sel = (what, n) => ({ tool: 'laptop_select', args: n ? { what, n } : { what } });
  const copy = (from, n) => ({ tool: 'screen_copy_lines', args: { from, n } });
  it('select words', () => {
    for (const t of ['select all', 'Select everything.', 'select all the text', 'select the text', 'sab select karo']) expect(editCommand(t), t).toEqual(sel('all'));
    expect(editCommand('select the first three lines')).toEqual(sel('first', 3));
    expect(editCommand('select first line')).toEqual(sel('first', 1));
    expect(editCommand('select the last 2 lines')).toEqual(sel('last', 2));
    expect(editCommand('select this line')).toEqual(sel('line'));
  });
  it('copy words', () => {
    expect(editCommand('Copy the first three lines.')).toEqual(copy('first', 3));
    expect(editCommand('copy first line')).toEqual(copy('first', 1));
    expect(editCommand('copy the last 5 lines')).toEqual(copy('last', 5));
    expect(editCommand('pehli teen lines copy karo')).toEqual(copy('first', 3));
  });
  it('leaves the rest alone', () => {
    for (const t of ['select the first result', 'select option 2', 'copy this link', 'copy your answer']) expect(editCommand(t), t).toBe(null);
  });
});
