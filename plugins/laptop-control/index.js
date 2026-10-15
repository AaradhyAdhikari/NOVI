import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from '#plugin-sdk';
import { createControlWorker } from './worker.js';
import { findWindows, workWindow, appLabel } from './windows.js';
import { looksSecret } from '../wiki/vault.js';

// Laptop control by voice: sound, screen brightness, media keys, battery, Wi-Fi/Bluetooth, power,
// windows and clipboard, through one PowerShell helper (control.ps1). User's rules (2026-10-15):
// anything that turns something off asks first (never "always allow"); from a phone, actions that
// cut the link to Novi add a warning; clipboard secrets are never read out; paste never sends.
const STEP = 10;
const COUNTDOWN_MS = 15_000;
const LOSE = "You'll lose the connection to Novi until the laptop is back.";
const CUTS_LINK = new Set(['sleep', 'shutdown', 'restart']);
const POWER_ASK = { lock: 'Lock the laptop?', sleep: 'Put the laptop to sleep?', shutdown: 'Shut down the laptop?', restart: 'Restart the laptop?', signout: 'Sign out?' };
const POWER_NOTE = { lock: 'Locked.', sleep: 'Going to sleep.', signout: 'Signing out.', shutdown: 'Shutting down in 15 seconds. Say cancel to stop.', restart: 'Restarting in 15 seconds. Say cancel to stop.' };
const MEDIA_NOTE = { play: 'Playing.', pause: 'Paused.', next: 'Next.', previous: 'Previous.' };
const RADIO = { wifi: 'Wi-Fi', bluetooth: 'Bluetooth' };
const DONE = { focus: 'Switched to', minimize: 'Minimized', maximize: 'Maximized' };

const reply = (details) => ({ content: [], details });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const fromPhone = (from) => Boolean(from && typeof from === 'object' && from.deviceId);
const ask = (title) => ({ requireApproval: { title, prompt: title, severity: 'warning', category: 'laptop', grantable: false } });

function failure(err, what) {
  const m = String(err?.message || err);
  if (m === 'not-windows') return 'Laptop controls work only on Windows.';
  if (m === 'timeout' || m === 'worker-exit') return "I couldn't reach the laptop controls.";
  if (m === 'no-brightness') return "I can't change this screen's brightness.";
  if (m === 'no-radio') return `I can't switch ${what || 'that'} from here. Use the Action Center.`;
  return `That didn't work on the laptop (${m.slice(0, 80)}).`;
}

