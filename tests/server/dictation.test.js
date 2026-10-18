import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createDictationPlugin } from '../../plugins/dictation/index.js';
import { dictationCommand } from '../../server/brain/dictationCommand.js';

// Dictation (user, 2026-10-18): Novi types your words into the app in front. Never presses Enter.
describe('dictation', () => {
  it('dictate_type types through the laptop clipboard (old copy put back) and never asks', async () => {
    const calls = [];
    const host = new PluginHost({ runtime: { callTool: async (name, p) => { calls.push([name, p]); return { note: 'Typed into WhatsApp.' }; } }, logger: { warn() {} } });
    expect(host.register(createDictationPlugin())).toBe(true);
    const tool = host.get('dictate_type');
    expect(await tool.gate({ text: 'hi' })).toEqual({});
    expect(await tool.run({ text: 'see you at 5' })).toMatchObject({ note: 'Typed into WhatsApp.' });
    expect(calls).toEqual([['laptop_clipboard', { do: 'type', text: 'see you at 5' }]]);
    await tool.run({ text: 'hello', app: 'notepad' });
    expect(calls.at(-1)).toEqual(['laptop_clipboard', { do: 'type', text: 'hello', app: 'notepad' }]);
    expect((await tool.run({ text: ' ' })).error).toBe("There's nothing to type.");
  });

  it('"type …" / "likho …" by voice: the words exactly, an app when named', () => {
    expect(dictationCommand('Type: see you at 5.')).toEqual({ text: 'see you at 5.' });
    expect(dictationCommand('hey novi type this I will be late')).toEqual({ text: 'I will be late' });
    expect(dictationCommand('type hello team in notepad')).toEqual({ text: 'hello team', app: 'notepad' });
    expect(dictationCommand('likho kal milte hain')).toEqual({ text: 'kal milte hain' });
    expect(dictationCommand('kal milte hain likh do')).toEqual({ text: 'kal milte hain' });
  });

  it('never: messages to people, notes, questions about types', () => {
    for (const t of ['type a message to Isha saying hi', 'what type of fruit is this', 'note mein ye likho', 'type', 'typing speed test']) expect(dictationCommand(t), t).toBeNull();
  });
});
