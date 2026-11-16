import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { receiveUpload, uploadAllowed } from '../../server/uploads.js';
import { PluginHost } from '../../server/plugins/host.js';
import { saveFlick, kindOf, linkItem, safeName, withEnding, autoOpens } from '../../plugins/flick/store.js';
import { createStage } from '../../plugins/flick/stage.js';
import { createFlickPlugin } from '../../plugins/flick/index.js';
import { flickCommand } from '../../server/brain/flickCommand.js';

// Novi Flick (2026-11-16, spec docs/superpowers/specs/2026-11-16-novi-flick-design.md): flick a photo, file,
// link or video from the phone and it lands on the laptop's stage.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-flick-'));

describe('receiving an upload', () => {
  it('writes the body to a temp file and says its size', async () => {
    const dir = tmp();
    const out = await receiveUpload(Readable.from([Buffer.from('hello '), Buffer.from('world')]), { dir, maxBytes: 100 });
    expect(out.size).toBe(11);
    expect(fs.readFileSync(out.file, 'utf8')).toBe('hello world');
  });
  it('too big: refused and nothing left behind', async () => {
    const dir = tmp();
    await expect(receiveUpload(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), { dir, maxBytes: 100 })).rejects.toThrow(/too big/i);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('phones only reach routes that say so; the laptop reaches every upload route', () => {
    expect(uploadAllowed({ upload: true, phone: true }, false)).toBe(true);
    expect(uploadAllowed({ upload: true }, false)).toBe(false);
    expect(uploadAllowed({ upload: true }, true)).toBe(true);
    expect(uploadAllowed({ handler() {} }, true)).toBe(false); // a plain JSON route is not an upload route
    expect(uploadAllowed(undefined, true)).toBe(false);
  });
  it('the host keeps the upload + phone flags', () => {
    const host = new PluginHost({ runtime: {}, env: {}, logger: { warn() {}, info() {} } });
    host.register({ id: 'x', name: 'X', description: 'x', register(api) { api.registerHttpRoute({ path: 'up', handler: () => ({}), upload: true, phone: true }); } });
    expect(host.routeInfo('up')).toMatchObject({ upload: true, phone: true });
    expect(typeof host.route('up')).toBe('function');
  });
});

describe('saving what lands', () => {
  it('safe names: no folders, no Windows-forbidden characters, never empty', () => {
    expect(safeName('..\\..\\evil<>.txt')).toBe('evil.txt');
    expect(safeName('a/b/c.png')).toBe('c.png');
    expect(safeName('CON')).toBe('CON_');
    expect(safeName('')).toBe('file');
    expect(safeName('photo‮gpj.exe')).toBe('photogpj.exe'); // a hidden direction flip can't fake an extension
  });
  it('kinds by name and type', () => {
    expect(kindOf('IMG_1.JPG')).toBe('photo');
    expect(kindOf('clip.mp4')).toBe('video');
    expect(kindOf('resume.pdf')).toBe('doc');
    expect(kindOf('setup.exe')).toBe('program');
    expect(kindOf('notes.xyz')).toBe('file');
    // The phone's type never makes a file a photo or video (security review): only the name's own ending counts.
    expect(kindOf('invoice.docm', 'image/png')).toBe('file');
    expect(kindOf('x.url', 'video/mp4')).toBe('file');
    expect(kindOf('pic.svg', 'image/svg+xml')).toBe('file');
  });
  it('into Novi Flick/<date>, never overwriting', () => {
    const root = tmp();
    const a = path.join(root, 'a'); fs.writeFileSync(a, '1');
    const b = path.join(root, 'b'); fs.writeFileSync(b, '2');
    const now = new Date('2026-11-16T10:00:00');
    const one = saveFlick({ tmp: a, name: 'photo.jpg', root, now });
    const two = saveFlick({ tmp: b, name: 'photo.jpg', root, now });
    expect(one).toBe(path.join(root, '2026-11-16', 'photo.jpg'));
    expect(two).toBe(path.join(root, '2026-11-16', 'photo (2).jpg'));
    expect(fs.readFileSync(two, 'utf8')).toBe('2');
  });
  it('a name with no ending gets one from a picture type, so the saved file opens as a picture', () => {
    expect(withEnding('IMG_1', 'image/jpeg')).toBe('IMG_1.jpg');
    expect(withEnding('clip', 'video/mp4')).toBe('clip.mp4');
    expect(withEnding('a.pdf', 'image/png')).toBe('a.pdf');
    expect(withEnding('thing', 'application/x-msdownload')).toBe('thing');
  });
  it('links that may log someone in are not opened by themselves', () => {
    expect(autoOpens('https://youtu.be/abc?t=30')).toBe(true);
    expect(autoOpens('https://example.com/reset-password?token=abc')).toBe(false);
    expect(autoOpens('https://x.com/auth/magic?code=1234')).toBe(false);
    expect(autoOpens('https://a.com/?q=' + 'x'.repeat(120))).toBe(false);
  });
  it('links: http(s) only; YouTube keeps its time', () => {
    expect(linkItem('javascript:alert(1)')).toBeNull();
    expect(linkItem('file:///C:/x')).toBeNull();
    expect(linkItem('https://chatgpt.com/c/123')).toMatchObject({ kind: 'link', host: 'chatgpt.com' });
    const yt = linkItem('https://youtu.be/abc123?t=95');
    expect(yt).toMatchObject({ kind: 'video', host: 'youtu.be' });
    expect(yt.url).toMatch(/t=95/);
    expect(linkItem('  see https://example.com/page now ')).toMatchObject({ url: 'https://example.com/page' });
  });
});

describe('the stage server', () => {
  it('sends every item to the open stage, and shows only received pictures', async () => {
    const root = tmp();
    const pic = path.join(root, 'p.png'); fs.writeFileSync(pic, 'PNG');
    const stage = createStage();
    const url = await stage.start();
    try {
      const res = await fetch(`${url}events`);
      const reader = res.body.getReader();
      await new Promise((r) => setTimeout(r, 50));
      expect(stage.viewers()).toBe(1);
      stage.push({ id: 'f1', kind: 'photo', name: 'p.png', path: pic });
      let text = '';
      while (!text.includes('f1')) text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toMatch(/"name":"p.png"/);
      expect(text).not.toMatch(/p\.png","path/); // the laptop path never reaches the page
      reader.cancel();
      expect((await fetch(`${url}file/f1`)).status).toBe(200);
      expect((await fetch(`${url}file/nope`)).status).toBe(404);
      expect((await fetch(`${url}file/..%2F..%2Fx`)).status).toBe(404);
      expect((await fetch(url)).headers.get('content-type')).toMatch(/html/);
      const origin = new URL(url).origin;
      expect((await fetch(`${origin}/events`)).status).toBe(404); // without the secret path: nothing (security review)
      expect((await fetch(`${origin}/file/f1`)).status).toBe(404);
    } finally { stage.stop(); }
  });
});

function setup({ viewers = 0, asked = 'allow' } = {}) {
  const root = tmp();
  const ran = [];
  const opened = [];
  const rt = {
    dataDir: tmp(), logger: { info() {}, warn() {} },
    callTool: async (tool, params) => { ran.push({ tool, params }); return tool === 'whatsapp_prepare' ? { ready: { name: 'Rahul Sharma' }, note: 'Ready.' } : { text: 'ok' }; },
    runAsked: async (tool, params) => { ran.push({ asked: tool, params }); return asked === 'allow' ? { sent: true, note: 'Sent to Rahul Sharma.' } : { declined: true }; },
  };
  const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
  const pushed = [];
  const stage = { start: async () => 'http://127.0.0.1:1/', stop() {}, push: (i) => pushed.push(i), viewers: () => viewers, items: () => pushed };
  const plugin = createFlickPlugin({ root, stage, openWindow: async (u) => opened.push(u), openFile: async (p) => ran.push({ openFile: p }), closeWindow: async () => {}, linkDelayMs: 0,
    copy: async (what) => { ran.push({ copy: what }); return true; }, showInFolder: async (p) => ran.push({ folder: p }) });
  host.register(plugin);
  return { host, root, ran, opened, pushed, handler: host.route('flick') };
}

describe('the flick plugin', () => {
  it('a file from the phone is saved, lands on the stage, and opens the stage if none is showing', async () => {
    const { handler, pushed, opened, root } = setup();
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'JPEGDATA');
    const out = await handler({ file: t, name: 'beach.jpg', kind: 'file', from: { deviceId: 'p1' } });
    expect(out.ok).toBe(true);
    expect(pushed[0]).toMatchObject({ kind: 'photo', name: 'beach.jpg' });
    expect(fs.existsSync(pushed[0].path)).toBe(true);
    expect(pushed[0].path.startsWith(root)).toBe(true);
    expect(opened).toHaveLength(1);
  });
  it('a stage already showing is not opened twice', async () => {
    const { handler, opened } = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'x');
    await handler({ file: t, name: 'a.pdf', kind: 'file', from: 'local' });
    expect(opened).toHaveLength(0);
  });
  it('a link lands and then opens on the laptop by itself', async () => {
    const { handler, pushed, ran } = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'https://youtu.be/abc?t=30');
    await handler({ file: t, name: 'link', kind: 'link', from: { deviceId: 'p1' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(pushed[0]).toMatchObject({ kind: 'video' });
    expect(ran).toContainEqual({ tool: 'open_website', params: { target: 'https://youtu.be/abc?t=30', on: 'laptop' } });
  });
  it('a bad link is refused, nothing lands', async () => {
    const { handler, pushed } = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'javascript:alert(1)');
    const out = await handler({ file: t, name: 'link', kind: 'link', from: 'local' });
    expect(out.ok).toBe(false);
    expect(pushed).toHaveLength(0);
  });
  it('"open the last flick" opens the newest in its app, but never runs a program', async () => {
    const { host, handler, ran } = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'MZ');
    await handler({ file: t, name: 'setup.exe', kind: 'file', from: 'local' });
    const out = await host.get('flick_open').run({});
    expect(out.text).toMatch(/won't open that kind/i);
    expect(ran.some((r) => r.openFile)).toBe(false);
    const t2 = path.join(tmp(), 'up2'); fs.writeFileSync(t2, 'PDF');
    await handler({ file: t2, name: 'cv.pdf', kind: 'file', from: 'local' });
    await host.get('flick_open').run({});
    expect(ran.some((r) => r.openFile?.endsWith('cv.pdf'))).toBe(true);
  });
  it('only photos, videos and plain documents open; a macro document stays saved', async () => {
    const { host, handler, ran } = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'x');
    await handler({ file: t, name: 'invoice.docm', kind: 'file', from: 'local' });
    const out = await host.get('flick_open').run({});
    expect(out.text).toMatch(/won't open that kind/i);
    expect(ran.some((r) => r.openFile)).toBe(false);
  });
  it('flick_stage opens and closes the stage', async () => {
    const { host, opened } = setup();
    await host.get('flick_stage').run({ do: 'open' });
    expect(opened).toHaveLength(1);
    const out = await host.get('flick_stage').run({ do: 'close' });
    expect(out.text).toMatch(/closed/i);
  });
});

