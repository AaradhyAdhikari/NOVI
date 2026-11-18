import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createLocalModel, trimForLocal, pickModelFile } from '../../server/localModel.js';

function setup({ free = 8e9, size = 2e9, answer = { content: 'Hi there.' } } = {}) {
  const started = [];
  const sent = [];
  const child = () => Object.assign(new EventEmitter(), { kill() { this.emit('exit'); } });
  const model = createLocalModel({
    model: 'm.gguf', readyMs: 20, pollMs: 1, freemem: () => free, fileSize: () => size,
    spawnImpl: (cmd, args) => { const c = child(); started.push({ cmd, args }); return c; },
    fetchImpl: async (url, opts) => {
      if (url.endsWith('/health')) return { ok: true };
      sent.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: answer }] }) };
    },
    setTimer: () => ({}), clearTimer: () => {},
  });
  return { model, started, sent };
}

describe('the shared local model', () => {
  it('starts one server with tool calls on, one slot and an 8k context', async () => {
    const s = setup();
    await s.model.chat({ messages: [{ role: 'user', content: 'hi' }] });
    await s.model.chat({ messages: [{ role: 'user', content: 'again' }] });
    expect(s.started).toHaveLength(1);
    const args = s.started[0].args.join(' ');
    expect(args).toContain('--jinja');
    expect(args).toContain('-np 1');
    expect(args).toContain('-c 8192');
    expect(args).toContain('--host 127.0.0.1');
  });

  it('refuses to start when there is not enough free memory', async () => {
    const s = setup({ free: 1.5e9, size: 2e9 });
    await expect(s.model.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/free memory/i);
    expect(s.started).toEqual([]);
  });

  it('returns the message and passes only a few tools', async () => {
    const s = setup({ answer: { content: '', tool_calls: [{ id: '1', function: { name: 'a', arguments: '{}' } }] } });
    const tools = Array.from({ length: 10 }, (_, i) => ({ type: 'function', function: { name: `t${i}` } }));
    const msg = await s.model.chat({ messages: [{ role: 'user', content: 'hi' }], tools });
    expect(msg.tool_calls[0].function.name).toBe('a');
    expect(s.sent[0].tools).toHaveLength(6);
  });

  it('ask still works for the rewrite plugin', async () => {
    const s = setup({ answer: { content: ' Clean. ' } });
    expect(await s.model.ask('system', 'text')).toBe('Clean.');
  });

  it('status says asleep before and ready after a start', async () => {
    const s = setup();
    expect(s.model.status().state).toBe('asleep');
    await s.model.warm();
    expect(s.model.status().state).toBe('ready');
  });
});

describe('trimForLocal', () => {
  it('keeps system messages and the last few, never starting on a tool result', () => {
    const msgs = [
      { role: 'system', content: 's' },
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })),
      { role: 'assistant', content: '', tool_calls: [{ id: 'x' }] },
      { role: 'tool', tool_call_id: 'x', content: '{}' },
    ];
    const out = trimForLocal(msgs, 6);
    expect(out[0].role).toBe('system');
    expect(out.length).toBeLessThanOrEqual(7);
    expect(out[1].role).not.toBe('tool');
    expect(out.at(-1).role).toBe('tool');
  });
});

describe('pickModelFile', () => {
  it('prefers the bigger model on disk, else the small one, else none', () => {
    expect(pickModelFile(['qwen2.5-1.5b-instruct-q4_k_m.gguf', 'qwen2.5-3b-instruct-q4_k_m.gguf'])).toBe('qwen2.5-3b-instruct-q4_k_m.gguf');
    expect(pickModelFile(['qwen2.5-1.5b-instruct-q4_k_m.gguf', 'x.gguf.part'])).toBe('qwen2.5-1.5b-instruct-q4_k_m.gguf');
    expect(pickModelFile([])).toBe(null);
  });
});

describe('picking the model that fits', () => {
  it('takes the smaller model when the big one does not fit in free memory', async () => {
    const started = [];
    const sizes = { 'big.gguf': 2.1e9, 'small.gguf': 1.1e9 };
    const m = createLocalModel({
      models: ['big.gguf', 'small.gguf'], readyMs: 20, pollMs: 1, freemem: () => 2.2e9, fileSize: (f) => sizes[f],
      spawnImpl: (cmd, args) => { started.push(args); return Object.assign(new EventEmitter(), { kill() {} }); },
      fetchImpl: async (url) => (url.endsWith('/health') ? { ok: true } : { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }),
      setTimer: () => ({}), clearTimer: () => {},
    });
    await m.warm();
    expect(started[0][1]).toBe('small.gguf');
    expect(m.status().model).toBe('small.gguf');
  });
});
