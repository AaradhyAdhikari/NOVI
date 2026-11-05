import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from '#plugin-sdk';
import { pickButtons, isPrivateBox, cardFor, boxKey } from './boxes.js';

// Any app's Allow box on the phone (user, 2026-11-05): "all the other sessions permission to go through
// novi". watch.ps1 reads the buttons of the open windows through Windows accessibility in its own process;
// a box with two sides becomes a card that waits until it is answered, and the answer presses that button
// in that window, without the mouse. A box answered on the laptop closes its card.
const SCRIPT = fileURLToPath(new URL('./watch.ps1', import.meta.url));
const DELAYS = [2000, 5000, 15_000, 60_000];

function createWatchProcess({ onEvent, logger = console }) {
  let child = null;
  let stopped = false;
  let crashes = 0;
  const start = () => {
    stopped = false;
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        try { onEvent(JSON.parse(line)); } catch { /* not an event line */ }
      }
    });
    child.on('error', (err) => logger.warn?.(`[watch] ${err.message}`));
    child.stdin.on('error', () => {}); // writing to a helper that just died must not bring Novi down
    child.on('exit', () => {
      child = null;
      if (stopped) return;
      const wait = DELAYS[Math.min(crashes++, DELAYS.length - 1)];
      setTimeout(() => { if (!stopped) start(); }, wait).unref?.();
    });
  };
  return {
    start,
    send(msg) { try { if (child?.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* it restarts */ } },
    stop() { stopped = true; child?.kill(); },
  };
}

export function createPermissionWatchPlugin({ platform = process.platform, createProcess = createWatchProcess, goneMs = 5000 } = {}) {
  return definePluginEntry({
    id: 'permission-watch',
    name: 'Allow boxes on the phone',
    description: "Any app's Allow or Yes/No box on the laptop as a card on the phone; the answer presses the button.",
    register(api) {
      const rt = api.runtime || {};
      const open = new Map(); // box key → the box, while its card waits or was just answered
      let helper = null;
      let presses = 0;
      const waitingPress = new Map();

      async function askAbout(key, box, buttons) {
        const d = await rt.ask(cardFor(box));
        const entry = open.get(key);
        if (!entry || entry.gone) return; // answered on the laptop
        if (!d?.allow && (d?.timedOut || d?.closed)) return; // nobody said no: press nothing
        const id = ++presses;
        waitingPress.set(id, box);
        // `expect`: the helper re-reads the box and presses only if the words are still the ones on the card.
        helper?.send({ press: { id, hwnd: box.hwnd, button: d?.allow ? buttons.yes : buttons.no, expect: box.text || '' } });
      }

      function onBoxes(boxes) {
        const now = new Map();
        for (const box of boxes) {
          const buttons = pickButtons(box.buttons);
          if (buttons && !isPrivateBox(box)) now.set(boxKey(box), { box, buttons });
        }
        for (const [key, { box, buttons }] of now) {
          const known = open.get(key);
          if (known) {
            clearTimeout(known.leaving); // a scan missed it, and it's back
            known.leaving = null;
            continue;
          }
          open.set(key, { box });
          askAbout(key, box, buttons).catch((err) => api.logger?.warn?.(`[watch] ${err.message}`));
        }
        for (const [key, entry] of open) {
          if (now.has(key) || entry.leaving) continue;
          // One bad scan mustn't close a card: only a box still gone a few seconds later is really gone.
          entry.leaving = setTimeout(() => {
            open.delete(key);
            entry.gone = true;
            rt.cancelCard?.(key);
          }, goneMs);
          entry.leaving.unref?.();
        }
      }

      const onEvent = (e) => {
        if (e.boxes) onBoxes(e.boxes);
        if (e.pressed) {
          const box = waitingPress.get(e.pressed.id);
          waitingPress.delete(e.pressed.id);
          if (box && !e.pressed.ok) rt.say?.(`I couldn't press the button in ${box.title || 'that window'}. Answer it on the laptop.`, { kind: null });
        }
      };

      api.registerService({
        id: 'permission-watch',
        start() {
          if (platform !== 'win32' || String(process.env.NOVI_WATCH || '').toLowerCase() === 'off') return;
          helper = createProcess({ onEvent, logger: api.logger });
          helper.start();
        },
        stop() { helper?.stop(); helper = null; },
      });
    },
  });
}

export default createPermissionWatchPlugin();