describe('card actions (v2)', () => {
  const land = async (s, name, body = 'x', kind = 'file') => { const t = path.join(tmp(), 'up'); fs.writeFileSync(t, body); return s.handler({ file: t, name, kind, from: 'local' }); };
  it('copy: the picture itself for a photo, the link for a link, the file for other files', async () => {
    const s = setup({ viewers: 1 });
    await land(s, 'beach.jpg');
    const out = await s.host.get('flick_do').run({ action: 'copy' });
    expect(s.ran.find((r) => r.copy)?.copy).toMatchObject({ image: expect.stringMatching(/beach\.jpg$/) });
    expect(out.text).toMatch(/copied the picture/i);
    await land(s, 'link', 'https://example.com/a', 'link');
    await s.host.get('flick_do').run({ action: 'copy' });
    expect(s.ran.filter((r) => r.copy).pop().copy).toEqual({ text: 'https://example.com/a' });
    await land(s, 'cv.pdf');
    await s.host.get('flick_do').run({ action: 'copy' });
    expect(s.ran.filter((r) => r.copy).pop().copy).toMatchObject({ file: expect.stringMatching(/cv\.pdf$/) });
  });
  it('show in folder; a link has no folder', async () => {
    const s = setup({ viewers: 1 });
    await land(s, 'beach.jpg');
    await s.host.get('flick_do').run({ action: 'folder' });
    expect(s.ran.some((r) => r.folder?.endsWith('beach.jpg'))).toBe(true);
    await land(s, 'link', 'https://example.com/a', 'link');
    const out = await s.host.get('flick_do').run({ action: 'folder' });
    expect(out.text).toMatch(/link/i);
  });
  it('open in the browser: links only', async () => {
    const s = setup({ viewers: 1 });
    await land(s, 'link', 'https://example.com/a', 'link');
    await s.host.get('flick_do').run({ action: 'browser' });
    expect(s.ran.filter((r) => r.tool === 'open_website').pop().params).toEqual({ target: 'https://example.com/a', on: 'laptop' });
  });
  it('send to an AI: a link goes in the question, a picture is copied and the site opens', async () => {
    const s = setup({ viewers: 1 });
    await land(s, 'link', 'https://example.com/a', 'link');
    await s.host.get('flick_do').run({ action: 'ai', app: 'chatgpt' });
    expect(s.ran.filter((r) => r.tool === 'open_website').pop().params.target).toBe('https://chatgpt.com/?q=' + encodeURIComponent('https://example.com/a'));
    await land(s, 'beach.jpg');
    const out = await s.host.get('flick_do').run({ action: 'ai', app: 'gemini' });
    expect(s.ran.filter((r) => r.copy).pop().copy).toHaveProperty('image');
    expect(s.ran.filter((r) => r.tool === 'open_website').pop().params.target).toMatch(/^https:\/\/gemini\.google\.com/);
    expect(out.text).toMatch(/ctrl\+v/i);
    expect((await s.host.get('flick_do').run({ action: 'ai', app: 'evilsite' })).text).toMatch(/chatgpt/i); // only the known sites
  });
  it('WhatsApp: prepared with the saved file, then sent through the normal yes', async () => {
    const s = setup({ viewers: 1 });
    await land(s, 'beach.jpg');
    const out = await s.host.get('flick_do').run({ action: 'whatsapp', to: 'Rahul' });
    const prep = s.ran.find((r) => r.tool === 'whatsapp_prepare');
    expect(prep.params).toMatchObject({ to: 'Rahul', path: expect.stringMatching(/beach\.jpg$/) });
    expect(s.ran.some((r) => r.asked === 'whatsapp_send')).toBe(true);
    expect(out.text).toMatch(/sent/i);
    expect((await s.host.get('flick_do').run({ action: 'whatsapp' })).text).toMatch(/who/i);
    await land(s, 'link', 'https://example.com/a', 'link');
    await s.host.get('flick_do').run({ action: 'whatsapp', to: 'Rahul' });
    expect(s.ran.filter((r) => r.tool === 'whatsapp_prepare').pop().params).toEqual({ to: 'Rahul', text: 'https://example.com/a' });
  });
  it('programs are never opened or sent anywhere', async () => {
    const s = setup({ viewers: 1 });
    await land(s, 'setup.exe', 'MZ');
    for (const action of ['open', 'whatsapp', 'ai', 'copy']) {
      const out = await s.host.get('flick_do').run({ action, to: 'Rahul', app: 'chatgpt' });
      expect(out.text).toMatch(/won't/i);
    }
    expect(s.ran.some((r) => r.openFile || r.copy || r.tool === 'whatsapp_prepare' || r.tool === 'open_website')).toBe(false);
  });
  it('"send it to …" only counts while a flick is recent', async () => {
    const s = setup({ viewers: 1 });
    const out = await s.host.get('flick_do').run({ action: 'whatsapp', to: 'Rahul', recent: true });
    expect(out.unknown).toBe(true);
  });
  it('the stage page reaches the actions through its own POST', async () => {
    const stage = createStage();
    const url = await stage.start();
    const got = [];
    stage.handle.action = async (id, body) => { got.push({ id, body }); return { note: 'Copied.' }; };
    try {
      const res = await fetch(`${url}action/abc`, { method: 'POST', headers: { 'x-novi-stage': '1', 'content-type': 'application/json' }, body: JSON.stringify({ do: 'copy' }) });
      expect(await res.json()).toEqual({ note: 'Copied.' });
      expect(got).toEqual([{ id: 'abc', body: { do: 'copy' } }]);
      expect((await fetch(`${url}action/abc`, { method: 'POST', body: '{}' })).status).toBe(404); // no stage header
    } finally { stage.stop(); }
  });
});

describe('flick by voice', () => {
  it('v2: copy / send to an AI / WhatsApp', () => {
    expect(flickCommand('copy the last flick')).toEqual({ tool: 'flick_do', args: { action: 'copy' } });
    expect(flickCommand('send the last flick to ChatGPT')).toEqual({ tool: 'flick_do', args: { action: 'ai', app: 'chatgpt' } });
    expect(flickCommand('send the flicked photo to google')).toEqual({ tool: 'flick_do', args: { action: 'ai', app: 'google' } });
    expect(flickCommand('send it to Rahul on WhatsApp')).toEqual({ tool: 'flick_do', args: { action: 'whatsapp', to: 'Rahul', recent: true } });
    expect(flickCommand('send the last flick to Rahul')).toEqual({ tool: 'flick_do', args: { action: 'whatsapp', to: 'Rahul' } });
    expect(flickCommand('send it to gemini')).toEqual({ tool: 'flick_do', args: { action: 'ai', app: 'gemini', recent: true } });
    expect(flickCommand('show the last flick in the folder')).toEqual({ tool: 'flick_do', args: { action: 'folder' } });
    expect(flickCommand('copy this link')).toBeNull(); // the page's link (browser plugin), not a flick
  });

  it('stage open / close and opening the last flick', () => {
    expect(flickCommand('open the stage')).toEqual({ tool: 'flick_stage', args: { do: 'open' } });
    expect(flickCommand('flick mode')).toEqual({ tool: 'flick_stage', args: { do: 'open' } });
    expect(flickCommand('Close the stage.')).toEqual({ tool: 'flick_stage', args: { do: 'close' } });
    expect(flickCommand('open the last flick')).toEqual({ tool: 'flick_open', args: {} });
    expect(flickCommand('open what I flicked')).toEqual({ tool: 'flick_open', args: {} });
    expect(flickCommand('open the stage door app')).toBeNull();
    expect(flickCommand('open chrome')).toBeNull();
  });
});
