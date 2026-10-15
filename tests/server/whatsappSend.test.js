import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createBrowserPlugin } from '../../plugins/browser/index.js';

function driver(result = { ok: true, name: 'Rahul Sharma' }, sent = true) {
  const d = { prepared: [], sent: 0, cancelled: 0 };
  d.prepare = async (a) => { d.prepared.push(a); return result; };
  d.send = async () => { d.sent += 1; return { sent }; };
  d.cancel = async () => { d.cancelled += 1; };
  d.shot = async () => Buffer.from('png').toString('base64');
  return d;
}
function setup({ web = driver(), app = driver(), appOpen = false, connected = true, now = () => 1_000_000 } = {}) {
  const shown = [];
  const bridge = { connected: () => connected, request: async (cmd) => (cmd === 'screenshot' ? { png: Buffer.from('p').toString('base64') } : {}) };
  const host = new PluginHost({ runtime: {}, logger: { warn() {} } });
  host.register(createBrowserPlugin({ bridge, showImage: (i) => shown.push(i), webDriver: web, appDriver: app, appOpen: async () => appOpen, now }));
  return { host, web, app, shown, prep: host.get('whatsapp_prepare'), send: host.get('whatsapp_send') };
}
const folder = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-ws-'));
  const f = path.join(dir, 'DBMS notes');
  fs.mkdirSync(f);
  fs.writeFileSync(path.join(f, 'a.txt'), 'x'.repeat(3 * 1024 * 1024));
  return f;
};

describe('WhatsApp: prepare, then send with the question', () => {
  it('a folder is zipped; the question names the checked chat and the size; never "always allow"', async () => {
    const { prep, send, web } = setup();
    const out = await prep.run({ to: 'rahul', path: folder() });
    expect(out.ready).toMatchObject({ name: 'Rahul Sharma', via: 'web' });
    expect(out.ready.what).toMatch(/^DBMS notes\.zip \(\d+(\.\d)? (MB|KB)\)$/);
    expect(web.prepared[0].file.name).toBe('DBMS notes.zip');
    const gate = await send.gate({});
    expect(gate.approval.title).toBe(`Send ${out.ready.what} to Rahul Sharma?`);
    expect(gate.approval).toMatchObject({ tier: 'medium', grantable: false });
    expect((await send.run({})).note).toBe('Sent.');
    expect(web.sent).toBe(1);
  });

  it('the app is used when its window is open (or asked for), and the question says so', async () => {
    const open = setup({ appOpen: true });
    await open.prep.run({ to: 'Mom', text: "I'll be late" });
    expect(open.app.prepared[0]).toMatchObject({ to: 'Mom', text: "I'll be late" });
    expect((await open.send.gate({})).approval.title).toBe('Send "I\'ll be late" to Rahul Sharma on WhatsApp app?');
    const asked = setup({ appOpen: false });
    await asked.prep.run({ to: 'Mom', text: 'hi', via: 'app' });
    expect(asked.app.prepared).toHaveLength(1);
    expect(asked.web.prepared).toHaveLength(0);
  });

  it('two people → asks which one; nothing can be sent', async () => {
    const { prep, send } = setup({ web: driver({ choose: ['Rahul Sharma', 'Rahul K'] }) });
    expect((await prep.run({ to: 'Rahul', text: 'hi' })).note).toBe('Which Rahul: Rahul Sharma or Rahul K?');
    expect(await send.gate({})).toEqual({ block: true, blockReason: 'Nothing is ready to send.' });
  });

  it('wrong chat / errors stop before any question', async () => {
    const { prep, send } = setup({ web: driver({ error: 'I opened Rahul K instead of Rahul Sharma, so I stopped.' }) });
    expect((await prep.run({ to: 'Rahul Sharma', text: 'hi' })).error).toBe('I opened Rahul K instead of Rahul Sharma, so I stopped.');
    expect((await send.gate({})).block).toBe(true);
  });

  it('a "no" cancels the draft; an old prepared send expires after 5 minutes', async () => {
    let t = 1_000_000;
    const s = setup({ now: () => t });
    await s.prep.run({ to: 'Rahul', text: 'hi' });
    await s.host.afterToolCall({ toolName: 'whatsapp_send', params: {}, result: { error: 'The user declined this action.' }, error: 'The user declined this action.' });
    expect(s.web.cancelled).toBe(1);
    expect((await s.send.gate({})).block).toBe(true);
    await s.prep.run({ to: 'Rahul', text: 'hi' });
    t += 5 * 60_000 + 1;
    expect((await s.send.gate({})).block).toBe(true);
  });

  it('not confirmed after sending says so; a phone gets a screenshot before the question', async () => {
    const s = setup({ web: driver(undefined, false) });
    await s.prep.run({ to: 'Rahul', text: 'hi' });
    await s.send.gate({}, { from: { deviceId: 'p1' } });
    expect(s.shown).toHaveLength(1);
    expect((await s.send.run({})).note).toBe("WhatsApp didn't confirm it was sent — please check.");
  });
});
