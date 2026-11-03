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
// types them exactly as heard. "type: …" by voice is never changed.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'orb.ps1');

export function createOrbPlugin({ platform = process.platform, env = process.env, createProcess = createOrbProcess } = {}) {
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
      const cleanupOn = () => {
        try { return JSON.parse(fs.readFileSync(cleanupFile, 'utf8')).cleanup !== false; } catch { /* not set yet */ }
        return String(env.NOVI_DICTATION_CLEANUP || '').toLowerCase() !== 'off';
      };
      api.registerHttpRoute({
        path: 'dictation-cleanup',
        handler: ({ on } = {}) => {
          if (typeof on === 'boolean') {
            fs.mkdirSync(path.dirname(cleanupFile), { recursive: true });
            fs.writeFileSync(cleanupFile, JSON.stringify({ cleanup: on }));
          }
          return { on: cleanupOn() };
        },
      });

      async function dictate() {
        const wav = rt.wake?.release?.();
        if (!wav) return;
        const text = String((await rt.hear(wav)) || '').trim();
        if (!text || text === '.') return;
        const tidy = cleanupOn() ? cleanDictation(text) : text;
        if (!tidy) return; // nothing left but fillers ("um")
        const out = await rt.callTool('dictate_type', { text: tidy });
        if (out?.error) rt.say?.(`I couldn't type that: ${out.error}`, { kind: null, local: true });
      }
      const onEvent = (e = {}) => {
        if (e.event === 'tap') return rt.wake?.listen?.();
        if (e.event === 'hold_start') return rt.wake?.hold?.({ maxMs: 60_000 });
        if (e.event === 'hold_end') return dictate().catch((err) => api.logger?.warn?.(`[orb] dictation failed: ${err.message}`));
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
        stop() { unsubscribe?.(); orb?.stop(); orb = null; },
      });
    },
  });
}

export default createOrbPlugin();
