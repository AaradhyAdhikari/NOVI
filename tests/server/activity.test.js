import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivity, describeTurn } from '../../server/activity.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-act-')), 'activity', 'recent.json');

describe('activity log ("what happened")', () => {
  it('records what was heard, the route, each tool and the reply; newest first', () => {
    let t = 1000;
    const a = createActivity({ file: tmp(), now: () => t });
    const r1 = a.begin('message Isha that hi', 'local');
    t += 50;
    a.tool(r1, { name: 'whatsapp_prepare', ok: false, error: 'I searched the WhatsApp app for "isha" and nobody called Isha came up.', ms: 40 });
    t += 10;
    a.end(r1, 'I searched the WhatsApp app for "isha" and nobody called Isha came up.');
    const r2 = a.begin('tell me a joke', { deviceId: 'p1' });
    a.ai(r2, 'groq');
    a.end(r2, 'Why did the …');
    const [latest, first] = a.list();
    expect(latest).toMatchObject({ heard: 'tell me a joke', from: 'phone', route: 'AI (groq)', tools: [] });
    expect(first).toMatchObject({ heard: 'message Isha that hi', from: 'laptop', route: 'direct', ms: 60, tools: [{ name: 'whatsapp_prepare', ok: false, ms: 40 }] });
    expect(first.reply).toContain('nobody called Isha');
  });

  it('a request that crashed is kept with its error; long texts are cut', () => {
    const a = createActivity({ file: tmp() });
    const r = a.begin('x'.repeat(600), 'local');
    a.fail(r, new Error('boom'));
    expect(a.list()[0]).toMatchObject({ route: 'failed', error: 'boom' });
    expect(a.list()[0].heard.length).toBeLessThanOrEqual(300);
  });

  it('keeps the last 200 and survives a restart', () => {
    const file = tmp();
    const a = createActivity({ file });
    for (let i = 0; i < 205; i += 1) a.end(a.begin(`n${i}`, 'local'), 'ok');
    a.flush();
    const b = createActivity({ file });
    expect(b.list(500)).toHaveLength(200);
    expect(b.list()[0].heard).toBe('n204');
  });

  it('says in words what happened last time', () => {
    const a = createActivity({ file: tmp() });
    const r = a.begin('message Isha that hi', 'local');
    a.tool(r, { name: 'whatsapp_prepare', ok: false, error: 'I searched the WhatsApp app for "isha" and nobody called Isha came up.', ms: 5 });
    a.end(r, 'x');
    expect(describeTurn(a.list()[0])).toBe('Last time I heard "message Isha that hi". whatsapp_prepare failed: I searched the WhatsApp app for "isha" and nobody called Isha came up.');
    const ok = a.begin('volume 30', 'local');
    a.tool(ok, { name: 'laptop_volume', ok: true, ms: 5 });
    a.end(ok, 'Volume 30.');
    expect(describeTurn(a.list()[0])).toBe('Last time I heard "volume 30". I ran laptop_volume and it worked. I said: Volume 30.');
    expect(describeTurn(null)).toBe("I haven't done anything yet since I started.");
  });
});
