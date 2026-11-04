import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PluginHost } from '../../server/plugins/host.js';
import { createRewritePlugin, safeRewrite } from '../../plugins/rewrite/index.js';
import { createLlama } from '../../plugins/rewrite/llama.js';

// Offline rewrite (user, 2026-11-04, checklist row "AI rewrite cleanup, offline"): the local model
// polishes dictated words. It may only ever make them better: anything odd keeps the user's words.
describe('safeRewrite: the words are never lost', () => {
  const said = 'um so i think we should move the meeting to tomorrow';
  it('takes a sensible rewrite, without quotes around it', () => {
    expect(safeRewrite(said, '"I think we should move the meeting to tomorrow."')).toBe('I think we should move the meeting to tomorrow.');
  });
  it('a rewrite that loses most of the words is a different sentence (live: Hinglish)', () => {
    expect(safeRewrite('kal milte hain yaar', 'I have them, yaar.')).toBe('kal milte hain yaar');
    expect(safeRewrite('Um so basically I think we should like move it to tomorrow you know', 'So, I think we should move it to tomorrow.')).toBe('So, I think we should move it to tomorrow.');
    expect(safeRewrite('What time is the meeting tomorrow', 'What time is the meeting tomorrow?')).toBe('What time is the meeting tomorrow?');
  });

  it('keeps the original when the model answers something else', () => {
    expect(safeRewrite(said, '')).toBe(said);
    expect(safeRewrite(said, 'Sure!')).toBe(said);
    expect(safeRewrite(said, `${said} `.repeat(3))).toBe(said);
    expect(safeRewrite(said, 'Here is the rewritten text: I think we should move the meeting.')).toBe(said);
  });
});

describe('the local model', () => {
  function setup({ answer = 'Clean words.', up = true } = {}) {
    const started = [];
    const child = () => Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('exit'); } });
    const sent = [];
    const timers = [];
    const llama = createLlama({
      command: 'llama-server', model: 'm.gguf', port: 3019, idleMs: 1000, readyMs: 20, pollMs: 1,
      spawnImpl: (cmd, args) => { const c = child(); started.push({ cmd, args, c }); return c; },
      fetchImpl: async (url, opts) => {
        if (url.endsWith('/health')) { if (!up) throw new Error('down'); return { ok: true }; }
        sent.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
      },
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    });
    return { llama, started, sent, timers };
  }

  it('starts once, on demand, on this laptop only, and answers', async () => {
    const s = setup();
    expect(s.started).toEqual([]);
    expect(await s.llama.ask('system', 'um hello')).toBe('Clean words.');
    await s.llama.ask('system', 'again');
    expect(s.started).toHaveLength(1);
    expect(s.started[0].args).toEqual(expect.arrayContaining(['-m', 'm.gguf', '--host', '127.0.0.1', '--port', '3019', '-ngl', '0']));
    expect(s.sent[0].messages.at(-1)).toEqual({ role: 'user', content: 'um hello' });
  });

  it('frees the memory when idle, and starts again when needed', async () => {
    const s = setup();
    await s.llama.ask('system', 'one');
    expect(s.timers.at(-1).ms).toBe(1000);
    s.timers.at(-1).fn();
    expect(s.started[0].c.killed).toBe(true);
    await s.llama.ask('system', 'two');
    expect(s.started).toHaveLength(2);
  });

  it('a model that never comes up is an error, not a hang, and is stopped', async () => {
    const s = setup({ up: false });
    await expect(s.llama.ask('system', 'x')).rejects.toThrow(/start/);
    expect(s.started[0].c.killed).toBe(true);
  });
});

describe('text_rewrite', () => {
  const tool = (llama) => {
    const host = new PluginHost({ runtime: {}, logger: { warn() {}, info() {} } });
    expect(host.register(createRewritePlugin({ llama }))).toBe(true);
    return host.get('text_rewrite');
  };
  it('polishes, and needs no approval (nothing leaves the laptop)', async () => {
    const t = tool({ ask: async () => 'I think it works.', warm: async () => {}, stop() {} });
    expect(await t.gate({ text: 'x' })).toEqual({});
    expect((await t.run({ text: 'um i think it it works' })).text).toBe('I think it works.');
  });
  it('a failed or slow model gives the same words back', async () => {
    const t = tool({ ask: async () => { throw new Error('down'); }, warm: async () => {}, stop() {} });
    expect((await t.run({ text: 'my words' })).text).toBe('my words');
  });
  it('Hindi or Marathi stay as they are (a small model would turn them into English)', async () => {
    let asked = 0;
    const t = tool({ ask: async () => { asked += 1; return 'x'; }, warm: async () => {}, stop() {} });
    expect((await t.run({ text: 'कल मीटिंग है' })).text).toBe('कल मीटिंग है');
    expect(asked).toBe(0);
  });
  it('warm only loads the model', async () => {
    let warmed = 0;
    const t = tool({ ask: async () => 'x', warm: async () => { warmed += 1; }, stop() {} });
    await t.run({ warm: true });
    expect(warmed).toBe(1);
  });
});
