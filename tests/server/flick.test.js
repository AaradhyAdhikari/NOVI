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
import { destination } from '../../plugins/flick/sites.js';

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

function setup({ viewers = 0, asked = 'allow', link = null, shot = 'PNGDATA' } = {}) {
  const root = tmp();
  const ran = [];
  const opened = [];
  const rt = {
    dataDir: tmp(), logger: { info() {}, warn() {} },
    noviPage: 'https://localhost:3001',
    laptopScreenshot: async () => (shot === 'refused' ? { refused: true } : { png: Buffer.from(shot), width: 10, height: 10 }),
    callTool: async (tool, params) => { ran.push({ tool, params }); if (tool === 'laptop_current_link') return link ? { url: link, title: 'A page' } : { error: 'No browser window is open on the laptop.' }; return tool === 'whatsapp_prepare' ? { ready: { name: 'Rahul Sharma' }, note: 'Ready.' } : { text: 'ok' }; },
    runAsked: async (tool, params) => { ran.push({ asked: tool, params }); return asked === 'allow' ? { sent: true, note: 'Sent to Rahul Sharma.' } : { declined: true }; },
  };
  const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
  const pushed = [];
  const stage = { start: async () => 'http://127.0.0.1:1/', stop() {}, push: (i) => pushed.push(i), viewers: () => viewers, items: () => pushed };
  const plugin = createFlickPlugin({ root, stage, openWindow: async (u) => opened.push(u), openCardWindow: async (u) => ran.push({ cardWindow: u }), openFile: async (p) => ran.push({ openFile: p }), closeWindow: async () => {}, linkDelayMs: 0,
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
  it('the card ✕ takes it off the stage (POST remove), and the page hears it gone', async () => {
    const stage = createStage();
    const url = await stage.start();
    try {
      stage.push({ id: 'a1', kind: 'link', name: 'x.com', url: 'https://x.com', host: 'x.com' });
      const res = await fetch(`${url}events`);
      const reader = res.body.getReader();
      await new Promise((r) => setTimeout(r, 50));
      expect((await fetch(`${url}remove/a1`, { method: 'POST', headers: { 'x-novi-stage': '1' } })).status).toBe(204);
      let text = '';
      while (!text.includes('event: gone')) text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toMatch(/"id":"a1"/);
      reader.cancel();
      expect(stage.items()).toHaveLength(0);
    } finally { stage.stop(); }
  });
  it('"send this to my laptop" on the phone asks the phone to flick', async () => {
    const s = setup({ viewers: 1 });
    const asked = [];
    s.host.runtime.phoneAction = async (a) => { asked.push(a); return { ok: true, note: 'It landed on the laptop.' }; };
    const out = await s.host.get('flick_from_phone').run({});
    expect(asked).toEqual([{ do: 'flick' }]);
    expect(out.text).toMatch(/landed/);
  });
  it('"Send to" box: a typed place becomes an AI site or a WhatsApp contact', () => {
    expect(destination('ChatGPT')).toEqual({ action: 'ai', app: 'chatgpt' });
    expect(destination('chat gpt')).toEqual({ action: 'ai', app: 'chatgpt' });
    expect(destination('send to claude')).toEqual({ action: 'ai', app: 'claude' });
    expect(destination('Rahul on WhatsApp')).toEqual({ action: 'whatsapp', to: 'Rahul' });
    expect(destination('Isha')).toEqual({ action: 'whatsapp', to: 'Isha' });
    expect(destination('  ')).toBeNull();
  });
  it('the stage "Send to" box runs through the same actions', async () => {
    const s = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'x');
    await s.handler({ file: t, name: 'beach.jpg', kind: 'file', from: 'local' });
    const out = await s.host.get('flick_do').run({ action: 'to', to: 'gemini' });
    expect(s.ran.filter((r) => r.tool === 'open_website').pop().params.target).toMatch(/gemini/);
    expect(out.text).toMatch(/gemini/i);
  });
  it('a YouTube video flicked from the phone plays on the laptop', async () => {
    const s = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'Lofi beats to study to');
    const out = await s.handler({ file: t, name: 'youtube', kind: 'youtube', from: { deviceId: 'p1' } });
    expect(out.ok).toBe(true);
    expect(s.pushed[0]).toMatchObject({ kind: 'video', name: 'Lofi beats to study to', host: 'youtube.com' });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.ran).toContainEqual({ tool: 'play_youtube', params: { query: 'Lofi beats to study to', on: 'laptop' } });
  });
  // Flick down (pull, user 2026-11-18): the laptop's open page comes to the phone, else a screenshot of it.
  it('a pull brings the laptop page to the phone, else its screen', async () => {
    const a = setup({ link: 'https://example.com/x' });
    const t1 = path.join(tmp(), 'up'); fs.writeFileSync(t1, '');
    expect(await a.handler({ file: t1, name: 'pull', kind: 'pull', from: { deviceId: 'p1' } })).toMatchObject({ ok: true, link: 'https://example.com/x', title: 'A page' });
    const b = setup();
    const t2 = path.join(tmp(), 'up'); fs.writeFileSync(t2, '');
    const out = await b.handler({ file: t2, name: 'pull', kind: 'pull', from: { deviceId: 'p1' } });
    expect(out).toMatchObject({ ok: true, type: 'image/png' });
    expect(Buffer.from(out.image, 'base64').toString()).toBe('PNGDATA');
  });
  // Circle in the air (user 2026-11-18): a screenshot of the laptop screen to the phone; never of a sign-in/payment screen.
  it('a circle brings a screenshot of the laptop, refused on private screens', async () => {
    const a = setup({ link: 'https://example.com/x' });
    const t1 = path.join(tmp(), 'up'); fs.writeFileSync(t1, '');
    const out = await a.handler({ file: t1, name: 'circle', kind: 'circle', from: { deviceId: 'p1' } });
    expect(out).toMatchObject({ ok: true, type: 'image/png' });
    expect(out.link).toBeUndefined();
    const b = setup({ shot: 'refused' });
    const t2 = path.join(tmp(), 'up'); fs.writeFileSync(t2, '');
    expect(await b.handler({ file: t2, name: 'circle', kind: 'circle', from: { deviceId: 'p1' } })).toMatchObject({ ok: false });
  });
  // User 2026-11-19: a card on the phone, flicked, opens the same card on the laptop (not a screenshot).
  it('a flicked card opens that card on the laptop page, a flicked file view opens that file', async () => {
    const s = setup();
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, '');
    const out = await s.handler({ file: t, name: 'a1b2-c3', kind: 'card', link: '', from: { deviceId: 'p1' } });
    expect(out).toMatchObject({ ok: true });
    expect(s.ran.find((r) => r.cardWindow)?.cardWindow).toBe('https://localhost:3001/?cardview=a1b2-c3');
    expect(s.ran.some((r) => r.tool === 'open_website')).toBe(false);
    const t2 = path.join(tmp(), 'up'); fs.writeFileSync(t2, '');
    await s.handler({ file: t2, name: 'chg9', kind: 'card', link: 'src%2FApp+2.jsx', from: { deviceId: 'p1' } });
    expect(s.ran.filter((r) => r.cardWindow)[1].cardWindow).toBe('https://localhost:3001/?cardview=chg9&changes=chg9&file=src%2FApp%202.jsx');
    expect(s.pushed).toHaveLength(0);
    const t3 = path.join(tmp(), 'up'); fs.writeFileSync(t3, '');
    expect(await s.handler({ file: t3, name: '../x?y', kind: 'card', from: { deviceId: 'p1' } })).toMatchObject({ ok: false });
  });
  // User 2026-11-19: "the ss should land on the laptop too".
  it('a circle screenshot also lands on the laptop stage', async () => {
    const s = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, '');
    await s.handler({ file: t, name: 'circle', kind: 'circle', from: { deviceId: 'p1' } });
    expect(s.pushed[0]).toMatchObject({ kind: 'photo', name: expect.stringMatching(/laptop screen.*\.png$/i) });
    expect(fs.readFileSync(s.pushed[0].path, 'utf8')).toBe('PNGDATA');
  });
  // User 2026-11-19: "when i press share to whatsapp it should open whatsapp and then i will press whoever i want".
  it('WhatsApp without a name: copies it and opens WhatsApp, nothing is sent', async () => {
    const s = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'x');
    await s.handler({ file: t, name: 'beach.jpg', kind: 'file', from: 'local' });
    const out = await s.host.get('flick_do').run({ action: 'whatsapp_open' });
    expect(s.ran.find((r) => r.copy)?.copy).toMatchObject({ image: expect.stringMatching(/beach\.jpg$/) });
    expect(s.ran.find((r) => r.tool === 'open_app')?.params).toMatchObject({ name: 'WhatsApp' });
    expect(s.ran.some((r) => r.asked === 'whatsapp_send' || r.tool === 'whatsapp_prepare')).toBe(false);
    expect(out.text).toMatch(/ctrl\+v/i);
  });
  it('a screenshot carries the page or video it shows: a link on the card that opens on the laptop', async () => {
    const s = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'jpgbytes');
    const out = await s.handler({ file: t, name: 'Novi flick.jpg', kind: 'file', type: 'image/jpeg', link: encodeURIComponent('https://www.youtube.com/watch?v=abc'), from: { deviceId: 'p1' } });
    expect(out.ok).toBe(true);
    expect(s.pushed[0]).toMatchObject({ kind: 'photo', link: 'https://www.youtube.com/watch?v=abc' });
    const t2 = path.join(tmp(), 'up2'); fs.writeFileSync(t2, 'jpgbytes');
    await s.handler({ file: t2, name: 'Novi flick.jpg', kind: 'file', type: 'image/jpeg', link: encodeURIComponent('javascript:alert(1)'), from: { deviceId: 'p1' } });
    expect(s.pushed[1].link).toBeUndefined();
  });
  it('selected text from the phone lands as a text card, saved as a .txt, and goes on to an AI or WhatsApp as text', async () => {
    const s = setup({ viewers: 1 });
    const t = path.join(tmp(), 'up'); fs.writeFileSync(t, 'Meeting moved to 5 pm, bring the slides');
    const out = await s.handler({ file: t, name: 'text', kind: 'text', from: { deviceId: 'p1' } });
    expect(out.ok).toBe(true);
    expect(s.pushed[0]).toMatchObject({ kind: 'doc', text: 'Meeting moved to 5 pm, bring the slides' });
    expect(s.pushed[0].path).toMatch(/\.txt$/);
    expect(fs.readFileSync(s.pushed[0].path, 'utf8')).toBe('Meeting moved to 5 pm, bring the slides');
    // It is also on the laptop's clipboard, ready to paste (user, 2026-11-17).
    expect(s.ran.find((r) => r.copy)?.copy).toEqual({ text: 'Meeting moved to 5 pm, bring the slides' });
    await s.host.get('flick_do').run({ action: 'copy' });
    expect(s.ran.filter((r) => r.copy).pop().copy).toEqual({ text: 'Meeting moved to 5 pm, bring the slides' });
    await s.host.get('flick_do').run({ action: 'ai', app: 'chatgpt' });
    expect(s.ran.filter((r) => r.tool === 'open_website').pop().params.target).toBe('https://chatgpt.com/?q=' + encodeURIComponent('Meeting moved to 5 pm, bring the slides'));
    await s.host.get('flick_do').run({ action: 'whatsapp', to: 'Rahul' });
    expect(s.ran.filter((r) => r.tool === 'whatsapp_prepare').pop().params).toEqual({ to: 'Rahul', text: 'Meeting moved to 5 pm, bring the slides' });
    const empty = path.join(tmp(), 'e'); fs.writeFileSync(empty, '   ');
    expect((await s.handler({ file: empty, name: 'text', kind: 'text', from: 'local' })).ok).toBe(false);
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
    expect(flickCommand('copy this link')).toBeNull();
    expect(flickCommand('send this to my laptop')).toEqual({ tool: 'flick_from_phone', args: {} });
    expect(flickCommand('Novi, send this photo to the laptop.')).toEqual({ tool: 'flick_from_phone', args: {} });
    expect(flickCommand('ye laptop pe bhejo')).toEqual({ tool: 'flick_from_phone', args: {} });
    expect(flickCommand('send this to Rahul')).toBeNull(); // the page's link (browser plugin), not a flick
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
