import { describe, it, expect } from 'vitest';
import { Agent } from '../../server/brain/agent.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { ToolRegistry } from '../../server/tools/registry.js';
import { typingStep } from '../../server/brain/dictationCommand.js';

// User, 2026-11-08: in the remote view, "when I say type it should start typing … asap, and when I say enter
// … sent it". "Type" turns on typing: every phrase after it is typed as you pause, the mic opens again by
// itself, "enter" sends and ends it, "stop typing" ends it.
describe('what a phrase means while typing', () => {
  it('words are typed as said', () => {
    expect(typingStep('hello there')).toEqual({ text: 'hello there' });
    expect(typingStep('How are you?')).toEqual({ text: 'How are you?' });
  });
  it('"enter" / "send it" at the end sends what came before', () => {
    expect(typingStep('see you tomorrow, enter')).toEqual({ text: 'see you tomorrow', enter: true });
    expect(typingStep('see you tomorrow enter.')).toEqual({ text: 'see you tomorrow', enter: true });
    expect(typingStep('Enter.')).toEqual({ text: '', enter: true });
    expect(typingStep('send it')).toEqual({ text: '', enter: true });
    expect(typingStep('ok bhej do')).toEqual({ text: 'ok', enter: true });
  });
  it('"stop typing" ends it; a lone "Thank you." (speech-to-text noise) is not typed', () => {
    expect(typingStep('stop typing')).toEqual({ stop: true });
    expect(typingStep('Done typing.')).toEqual({ stop: true });
    expect(typingStep('Thank you.')).toEqual({ text: '' });
  });
});

