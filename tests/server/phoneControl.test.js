import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createPhoneControlPlugin } from '../../plugins/phone-control/index.js';
import { phoneCommand, onPhone } from '../../plugins/phone-control/parse.js';
import { createPhoneActions } from '../../server/phoneActions.js';

// Phone typing (user, 2026-10-29: "Yes, build phone typing"): Novi types and taps inside phone apps
// through the Novi app's Accessibility service.
describe('phone commands', () => {
  it('reads what to do on the phone', () => {
    expect(phoneCommand('type hello on my phone')).toEqual({ do: 'type', text: 'hello' });
    expect(phoneCommand('phone pe type hello aur bhej do')).toEqual({ do: 'type', text: 'hello', enter: true });
    expect(phoneCommand('type see you and send')).toEqual({ do: 'type', text: 'see you', enter: true });
    expect(phoneCommand('send it')).toEqual({ do: 'enter' });
    expect(phoneCommand('tap login')).toEqual({ do: 'tap', target: 'login' });
    expect(phoneCommand('click the search button on my phone')).toEqual({ do: 'tap', target: 'the search button' });
    expect(phoneCommand('go back')).toEqual({ do: 'back' });
    expect(phoneCommand('go home')).toEqual({ do: 'home' });
    expect(phoneCommand('scroll down twice')).toEqual({ do: 'scroll', dir: 'down', times: 2 });
    expect(phoneCommand('search for pizza near me')).toEqual({ do: 'type', text: 'pizza near me', enter: true, search: true });
    expect(phoneCommand('what is the weather')).toBe(null);
  });

  it('knows when the words are about the phone', () => {
    expect(onPhone('type hello on my phone')).toBe(true);
    expect(onPhone('phone pe type hello')).toBe(true);
    expect(onPhone('type hello in my phone')).toBe(true);
    expect(onPhone('type hello')).toBe(false);
    expect(onPhone('send this video to my phone')).toBe(false); // sending a link to the phone, not acting on it
  });
});

describe('phone_action', () => {
  const mk = (answer = { ok: true, note: 'Typed it.' }) => {
    const sent = [];
    const host = new PluginHost({ runtime: { phoneAction: async (a) => { sent.push(a); return answer; } }, env: {}, logger: { warn() {} } });
    expect(host.register(createPhoneControlPlugin())).toBe(true);
    return { sent, tool: host.get('phone_action') };
  };

  it('sends the step to the phone and says what happened', async () => {
    const { sent, tool } = mk();
    expect((await tool.run({ do: 'type', text: 'hi', enter: true })).note).toBe('Typed it.');
    expect(sent).toEqual([{ do: 'type', text: 'hi', enter: true }]);
  });

  it('the phone refusing (password box, bank app) is said as it is', async () => {
    const { tool } = mk({ ok: false, note: 'This looks sensitive. Please do this part yourself.' });
    expect((await tool.run({ do: 'type', text: 'x' })).error).toBe('This looks sensitive. Please do this part yourself.');
  });

  it('no card when the user said it; the AI choosing it asks', async () => {
    const { tool } = mk();
    expect(await tool.gate({ do: 'type', text: 'hi' }, { direct: true })).toEqual({});
    expect((await tool.gate({ do: 'type', text: 'hi' }, { direct: false })).approval).toMatchObject({ category: 'screen' });
  });

  it('never types a password said aloud', async () => {
    const { sent, tool } = mk();
    expect((await tool.run({ do: 'type', text: 'my password is hunter2' })).error).toBe("I can't type passwords aloud. Please type it yourself.");
    expect(sent).toEqual([]);
  });
});

describe('phone actions: one request, one answer', () => {
  it('sends to the phone and waits for its answer', async () => {
    const sent = [];
    const pa = createPhoneActions({ send: (deviceId, msg) => { sent.push([deviceId, msg]); return 1; }, timeoutMs: 1000 });
    const p = pa.request('phone1', { do: 'type', text: 'hi' });
    expect(sent[0][0]).toBe('phone1');
    expect(sent[0][1]).toMatchObject({ type: 'phone_action', do: 'type', text: 'hi' });
    pa.settle({ type: 'phone_action_result', id: sent[0][1].id, ok: true, note: 'Typed it.' });
    expect(await p).toEqual({ ok: true, note: 'Typed it.' });
  });

  it('no phone connected / no answer in time', async () => {
    const none = createPhoneActions({ send: () => 0, timeoutMs: 50 });
    expect(await none.request('phone1', { do: 'back' })).toEqual({ ok: false, note: "Your phone isn't connected to Novi. Open the Novi app on it." });
    const quiet = createPhoneActions({ send: () => 1, timeoutMs: 20 });
    expect(await quiet.request('phone1', { do: 'back' })).toEqual({ ok: false, note: "The phone didn't answer. Is Novi's typing switched on in the phone's Accessibility settings?" });
  });
});

describe('phone_action with the spoken words (the agent\'s route)', () => {
  const mk = () => {
    const sent = [];
    const host = new PluginHost({ runtime: { phoneAction: async (a) => { sent.push(a); return { ok: true, note: 'Sent.' }; } }, env: {}, logger: { warn() {} } });
    host.register(createPhoneControlPlugin());
    return { sent, tool: host.get('phone_action') };
  };
  it('reads the words itself: inside a phone app any phone step, else only with "on my phone"', async () => {
    const { sent, tool } = mk();
    expect((await tool.run({ said: 'type hi and send', inApp: true })).note).toBe('Sent.');
    expect(sent.at(-1)).toEqual({ do: 'type', text: 'hi', enter: true });
    expect((await tool.run({ said: 'type hi', inApp: false })).unknown).toBe(true);
    expect((await tool.run({ said: 'what is the weather', inApp: true })).unknown).toBe(true);
    expect(sent.length).toBe(1);
  });
});
