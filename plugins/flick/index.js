// Novi Flick (2026-11-16, spec docs/superpowers/specs/2026-11-16-novi-flick-design.md): flick a photo, file,
// link or video from the phone and it lands on the laptop's full-screen stage. Files are saved to
// Downloads\Novi Flick\<date>; links and videos open in the laptop's browser right after they land.
// v2: actions on each card (open, browser, copy, folder, WhatsApp, an AI site) and by voice (flick_do).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';
import { saveFlick, kindOf, linkItem, defaultRoot, withEnding, autoOpens } from './store.js';
import { createStage } from './stage.js';
import { defaultCopy, defaultShowInFolder } from './clipboard.js';
import { AI_SITES, aiTarget, destination } from './sites.js';

const EDGE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const PROFILE = 'novi-flick-edge';
const IDLE_MS = 5 * 60_000;
const RECENT_MS = 10 * 60_000; // "send it to …" means the flick only this soon after it landed
const SAFE = ['photo', 'video', 'doc']; // the only kinds that open or go to another app (an allowlist, security review)
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function defaultOpenWindow(dataDir) {
  return async (url) => {
    const profile = path.join(dataDir, PROFILE);
    const child = spawn(EDGE, [`--app=${url}`, '--start-fullscreen', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msImplicitSignin,Translate', '--enable-gpu-rasterization'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  };
}
// Ends only the stage's own Edge (found by its profile folder, never the user's Edge), with its whole tree.
function defaultCloseWindow() {
  return () => new Promise((resolve) => {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }, () => resolve());
  });
}
// The card window (user, 2026-11-19): its own Edge app window with its own profile, trusting only Novi's own
// certificate key (the localhost certificate is self-signed), never all certificates.
const CARD_PROFILE = 'novi-card-edge';
export function spkiHash(certPem) {
  try { return crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'); }
  catch { return null; }
}
function defaultOpenCardWindow(dataDir, certPem) {
  return async (url) => {
    const hash = certPem ? spkiHash(String(certPem)) : null;
    const args = [`--app=${url}`, '--start-maximized', `--user-data-dir=${path.join(dataDir, CARD_PROFILE)}`, '--no-first-run', '--no-default-browser-check', '--test-type', '--disable-features=msImplicitSignin,Translate'];
    if (hash) args.push(`--ignore-certificate-errors-spki-list=${hash}`);
    const child = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  };
}
const defaultOpenFile = async (file) => { const c = spawn('explorer.exe', [file], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); };

// root / stage / openWindow / closeWindow / openFile / copy / showInFolder / linkDelayMs / focusDelayMs: for tests.
export function createFlickPlugin({ root = null, stage = null, openWindow = null, openCardWindow = null, closeWindow = null, openFile = defaultOpenFile, copy = defaultCopy, showInFolder = defaultShowInFolder, linkDelayMs = 1600, focusDelayMs = 2500 } = {}) {
  return definePluginEntry({
    id: 'flick',
    name: 'Flick',
    description: 'Flick photos, files, links and videos from the phone onto the laptop stage.',
    register(api) {
      const rt = api.runtime || {};
      const log = (m) => api.logger?.info?.(`[flick] ${m}`);
      const dataDir = rt.dataDir || path.join(process.cwd(), 'data');
      const saveRoot = root || defaultRoot();
      const st = stage || createStage();
      const open = openWindow || defaultOpenWindow(dataDir);
      const close = closeWindow || defaultCloseWindow();
      let idle = null;
      let opening = 0;

      const showStage = async () => {
        const url = await st.start();
        // A stage that is showing (or was just asked to open) is never opened twice.
        if (st.viewers() > 0 || Date.now() - opening < 8000) return url;
        opening = Date.now();
        await open(url);
        // A window started from the background may not get the keyboard (Esc wouldn't reach it): bring it forward.
        if (focusDelayMs) setTimeout(() => { Promise.resolve(rt.callTool?.('laptop_window', { app: 'Novi Stage', do: 'focus' })).catch(() => {}); }, focusDelayMs).unref?.();
        return url;
      };
      const hideStage = async () => { clearTimeout(idle); idle = null; opening = 0; st.bye?.(); await close(); };
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => { hideStage().catch(() => {}); }, IDLE_MS); idle.unref?.(); };

      const refuse = (item) => `I saved ${item.name} in Novi Flick, but I won't open that kind of file from the phone, or pass it on. Open it yourself if you trust it.`;

      const openItem = async (item) => {
        if (!item) return 'Nothing has been flicked yet.';
        if (item.url) { await rt.callTool?.('open_website', { target: item.url, on: 'laptop' }); return `Opened ${item.host}.`; }
        if (!SAFE.includes(item.kind)) return refuse(item);
        await openFile(item.path);
        return `Opened ${item.name}.`;
      };

      // One action on one flicked thing: open, browser, copy, folder, whatsapp (to), ai (app).
      const act = async (item, { action, to, app, handoff = false } = {}) => {
        if (!item) return { note: 'Nothing has been flicked yet.' };
        const file = !item.url;
        if (action === 'open') return { note: await openItem(item) };
        // The "Send to" box: where the user typed (an AI site, or a WhatsApp contact).
        if (action === 'to') {
          const d = destination(to);
          if (!d) return { note: 'Where should it go? ChatGPT, Claude, Gemini, Perplexity, Google, or a name for WhatsApp.' };
          return act(item, { action: d.action, to: d.to, app: d.app, handoff });
        }
        if (action === 'link' && item.link) {
          await rt.callTool?.('open_website', { target: item.link, on: 'laptop' });
          return { note: 'Opened it on the laptop.' };
        }
        if (action === 'browser') {
          if (file) return { note: `${item.name} is a file, not a link. Say "open the last flick" to open it in its app.` };
          await rt.callTool?.('open_website', { target: item.url, on: 'laptop' });
          return { note: `Opened ${item.host} in the browser.` };
        }
        if (action === 'folder') {
          if (!file) return { note: 'That one is a link, so it has no folder.' };
          await showInFolder(item.path);
          return { note: `Here is ${item.name} in Novi Flick.` };
        }
        if (action === 'copy') {
          if (file && !SAFE.includes(item.kind)) return { note: refuse(item) };
          // A picture goes on the clipboard as the picture; any other file only as a file (pasting never runs it).
          const what = item.text ? { text: item.text } : !file ? { text: item.url } : item.kind === 'photo' ? { image: item.path } : { file: item.path };
          if (!(await copy(what))) return { note: "I couldn't copy it. Try again in a moment." };
          return { note: item.text ? 'Copied the text.' : !file ? 'Copied the link.' : item.kind === 'photo' ? 'Copied the picture. Press Ctrl+V to paste it.' : `Copied ${item.name}. Press Ctrl+V to paste it.` };
        }
        // WhatsApp without a name (user, 2026-11-19: "it should open whatsapp and then i will press whoever i want"):
        // the thing goes on the clipboard, WhatsApp opens, the user picks the chat and pastes. Nothing is sent by Novi.
        if (action === 'whatsapp_open') {
          if (file && !SAFE.includes(item.kind)) return { note: refuse(item) };
          const what = item.text ? { text: item.text } : !file ? { text: item.url } : item.kind === 'photo' ? { image: item.path } : { file: item.path };
          if (!(await copy(what))) return { note: "I couldn't copy it. Try again in a moment." };
          const opened = await rt.callTool?.('open_app', { name: 'WhatsApp' });
          if (opened?.notFound) await rt.callTool?.('open_website', { target: 'https://web.whatsapp.com', on: 'laptop' });
          return { note: 'WhatsApp is open. Pick the chat and press Ctrl+V, then Enter.' };
        }
        if (action === 'whatsapp') {
          if (file && !SAFE.includes(item.kind)) return { note: refuse(item) };
          const name = String(to || '').trim().slice(0, 60);
          if (!name) return { note: 'Who should I send it to on WhatsApp?' };
          // By voice: only what to send goes back; the agent sends it like any spoken WhatsApp command.
          // Selected text goes as the words themselves, a link as the link, anything else as the file.
          const what = item.text ? { to: name, text: item.text } : file ? { to: name, path: item.path } : { to: name, text: item.url };
          if (handoff) return { note: `Sending to ${name}…`, send: what };
          const prep = await rt.callTool('whatsapp_prepare', what);
          const ready = prep?.ready; // callTool / runAsked give the tool's details flat (host mapResult)
          if (!ready) return { note: prep?.error || prep?.note || prep?.text || `I couldn't get WhatsApp ready for ${name}.` };
          // No asking (user, 2026-11-16): a tap and a name on the stage is the go-ahead, like a spoken WhatsApp command.
          const sent = await rt.runAsked?.('whatsapp_send', {}, { direct: true }); // the user's tap + name on the stage is the yes
          if (!sent || sent.declined) return { note: 'Okay, not sent.' };
          return { note: sent.error || sent.note || `Sent to ${ready.name}.` };
        }
        if (action === 'ai') {
          if (file && !SAFE.includes(item.kind)) return { note: refuse(item) };
          const site = AI_SITES[String(app || '').toLowerCase()];
          if (!site) return { note: `I can send it to ${Object.values(AI_SITES).map((x) => x.name).join(', ')}.` };
          const t = aiTarget(site, item);
          if (t.copy && !(await copy(t.copy))) return { note: "I couldn't copy it for the site. Try again in a moment." };
          await rt.callTool?.('open_website', { target: t.url, on: 'laptop' });
          return { note: t.copy ? `Opened ${site.name}. Press Ctrl+V there to add ${item.text ? 'the text' : !file ? 'the link' : item.kind === 'photo' ? 'the picture' : item.name}.` : `Opened ${site.name} with the link in the question.` };
        }
        return { note: 'I can open it, copy it, show it in its folder, or send it to WhatsApp or an AI.' };
      };

      st.handle = {
        open: (id) => { openItem(st.items().find((i) => i.id === id)).catch(() => {}); },
        close: () => { hideStage().catch(() => {}); },
        action: async (id, body = {}) => {
          touch();
          try { return await act(st.items().find((i) => i.id === id), { action: body.do, to: body.to, app: body.app }); }
          catch (e) { return { note: `That didn't work: ${String(e?.message || e).slice(0, 120)}` }; }
        },
      };

      api.registerHttpRoute({
        path: 'flick', upload: true, phone: true,
        handler: async ({ file, name, kind, type, link: shotLink }) => {
          const id = crypto.randomBytes(6).toString('hex');
          let item;
          let playTitle = null;
          // A card on the phone, flicked (user, 2026-11-19): the same card opens on the laptop's Novi page, with its
          // changes, whole code and Edit, instead of a screenshot. A file view open on the phone opens that file.
          if (kind === 'card') {
            // "<card>~<changes>": a file inside a commit card (its changes list has its own id).
            const [cardId, changesId = cardId] = String(name || '').trim().split('~');
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(cardId) || !/^[A-Za-z0-9_-]{1,80}$/.test(changesId) || !rt.noviPage) return { ok: false, error: 'That card can\'t be opened on the laptop.' };
            let fileName = '';
            try { fileName = shotLink ? decodeURIComponent(String(shotLink).replace(/\+/g, ' ')).slice(0, 300) : ''; } catch { fileName = ''; }
            // Its own window with only that card (user, 2026-11-19: "i dont want it to open novi for that").
            const target = `${rt.noviPage}/?cardview=${encodeURIComponent(cardId)}`
              + (fileName ? `&changes=${encodeURIComponent(changesId)}&file=${encodeURIComponent(fileName)}` : '');
            await (openCardWindow || defaultOpenCardWindow(rt.dataDir || os.tmpdir(), rt.tls?.cert))(target);
            // Windows keeps a new window behind the one in use: bring the card window (titled "Card from your phone") forward.
            setTimeout(() => { Promise.resolve(rt.callTool?.('laptop_window', { do: 'focus', app: 'Card from your phone' })).catch(() => {}); }, focusDelayMs);
            log(`card: ${fileName ? 'a file of a card' : 'a card'} opened on the laptop`);
            return { ok: true, note: 'Opened it on the laptop.' };
          }
          // Flick down / circle on the phone (user, 2026-11-18): the laptop sends something BACK, nothing lands here.
          if (kind === 'pull' || kind === 'circle') {
            if (kind === 'pull') {
              const page = await Promise.resolve(rt.callTool?.('laptop_current_link', {})).catch(() => null);
              if (page?.url) { log('pull: page to the phone'); return { ok: true, link: page.url, title: String(page.title || '').slice(0, 200) }; }
            }
            const shot = await Promise.resolve(rt.laptopScreenshot?.()).catch(() => null);
            if (!shot || shot.refused || !shot.png) return { ok: false, error: shot?.refused ? 'The laptop is showing a private screen (sign-in, payment or settings), so no picture.' : "Couldn't take a picture of the laptop screen." };
            log(`${kind}: laptop screen to the phone`);
            // The circle's picture lands on the laptop stage too (user, 2026-11-19).
            if (kind === 'circle') {
              try {
                const tmpPng = path.join(rt.dataDir || os.tmpdir(), `circle-${id}.png`);
                fs.writeFileSync(tmpPng, Buffer.from(shot.png));
                const saved = saveFlick({ tmp: tmpPng, name: `Laptop screen ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`, root: saveRoot });
                await showStage();
                st.push({ id, kind: 'photo', name: path.basename(saved), path: saved, at: Date.now() });
                touch();
              } catch (e) { log(`circle picture not put on the stage: ${String(e?.message || e).slice(0, 120)}`); }
            }
            return { ok: true, image: Buffer.from(shot.png).toString('base64'), type: 'image/png' };
          }
          if (kind === 'text') {
            // Text selected on the phone (user, 2026-11-16): a text card, also saved as a .txt in Novi Flick.
            const words = fs.readFileSync(file, 'utf8').replace(/ /g, '').trim().slice(0, 20000);
            if (!words) return { ok: false, error: 'No text came with it.' };
            fs.writeFileSync(file, words);
            const saved = saveFlick({ tmp: file, name: `Text ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`, root: saveRoot });
            item = { id, kind: 'doc', name: words.split(/s+/).slice(0, 8).join(' ').slice(0, 60), path: saved, text: words, at: Date.now() };
            // Selected text is also put on the laptop's clipboard, ready to paste (user, 2026-11-17).
            copy({ text: words }).catch?.(() => {});
          } else if (kind === 'youtube') {
            // A video playing in the phone's YouTube app (user, 2026-11-16): its title; the laptop plays it on YouTube.
            const title = fs.readFileSync(file, 'utf8').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
            if (!title) return { ok: false, error: 'No video title came with it.' };
            playTitle = title;
            item = { id, kind: 'video', name: title, host: 'youtube.com', url: `https://www.youtube.com/results?search_query=${encodeURIComponent(title)}`, at: Date.now() };
          } else if (kind === 'link') {
            const link = linkItem(fs.readFileSync(file, 'utf8').slice(0, 4000));
            if (!link) return { ok: false, error: 'That is not a web link.' };
            item = { id, ...link, at: Date.now() };
          } else {
            const saved = saveFlick({ tmp: file, name: withEnding(name, type), root: saveRoot });
            item = { id, kind: kindOf(saved, type), name: path.basename(saved), path: saved, at: Date.now() };
            // A screenshot carries the page or video it shows (user, 2026-11-17): a link under the card, opened on click.
            let shot = null;
            try { shot = shotLink ? linkItem(decodeURIComponent(shotLink)) : null; } catch { shot = null; }
            if (shot) item.link = shot.url;
          }
          await showStage();
          st.push(item);
          touch();
          log(`${item.kind} landed`);
          if (playTitle) setTimeout(() => { Promise.resolve(rt.callTool?.('play_youtube', { query: playTitle, on: 'laptop' })).catch(() => {}); }, linkDelayMs);
          else if (item.url && autoOpens(item.url)) setTimeout(() => { openItem(item).catch(() => {}); }, linkDelayMs);
          return { ok: true, id, kind: item.kind, name: item.name };
        },
      });

      api.registerTool({
        name: 'flick_stage',
        description: 'Open or close the laptop\'s full-screen Novi stage, where things flicked from the phone land.',
        parameters: obj({ do: { type: 'string', enum: ['open', 'close'] } }, ['do']),
        async execute(_id, { do: what } = {}) {
          if (what === 'close') { await hideStage(); return reply('Closed the stage.'); }
          await showStage(); touch();
          return reply('The stage is open. Flick something from your phone.');
        },
      });
      api.registerTool({
        name: 'flick_open',
        description: 'Open the newest thing flicked from the phone on the laptop (a file in its app, a link in the browser).',
        parameters: obj({}),
        async execute() {
          const items = st.items();
          return reply(await openItem(items[items.length - 1]));
        },
      });
      api.registerTool({
        name: 'flick_from_phone',
        description: 'Send what is on the phone screen right now (a photo, a screenshot, the page in its browser) to the laptop stage, like a wrist flick. For "send this to my laptop" said on the phone.',
        parameters: obj({}),
        async execute() {
          if (!rt.phoneAction) return reply("I can't reach your phone from here.");
          const r = await rt.phoneAction({ do: 'flick' });
          const note = r?.note || (r?.ok ? 'It landed on the laptop.' : "The phone couldn't send it.");
          return reply(note, { note, ok: Boolean(r?.ok) });
        },
      });
      api.registerTool({
        name: 'flick_do',
        description: 'Do something with the newest thing flicked from the phone: open it, open a link in the browser, copy it to the clipboard (a photo as the picture), show it in its folder, send it to someone on WhatsApp (to), or send it to an AI site (app).',
        parameters: obj({
          action: { type: 'string', enum: ['open', 'browser', 'copy', 'folder', 'whatsapp', 'whatsapp_open', 'ai', 'to'] },
          to: { type: 'string', description: 'WhatsApp contact name, or (action "to") where the user typed: an AI site or a contact' },
          app: { type: 'string', enum: Object.keys(AI_SITES) },
          recent: { type: 'boolean', description: 'Only if something landed in the last 10 minutes' },
          handoff: { type: 'boolean', description: 'WhatsApp: only say what to send (the caller sends it)' },
        }, ['action']),
        async execute(_id, { action, to, app, recent, handoff } = {}) {
          const items = st.items();
          const item = items[items.length - 1];
          // "send it to Rahul" is about a flick only right after one landed; otherwise the words go on.
          if (recent && (!item || Date.now() - (item.at || 0) > RECENT_MS)) return reply('No recent flick.', { unknown: true });
          const { note, send } = await act(item, { action, to, app, handoff: Boolean(handoff) });
          return reply(note, { note, ...(send ? { send } : {}) });
        },
      });

      api.registerService({ id: 'flick-stage', start() {}, stop() { clearTimeout(idle); st.stop(); } });
    },
  });
}

export default createFlickPlugin();
