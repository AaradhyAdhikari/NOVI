import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from '#plugin-sdk';
import { createOrbProcess } from './orbProcess.js';
import { cleanDictation } from '../../server/voice/dictationCleanup.js';

// The desktop orb (user, 2026-10-18): a small Novi circle, always on top in a corner (draggable,
// remembered), showing what Novi is doing on the laptop. A tap = "Hey Novi" without saying it;
// holding Ctrl+Shift+Space records, and letting go types the words into the app in front
// (plugins/dictation). Windows only; NOVI_ORB=off turns it off. The held-key words are tidied first
// (fillers, stutters, capitals: server/voice/dictationCleanup.js, 2026-11-03); NOVI_DICTATION_CLEANUP=off
// types them exactly as heard. "type: …" by voice is never changed. Hands-free (2026-11-04): a quick
// tap of the keys keeps listening with them up, the next tap stops and types (5 minutes at most).
const TAP_MS = 600; // keys let go sooner than this = a tap
const LONG_MS = 5 * 60_000; // the longest one dictation

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'orb.ps1');

export function createOrbPlugin({ platform = process.platform, env = process.env, createProcess = createOrbProcess, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return definePluginEntry({
    id: 'orb',
    name: 'Desktop orb',
    description: 'A small always-on-top Novi orb on the laptop screen; holds Ctrl+Shift+Space for dictation.',
    register(api) {
      const rt = api.runtime || {};
      const file = path.join(rt.dataDir || 'data', 'orb.json');
      const place = () => { try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null; } catch { return null; } };

      // Settings → "Hey Novi" → Clean up dictation; until it is touched, NOVI_DICTATION_CLEANUP decides.
      const cleanupFile = path.join(rt.dataDir || 'data', 'dictation.json');
      const saved = () => { try { return JSON.parse(fs.readFileSync(cleanupFile, 'utf8')); } catch { return {}; } }; // not set yet
      const cleanupOn = () => saved().cleanup ?? String(env.NOVI_DICTATION_CLEANUP || '').toLowerCase() !== 'off';
      const polishOn = () => saved().polish === true;
      api.registerHttpRoute({
        path: 'dictation-cleanup',
        handler: ({ on, polish } = {}) => {
          if (typeof on === 'boolean' || typeof polish === 'boolean') {
            fs.mkdirSync(path.dirname(cleanupFile), { recursive: true });
            fs.writeFileSync(cleanupFile, JSON.stringify({ ...saved(), ...(typeof on === 'boolean' ? { cleanup: on } : {}), ...(typeof polish === 'boolean' ? { polish } : {}) }));
          }
          return { on: cleanupOn(), polish: polishOn() };
        },
      });

      async function dictate() {
        const wav = rt.wake?.release?.();
        if (!wav?.length) return;
        const text = String((await rt.hear(wav)) || '').trim();
        if (!text || text === '.') return;
        const tidy = cleanupOn() ? cleanDictation(text) : text;
        if (!tidy) return; // nothing left but fillers ("um")
        // The local AI, when switched on (plugins/rewrite). It gives the same words back if it can't.
        const polished = polishOn() ? await rt.callTool('text_rewrite', { text: tidy }).catch(() => null) : null;
        const out = await rt.callTool('dictate_type', { text: polished?.text || tidy });
        if (out?.error) rt.say?.(`I couldn't type that: ${out.error}`, { kind: null, local: true });
      }
      let heldAt = 0;
      let open = null; // the 5-minute timer while a tap keeps the mic open
      const finish = () => {
        if (open) clearTimer(open);
        open = null;
        return dictate().catch((err) => api.logger?.warn?.(`[orb] dictation failed: ${err.message}`));
      };
      const onEvent = (e = {}) => {
        if (e.event === 'tap') return rt.wake?.listen?.();
        if (e.event === 'hold_start') {
          if (open) return undefined; // the second tap: its key-up ends it
          heldAt = now();
          if (polishOn()) rt.callTool('text_rewrite', { warm: true }).catch(() => {}); // loads while you talk
          return rt.wake?.hold?.({ maxMs: LONG_MS });
        }
        if (e.event === 'hold_end') {
          if (!open && now() - heldAt < TAP_MS) {
            open = setTimer(finish, LONG_MS);
            open.unref?.();
            return undefined;
          }
          return finish();
        }
        if (e.event === 'open') return rt.openUrl?.('https://localhost:3001');
        if (e.event === 'moved' && Number.isFinite(e.x) && Number.isFinite(e.y)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ x: e.x, y: e.y }));
        }
        return undefined;
      };

      let orb = null;
      let unsubscribe = null;
      api.registerService({
        id: 'desktop-orb',
        start() {
          if (platform !== 'win32' || String(env.NOVI_ORB || '').toLowerCase() === 'off') return;
          orb = createProcess({ script: SCRIPT, place, onEvent, logger: api.logger });
          orb.start();
          unsubscribe = rt.laptopState?.on?.((state) => orb?.send({ state }));
        },
        stop() { if (open) clearTimer(open); open = null; unsubscribe?.(); orb?.stop(); orb = null; },
      });
    },
  });
}

export default createOrbPlugin();
