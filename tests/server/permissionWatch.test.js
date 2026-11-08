import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PluginHost } from '../../server/plugins/host.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { pickButtons, isPrivateBox, needsPin, cardFor, boxKey } from '../../plugins/permission-watch/boxes.js';
import { createPermissionWatchPlugin } from '../../plugins/permission-watch/index.js';

// User, 2026-11-05: any app's Allow box reaches the phone as a card; a yes presses Allow once.
const CLAUDE = { hwnd: 7, process: 'claude', title: 'Claude', text: 'Claude wants to use a folder on your computer | Folder ~/Documents | Create a new vault called Brain', buttons: ['Decline', 'Allow once'] };

describe('which buttons', () => {
  it('finds the two sides, whatever the order', () => {
    expect(pickButtons(['Decline', 'Allow once'])).toEqual({ yes: 'Allow once', no: 'Decline' });
    expect(pickButtons(['Yes', 'No'])).toEqual({ yes: 'Yes', no: 'No' });
    expect(pickButtons(['Block', 'Allow'])).toEqual({ yes: 'Allow', no: 'Block' });
    expect(pickButtons(["Don't allow", 'Allow'])).toEqual({ yes: 'Allow', no: "Don't allow" });
    expect(pickButtons(['&Yes', '&No'])).toEqual({ yes: '&Yes', no: '&No' });
  });
  it('prefers once, and never picks an always button', () => {
    expect(pickButtons(['Allow always', 'Allow once', 'Deny'])).toEqual({ yes: 'Allow once', no: 'Deny' });
    expect(pickButtons(['Always allow', 'Deny'])).toBe(null);
  });
  it('needs both sides', () => {
    expect(pickButtons(['Allow'])).toBe(null);
    expect(pickButtons(['Decline', 'Help'])).toBe(null);
    expect(pickButtons(['Save', 'Cancel'])).toBe(null);
  });
});

describe('boxes that never become cards', () => {
  it('passwords and payments stay on the laptop', () => {
    for (const text of ['Save this password?', 'Enter your PIN to continue', 'Confirm payment of Rs 500', 'Buy now with your card', 'Send a one-time code'])  {
      expect(isPrivateBox({ text, title: 'App' }), text).toBe(true);
    }
    expect(isPrivateBox(CLAUDE)).toBe(false);
  });
});

describe('what needs the PIN', () => {
  it('computer access does', () => {
    for (const text of ['Let Claude control your screen', 'Use your mouse and keyboard', 'Run this command in the terminal', 'Run a PowerShell script', 'Allow access to the whole C drive', 'Access your home folder', 'Read C:\\ ', 'Install this software', 'This needs administrator rights', 'Delete these files']) {
      expect(needsPin(text), text).toBe(true);
    }
  });
  it('a normal folder or question does not', () => {
    expect(needsPin(CLAUDE.text)).toBe(false);
    expect(needsPin('Use ~/Documents/Notes')).toBe(false);
    expect(needsPin('Do you want to save your changes?')).toBe(false);
  });
});

describe('the card', () => {
  it('names the app and the ask, and waits as long as it takes', () => {
    const card = cardFor(CLAUDE);
    expect(card.title).toBe('Claude: Claude wants to use a folder on your computer');
    expect(card.prompt).toBe('Claude asks: Claude wants to use a folder on your computer.');
    expect(card.detail).toContain('Folder ~/Documents');
    expect(card.timeoutMs).toBe(null);
    expect(card.pin).toBe(false);
    expect(card.grantable).toBe(false);
    expect(card.tag).toBe(boxKey(CLAUDE));
  });
  it('computer access asks for the PIN', () => {
    expect(cardFor({ ...CLAUDE, text: 'Run this command in the terminal' }).pin).toBe(true);
  });
  it('words cut off could hide anything, so the PIN is asked', () => {
    expect(cardFor({ ...CLAUDE, cut: true }).pin).toBe(true);
  });
  it('invisible or lookalike letters do not hide a word', () => {
    expect(needsPin('de\u200Blete these files')).toBe(true);
    expect(needsPin('ｄｅｌｅｔｅ these files')).toBe(true);
    expect(isPrivateBox({ text: 'pass\u200Bword' })).toBe(true);
  });
  it('a box with no words still says which app', () => {
    expect(cardFor({ ...CLAUDE, text: '' }).title).toBe('Claude: asks for your OK');
  });
});

function setup({ answers = [{ allow: true }] } = {}) {
  const asked = [];
  const cancelled = [];
  const pressed = [];
  const said = [];
  let pending = [];
  const proc = new EventEmitter();
  const runtime = {
    ask: (card) => { asked.push(card); const d = answers.shift(); return d ? Promise.resolve(d) : new Promise((resolve) => { pending.push(resolve); }); },
    cancelCard: (tag) => { cancelled.push(tag); pending.shift()?.({ allow: false }); },
    say: (t) => said.push(t),
  };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, info() {} } });
  const createProcess = ({ onEvent }) => ({ start() {}, stop() {}, send: (m) => { pressed.push(m.press); onEvent({ pressed: { id: m.press.id, ok: true } }); } });
  let events;
  const plugin = createPermissionWatchPlugin({ platform: 'win32', goneMs: 10, createProcess: (o) => { events = o.onEvent; return createProcess(o); } });
  expect(host.register(plugin)).toBe(true);
  return { asked, cancelled, pressed, said, host, boxes: (boxes) => events({ boxes }), start: () => host.startServices({}), proc };
}
const tick = () => new Promise((r) => { setTimeout(r, 20); });

