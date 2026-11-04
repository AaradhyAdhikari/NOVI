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
  function setup({ selected = 'A long sentence that says something simple in many extra words.', before = 'my copied text', answer = 'A short sentence.', readsSecret = false } = {}) {
    let clip = before;
    const did = [];
    const asked = [];
    const callTool = async (name, p) => {
      did.push(p.do);
      if (p.do === 'read') return readsSecret ? { note: "That looks like a password, I won't read it out." } : clip ? { text: clip } : { note: 'empty' };
      if (p.do === 'set') { clip = p.text; return {}; }
      if (p.do === 'copy') { if (selected) clip = selected; return { note: 'Copied.' }; }
      if (p.do === 'type') { did.push(['pasted', p.text]); return { note: 'Typed.' }; }
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
    expect(s.did.find((d) => d[0] === 'pasted')).toEqual(['pasted', 'A short sentence.']);
    expect(s.asked[0][1]).toMatch(/^A long sentence/);
    expect(s.clip()).toBe('my copied text');
  });

  it('nothing selected: says so, changes nothing, old copy back', async () => {
    const s = setup({ selected: '' });
    expect((await s.tool.run({ how: 'shorter' })).error).toMatch(/Select the text first/);
    expect(s.asked).toEqual([]);
    expect(s.clip()).toBe('my copied text');
  });

  it('a selection that looks like a password is never touched', async () => {
    const s = setup({ readsSecret: true });
    expect((await s.tool.run({ how: 'shorter' })).error).toMatch(/password/);
    expect(s.asked).toEqual([]);
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
