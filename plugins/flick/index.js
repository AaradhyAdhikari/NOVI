// Novi Flick (2026-11-16, spec docs/superpowers/specs/2026-11-16-novi-flick-design.md): flick a photo, file,
// link or video from the phone and it lands on the laptop's full-screen stage. Files are saved to
// Downloads\Novi Flick\<date>; links and videos open in the laptop's browser right after they land.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';
import { saveFlick, kindOf, linkItem, defaultRoot } from './store.js';
import { createStage } from './stage.js';

const EDGE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const PROFILE = 'novi-flick-edge';
const IDLE_MS = 5 * 60_000;
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function defaultOpenWindow(dataDir) {
  return async (url) => {
    const profile = path.join(dataDir, PROFILE);
    const child = spawn(EDGE, [`--app=${url}`, '--start-fullscreen', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msImplicitSignin,Translate'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  };
}
// Ends only the stage's own Edge (found by its profile folder, never the user's Edge).
function defaultCloseWindow() {
  return () => new Promise((resolve) => {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, () => resolve());
  });
}
const defaultOpenFile = async (file) => { const c = spawn('explorer.exe', [file], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); };

// root / stage / openWindow / closeWindow / openFile / linkDelayMs: for tests.
export function createFlickPlugin({ root = null, stage = null, openWindow = null, closeWindow = null, openFile = defaultOpenFile, linkDelayMs = 1600 } = {}) {
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
        return url;
      };
      const hideStage = async () => { clearTimeout(idle); idle = null; st.bye?.(); await close(); };
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => { hideStage().catch(() => {}); }, IDLE_MS); idle.unref?.(); };

      const openItem = async (item) => {
        if (!item) return 'Nothing has been flicked yet.';
        if (item.url) { await rt.callTool?.('open_website', { target: item.url, on: 'laptop' }); return `Opened ${item.host}.`; }
        // Only photos, videos and plain documents open (an allowlist, security review); everything else stays saved.
        if (!['photo', 'video', 'doc'].includes(item.kind)) return `I saved ${item.name} in Novi Flick, but I won't open that kind of file from the phone. Open it yourself if you trust it.`;
        await openFile(item.path);
        return `Opened ${item.name}.`;
      };
      st.handle = {
        open: (id) => { openItem(st.items().find((i) => i.id === id)).catch(() => {}); },
        close: () => { hideStage().catch(() => {}); },
      };

      api.registerHttpRoute({
        path: 'flick', upload: true, phone: true,
        handler: async ({ file, name, kind, type }) => {
          const id = crypto.randomBytes(6).toString('hex');
          let item;
          if (kind === 'link') {
            const link = linkItem(fs.readFileSync(file, 'utf8').slice(0, 4000));
            if (!link) return { ok: false, error: 'That is not a web link.' };
            item = { id, ...link, at: Date.now() };
          } else {
            const saved = saveFlick({ tmp: file, name, root: saveRoot });
            item = { id, kind: kindOf(saved, type), name: path.basename(saved), path: saved, at: Date.now() };
          }
          await showStage();
          st.push(item);
          touch();
          log(`${item.kind} landed`);
          if (item.url) setTimeout(() => { openItem(item).catch(() => {}); }, linkDelayMs);
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

      api.registerService({ id: 'flick-stage', start() {}, stop() { clearTimeout(idle); st.stop(); } });
    },
  });
}

export default createFlickPlugin();