function mk() {
  const ran = [];
  const tool = (name, run) => ({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async (a) => { ran.push([name, a]); return run(a); } });
  const tools = new ToolRegistry()
    .add(tool('screen_type_into', () => ({ note: 'Typed it.' })))
    .add(tool('screen_enter', () => ({ note: 'Pressed Enter.' })));
  const agent = new Agent({ router: { chat: async () => ({ message: { role: 'assistant', content: 'AI' }, provider: 'groq', model: 'm' }) }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
  const typing = [];
  agent.liveViewing = (from) => from?.deviceId === 'p1';
  agent.liveTyping = (from, on) => typing.push([from.deviceId, on]);
  return { agent, ran, typing };
}
const P1 = { from: { deviceId: 'p1' } };

describe('typing by voice in the remote view', () => {
  // User, 2026-11-08 (after typing stayed on and swallowed "Open YouTube", "Scroll down"): "as I say type it
  // should get typed in the chatbox and when I say send it should get sent". Typing is once, never sticky.
  it('"type hello there" types it once; the next phrase is a command again', async () => {
    const s = mk();
    await s.agent.handle('Type hello there.', P1);
    expect(s.ran).toEqual([['screen_type_into', { text: 'hello there.' }]]);
    await s.agent.handle('scroll down', P1);
    expect(s.ran).toHaveLength(1); // not typed
  });
  it('"send" / "enter" press Enter', async () => {
    const s = mk();
    expect(await s.agent.handle('Send.', P1)).toMatch(/sent/i);
    await s.agent.handle('enter', P1);
    expect(s.ran).toEqual([['screen_enter', {}], ['screen_enter', {}]]);
  });
  it('"type X and send" types and sends', async () => {
    const s = mk();
    await s.agent.handle('type see you tomorrow and send', P1);
    expect(s.ran).toEqual([['screen_type_into', { text: 'see you tomorrow' }], ['screen_enter', {}]]);
  });
  it('a bare "type" (or the Type button) types only the next phrase', async () => {
    const s = mk();
    expect(await s.agent.handle('Type.', P1)).toMatch(/say it/i);
    await s.agent.handle('hello there', P1);
    await s.agent.handle('scroll down', P1);
    expect(s.ran).toEqual([['screen_type_into', { text: 'hello there' }]]);
  });
  // Live 2026-11-08: "typing" alone and "typing X" were asked back.
  it('"typing" means type too', async () => {
    const s = mk();
    expect(await s.agent.handle('Typing.', P1)).toMatch(/say it/i);
    await s.agent.handle('hello', P1);
    await s.agent.handle('typing see you soon', P1);
    expect(s.ran).toEqual([['screen_type_into', { text: 'hello' }], ['screen_type_into', { text: 'see you soon' }]]);
  });
  it('only for the phone watching the remote view', async () => {
    const s = mk();
    expect(await s.agent.handle('Type.', { from: { deviceId: 'p2' } })).not.toMatch(/say it/i);
    expect(s.typing).toEqual([]);
  });
});
// sent to the AI ("Nt.js, Tx." went to the AI live). "Novi, …" / "ask …" still reach the AI.
describe('in the remote view, a phrase that is no step', () => {
  it('is asked back with examples', async () => {
    const s = mk();
    const reply = await s.agent.handle('Nt.js, Tx.', P1);
    expect(reply).toMatch(/didn't get that/i);
    expect(reply).toMatch(/click/);
  });
  it('"Novi, …" or "ask …" still goes to the AI; other phones are untouched', async () => {
    const s = mk();
    expect(await s.agent.handle('Novi, what time is it in London', P1)).toBe('AI');
    expect(await s.agent.handle('Nt.js, Tx.', { from: { deviceId: 'p2' } })).toBe('AI');
  });
});

import { controlCommand } from '../../server/brain/controlCommand.js';

// Live 2026-11-08 in the remote view: "Pipe." (= type), "Switch back to Claude.", "Novii, open ChatGPT.",
// "Nui, …" and a stray "Thank you." all got the ask-back.
describe('remote view phrases as actually heard', () => {
  it('"switch back to X" / "go back to X" bring that window forward', () => {
    expect(controlCommand('Switch back to Claude.')).toMatchObject({ tool: 'laptop_window', args: { app: 'Claude', do: 'focus' } });
    expect(controlCommand('go back to chrome')).toMatchObject({ tool: 'laptop_window', args: { do: 'focus' } });
  });
  function mk2() {
    const s = mk();
    const tool = (name, run) => ({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async (a) => { s.ran.push([name, a]); return run(a); } });
    s.agent.tools.add(tool('open_app', (a) => ({ opened: a.name })));
    return s;
  }
  it('a misheard "Novi" in front is dropped before the step runs', async () => {
    const s = mk2();
    expect(await s.agent.handle('Novii, open Spotify.', P1)).toMatch(/Opened/);
    expect(await s.agent.handle('Nui, open Spotify', P1)).toMatch(/Opened/);
    expect(s.ran.filter(([n]) => n === 'open_app')).toHaveLength(2);
  });
  it('"Pipe." means type; "Thank you." is ignored without a word', async () => {
    const s = mk();
    expect(await s.agent.handle('Pipe.', P1)).toMatch(/say it/i);
    expect(await s.agent.handle('Thank you.', P1)).toBe('');
  });
});

import { replyPlace } from '../../server/liveReplies.js';

// User, 2026-11-08: "when I am on the live screen it shouldn't be logging those things in the Novi … hide all
// those commands", and the yellow line "should be telling me what it did".
describe('where a remote-view turn shows', () => {
  it('the phone watching the view: on the view only, never in the chat', () => {
    expect(replyPlace({ from: { deviceId: 'p1' }, viewing: true })).toBe('view');
  });
  it('anywhere else: the chat as before', () => {
    expect(replyPlace({ from: { deviceId: 'p1' }, viewing: false })).toBe('chat');
    expect(replyPlace({ from: 'local', viewing: true })).toBe('chat');
  });
});

import { phoneSpeech, onHeard, heard } from '../../src/lib/phoneSpeech.js';

// The remote view listens with the phone's own speech recognition when the Novi app offers it (app 2.5.0).
describe('phone speech in the remote view', () => {
  it('used only when the app has it and says it works', () => {
    expect(phoneSpeech({})).toBe(null);
    expect(phoneSpeech({ NoviApp: { recognize() {}, canRecognize: () => false } })).toBe(null);
    const app = { recognize() {}, canRecognize: () => true };
    expect(phoneSpeech({ NoviApp: app })).toBe(app);
  });
  it('results reach the one listener, partial and final', () => {
    const got = [];
    const stop = onHeard((r) => got.push(r));
    heard('a', 'open spo', false, '');
    heard('a', 'open spotify', true, '');
    stop();
    heard('a', 'ignored', true, '');
    expect(got).toEqual([{ id: 'a', text: 'open spo', final: false, error: '' }, { id: 'a', text: 'open spotify', final: true, error: '' }]);
  });
});