export function createLaptopControlPlugin({
  worker = null,
  platform = process.platform,
  now = () => Date.now(),
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'control.ps1');
  let w = worker;
  const run = (cmd, args) => {
    if (platform !== 'win32') return Promise.reject(new Error('not-windows'));
    w ||= createControlWorker({ script });
    return w.run(cmd, args);
  };
  const windows = async () => (await run('windows', {})).windows || [];
  // Each tool: (params) → details; any failure becomes one honest sentence.
  const tool = (api, name, description, parameters, fn, what) => api.registerTool({
    name, description, parameters,
    async execute(_id, params = {}) {
      try { return reply(await fn(params)); } catch (err) { return reply({ error: failure(err, what?.(params)) }); }
    },
  });
  const level = (p) => (p.level !== undefined && p.level !== null ? { level: Math.max(0, Math.min(100, Math.round(Number(p.level)))) }
    : p.change ? { delta: p.change === 'down' ? -STEP : STEP } : {});

  return definePluginEntry({
    id: 'laptop-control',
    name: 'Laptop control',
    description: 'Sound, brightness, media, battery, Wi-Fi/Bluetooth, power, windows and clipboard on the laptop.',
    register(api) {
      tool(api, 'laptop_volume', 'Set the laptop volume (0-100), turn it up/down a step, or mute/unmute.',
        obj({ level: { type: 'number' }, change: { type: 'string', enum: ['up', 'down'] }, mute: { type: 'boolean' } }),
        async (p) => {
          const r = await run('volume', { ...level(p), ...(p.mute !== undefined ? { mute: Boolean(p.mute) } : {}) });
          return { ...r, note: p.mute === true ? 'Muted.' : p.mute === false ? 'Unmuted.' : `Volume ${r.level}.` };
        });

      tool(api, 'laptop_brightness', 'Set the laptop screen brightness (0-100) or turn it up/down a step.',
        obj({ level: { type: 'number' }, change: { type: 'string', enum: ['up', 'down'] } }),
        async (p) => { const r = await run('brightness', level(p)); return { ...r, note: `Brightness ${r.level}.` }; });

      tool(api, 'laptop_media', 'Media keys for whatever is playing (YouTube, Spotify…): play, pause, next, previous.',
        obj({ key: { type: 'string', enum: ['play', 'pause', 'next', 'previous'] } }, ['key']),
        async ({ key }) => {
          if (!MEDIA_NOTE[key]) throw new Error('bad-key');
          await run('media', { key: key === 'pause' ? 'play' : key });
          return { note: MEDIA_NOTE[key] };
        });

      tool(api, 'laptop_battery', 'Battery level, charging or time left. Read-only.', obj({}), async () => {
        const b = await run('battery', {});
        if (b.none) return { ...b, note: "This laptop doesn't report a battery." };
        const left = b.minutesLeft ? `, about ${b.minutesLeft >= 60 ? `${Math.floor(b.minutesLeft / 60)} h ${b.minutesLeft % 60} min` : `${b.minutesLeft} min`} left` : '';
        return { ...b, note: `${b.percent}%${b.charging ? ', charging' : left}.` };
      });

      tool(api, 'laptop_radio', 'Turn Wi-Fi or Bluetooth on or off (like the Action Center).',
        obj({ kind: { type: 'string', enum: ['wifi', 'bluetooth'] }, on: { type: 'boolean' } }, ['kind', 'on']),
        async ({ kind, on }) => { const r = await run('radio', { kind, on: Boolean(on) }); return { ...r, note: `${RADIO[kind] || kind} is ${r.on ? 'on' : 'off'}.` }; },
        (p) => RADIO[p.kind]);

      tool(api, 'laptop_power', 'Lock, sleep, shut down, restart or sign out of the laptop, or cancel a shut down/restart that is counting down.',
        obj({ action: { type: 'string', enum: ['lock', 'sleep', 'shutdown', 'restart', 'signout', 'cancel'] } }, ['action']),
        async ({ action }) => {
          if (action === 'cancel') { await run('power-cancel', {}); return { note: 'Okay, cancelled.' }; }
          if (!POWER_NOTE[action]) throw new Error('bad-action');
          await run(action === 'lock' || action === 'sleep' ? action : 'power', action === 'lock' || action === 'sleep' ? {} : { action });
          return { note: POWER_NOTE[action], ...(action === 'shutdown' || action === 'restart' ? { countdownUntil: now() + COUNTDOWN_MS } : {}) };
        });

      tool(api, 'laptop_window', 'Switch to (focus), minimize, maximize or close an app window by its name, e.g. "Chrome", "WhatsApp", "VS Code". all = every window of that app.',
        obj({ app: { type: 'string' }, do: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'close'] }, all: { type: 'boolean' } }, ['app', 'do']),
        async ({ app, do: action, all }) => {
          const found = findWindows(await windows(), app);
          if (!found.length) return { error: `I don't see a window for ${app}.` };
          const label = appLabel(found[0]);
          if (action === 'close') {
            const targets = all ? found : found.slice(0, 1);
            for (const t of targets) await run('window', { id: t.id, do: 'close' });
            return { note: targets.length > 1 ? `Closed ${targets.length} ${label} windows.` : `Closed ${label}.` };
          }
          if (!DONE[action]) throw new Error('bad-window-action');
          await run('window', { id: found[0].id, do: action });
          return { note: `${DONE[action]} ${label}.` };
        });

      tool(api, 'laptop_clipboard', 'Clipboard: read what was copied, copy the selection in the app the user is working in, copy given text (set), or paste into an app (never sends).',
        obj({ do: { type: 'string', enum: ['read', 'copy', 'set', 'paste'] }, text: { type: 'string' }, app: { type: 'string' } }, ['do']),
        async ({ do: action, text, app }) => {
          if (action === 'read') {
            const t = String((await run('clip-get', {})).text || '').trim();
            if (!t) return { note: "There's no text on the clipboard." };
            if (looksSecret(t)) return { note: "That looks like a password, I won't read it out." };
            return { text: t.slice(0, 2000), note: `You copied: ${t.slice(0, 2000)}`, sensitive: true };
          }
          if (action === 'set') {
            if (!String(text || '').trim()) return { error: "There's nothing to copy yet." };
            await run('clip-set', { text: String(text) });
            return { note: 'Copied.' };
          }
          if (action === 'copy') {
            const work = workWindow(await windows());
            if (!work) return { error: "I don't see what to copy from." };
            await run('window', { id: work.id, do: 'focus' });
            await pause(150);
            await run('keys', { combo: 'copy' });
            await pause(150);
            const t = String((await run('clip-get', {})).text || '').trim();
            if (!t) return { error: 'Nothing was selected to copy.' };
            if (looksSecret(t)) return { note: 'Copied.' };
            const words = t.split(/\s+/);
            return { note: `Copied: ${words.slice(0, 8).join(' ')}${words.length > 8 ? '…' : '.'}` };
          }
          if (action === 'paste') {
            const list = await windows();
            const target = app ? findWindows(list, app)[0] : workWindow(list);
            if (!target) return { error: `I don't see a window for ${app || 'that'}.` };
            await run('window', { id: target.id, do: 'focus' });
            await pause(150);
            await run('keys', { combo: 'paste' }); // never Enter: sending stays the user's
            return { note: `Pasted into ${appLabel(target)}. I didn't send it.` };
          }
          throw new Error('bad-clipboard-action');
        });

      api.on('before_tool_call', async ({ toolName, params = {}, from }) => {
        const warn = (title, cuts) => ask(cuts && fromPhone(from) ? `${title} ${LOSE}` : title);
        if (toolName === 'laptop_power' && POWER_ASK[params.action]) return warn(POWER_ASK[params.action], CUTS_LINK.has(params.action));
        if (toolName === 'laptop_radio' && params.on === false) return warn(`Turn ${RADIO[params.kind] || params.kind} off?`, true);
        if (toolName === 'laptop_window' && params.do === 'close') {
          let found = [];
          try { found = findWindows(await windows(), params.app); } catch { return undefined; } // the run reports the error
          if (!found.length) return undefined;
          const label = appLabel(found[0]);
          return ask(params.all && found.length > 1 ? `Close all ${found.length} ${label} windows?` : `Close ${label}?`);
        }
        return undefined;
      });
    },
  });
}

export default createLaptopControlPlugin();