describe('watching', () => {
  it('a new box makes one card, and yes presses Allow once in that window', async () => {
    const s = setup();
    await s.start();
    s.boxes([CLAUDE]);
    s.boxes([CLAUDE]);
    await tick();
    expect(s.asked.length).toBe(1);
    expect(s.pressed).toEqual([expect.objectContaining({ hwnd: 7, button: 'Allow once' })]);
  });
  it('no presses Decline', async () => {
    const s = setup({ answers: [{ allow: false }] });
    await s.start();
    s.boxes([CLAUDE]);
    await tick();
    expect(s.pressed).toEqual([expect.objectContaining({ button: 'Decline' })]);
  });
  it('answered on the laptop: the card closes and nothing is pressed', async () => {
    const s = setup({ answers: [] });
    await s.start();
    s.boxes([CLAUDE]);
    await tick();
    s.boxes([]);
    await tick();
    expect(s.cancelled).toEqual([boxKey(CLAUDE)]);
    expect(s.pressed).toEqual([]);
  });
  it('private boxes and one-sided boxes make no card', async () => {
    const s = setup();
    await s.start();
    s.boxes([{ ...CLAUDE, text: 'Save this password?' }, { ...CLAUDE, hwnd: 8, buttons: ['Allow'] }]);
    await tick();
    expect(s.asked).toEqual([]);
  });
  it('a yes carries the words the card showed, so a changed box is not pressed', async () => {
    const s = setup();
    await s.start();
    s.boxes([CLAUDE]);
    await tick();
    expect(s.pressed[0].expect).toBe(CLAUDE.text);
  });
  it('a box whose words change gets a new card, even with the same first line', async () => {
    const s = setup({ answers: [] });
    await s.start();
    s.boxes([CLAUDE]);
    await tick();
    s.boxes([{ ...CLAUDE, text: `${CLAUDE.text} | Then delete everything` }]);
    await tick();
    await tick();
    expect(s.asked.length).toBe(2);
    expect(s.asked[1].pin).toBe(true);
    expect(s.cancelled).toEqual([boxKey(CLAUDE)]);
  });
  it('a card closed by Novi, not by you, presses nothing', async () => {
    for (const d of [{ allow: false, timedOut: true }, { allow: false, closed: true }]) {
      const s = setup({ answers: [d] });
      await s.start();
      s.boxes([CLAUDE]);
      await tick();
      expect(s.pressed).toEqual([]);
    }
  });
  it('one bad scan does not close the card', async () => {
    const s = setup({ answers: [] });
    await s.start();
    s.boxes([CLAUDE]);
    await tick();
    s.boxes([]);
    s.boxes([CLAUDE]);
    await tick();
    expect(s.cancelled).toEqual([]);
    expect(s.asked.length).toBe(1);
  });
  it('a box that stays after the press makes no second card', async () => {
    const s = setup();
    await s.start();
    s.boxes([CLAUDE]);
    await tick();
    s.boxes([CLAUDE]);
    await tick();
    expect(s.asked.length).toBe(1);
  });
});

describe('a card that closes by itself', () => {
  it('cancel closes the card with that tag', async () => {
    const q = new ApprovalQueue();
    const d = q.decide({ title: 'x', tier: 'medium', source: 'watch', tag: 'box-1', timeoutMs: null });
    expect(q.cancel('box-1')).toBe(true);
    expect(await d).toMatchObject({ allow: false, closed: true });
    expect(q.pending()).toEqual([]);
    expect(q.cancel('box-1')).toBe(false);
  });
});

// Live 2026-11-08: a real Notepad box became the card "Notepad: Notepad" (the first words were the window's own name).
describe('the card names the real question', () => {
  const NOTEPAD = { hwnd: 7, process: 'notepad.exe', title: 'Notepad', buttons: ['Yes', 'No', 'Cancel'], text: 'Notepad | Cannot find the novi-box-test.txt file. | Do you want to create a new file? | Yes | No' };
  it('the question, not the window name or a button', () => {
    expect(cardFor(NOTEPAD).title).toBe('Notepad: Do you want to create a new file');
  });
  it('no question mark: the longest real line', () => {
    expect(cardFor({ ...NOTEPAD, text: 'Notepad | The file has been changed outside Notepad | OK' }).title).toBe('Notepad: The file has been changed outside Notepad');
  });
  it('one block with line breaks (a standard message box): the question line', () => {
    expect(cardFor({ ...NOTEPAD, text: 'Cannot find the novi-box-test.txt file.\n\nDo you want to create a new file? | Yes' }).title).toBe('Notepad: Do you want to create a new file');
  });
  it('nothing but names left: the old fallback', () => {
    expect(cardFor({ ...NOTEPAD, text: 'Notepad | Yes' }).title).toBe('Notepad: asks for your OK');
  });
});
