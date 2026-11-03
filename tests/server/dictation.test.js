import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { PluginHost } from '../../server/plugins/host.js';
import { createDictationPlugin } from '../../plugins/dictation/index.js';
import { dictationCommand, enterCommand, chainCommand } from '../../server/brain/dictationCommand.js';
import { judgeHeard } from '../../server/voice/heardFilter.js';

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

  it('"open X, then type … and send" in any app or box (2026-11-04)', () => {
    expect(dictationCommand('type lofi music in youtube and send')).toEqual({ text: 'lofi music', app: 'youtube', enter: true });
    expect(dictationCommand('type hi in whatsapp and send')).toEqual({ text: 'hi', app: 'whatsapp', enter: true });
    expect(dictationCommand('type hello in brave')).toEqual({ text: 'hello', app: 'brave' });
    expect(dictationCommand('type lofi music in the search box and send')).toEqual({ text: 'lofi music', target: 'search box', enter: true });
    expect(dictationCommand('type see you at 5 in the message box')).toEqual({ text: 'see you at 5', target: 'message box' });
  });

  it('the screen types all at once through the clipboard: no first letters lost, any language, old copy put back', () => {
    const ps = fs.readFileSync(new URL('../../plugins/screen/win.ps1', import.meta.url), 'utf8');
    const type = /'type' \{[\s\S]*?\n  \}/.exec(ps)[0];
    expect(type).toMatch(/Set-Clipboard -Value/);
    expect(type).toMatch(/SendWait\('\^v'\)/);
    expect(type).toMatch(/Set-Clipboard -Value \$before/);
    expect(type).not.toMatch(/SendWait\(\$text\)/);
  });

  it('"enter" as its own step: bare words only while working step by step, "press enter" any time', () => {
    for (const t of ['Enter.', 'enter', 'send', 'Send it.', 'okay, send it', 'bhej do', 'go', 'search']) expect(enterCommand(t, { steps: true })).toBe(true);
    expect(enterCommand('press enter')).toBe(true);
    expect(enterCommand('hit enter', { steps: false })).toBe(true);
    for (const t of ['enter', 'send', 'send it', 'go']) expect(enterCommand(t)).toBe(false);
    for (const t of ['enter the room', 'send a message to Isha', 'go home', 'search for cats']) expect(enterCommand(t, { steps: true })).toBe(false);
  });

  it('"enter" by the laptop mic is not noise', () => {
    for (const t of ['Enter.', 'Send.', 'Bhejo.']) expect(judgeHeard({ text: t, confidence: -0.3, followUp: true })).toBe(null);
  });

  it('"and enter" in the sentence presses Enter; a word "enter" inside the words does not', () => {
    expect(dictationCommand('type claude code and enter')).toEqual({ text: 'claude code', enter: true });
    expect(dictationCommand('type claude code, enter')).toEqual({ text: 'claude code', enter: true });
    expect(dictationCommand('type please enter')).toEqual({ text: 'please enter' });
  });

  it('all in one sentence: open, then type', () => {
    expect(chainCommand('open youtube type claude code and enter')).toEqual({ open: 'open youtube', type: 'type claude code and enter' });
    expect(chainCommand('Hey Novi, open notepad and type hello there')).toEqual({ open: 'open notepad', type: 'type hello there' });
    expect(chainCommand('open youtube, then type lofi, enter.')).toEqual({ open: 'open youtube', type: 'type lofi, enter' });
    expect(chainCommand('youtube kholo aur type lofi and send')).toEqual({ open: 'open youtube', type: 'type lofi and send' });
    for (const t of ['open youtube', 'type hello', 'open my type notes', 'open the file named type a']) expect(chainCommand(t)).toBe(null);
  });

  it('the screen helper stays running: starting PowerShell cost 0.7 s per step, 6 s per typed line (2026-11-04)', () => {
    const ps = fs.readFileSync(new URL('../../plugins/screen/win.ps1', import.meta.url), 'utf8');
    expect(ps).toMatch(/function Invoke-Screen/);
    expect(ps).toMatch(/if \(\$cmd -eq 'serve'\)/);
    expect(ps).toMatch(/FromBase64String/); // any language reaches it intact
    const plugin = fs.readFileSync(new URL('../../plugins/screen/index.js', import.meta.url), 'utf8');
    expect(plugin).toMatch(/createControlWorker\(\{ script: SCRIPT, args: \['serve'\]/);
    expect(plugin).not.toMatch(/execFile\('powershell\.exe'/);
  });

  it('never: messages to people, notes, questions about types', () => {
    for (const t of ['type a message to Isha saying hi', 'what type of fruit is this', 'note mein ye likho', 'type', 'typing speed test']) expect(dictationCommand(t), t).toBeNull();
  });
});

describe('dictation: "… and send" (user, 2026-10-29)', () => {
  it('"type: X and send" / "X likho aur bhej do" ask for Enter after typing', () => {
    expect(dictationCommand('type: see you at 5 and send')).toEqual({ text: 'see you at 5', enter: true });
    expect(dictationCommand('type hello there aur bhej do')).toEqual({ text: 'hello there', enter: true });
    expect(dictationCommand('type: see you at 5')).toEqual({ text: 'see you at 5' });
    expect(dictationCommand('type hi in whatsapp and send')).toEqual({ text: 'hi', app: 'whatsapp', enter: true });
  });
});
