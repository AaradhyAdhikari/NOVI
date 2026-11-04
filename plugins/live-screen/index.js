import crypto from 'node:crypto';
import { definePluginEntry } from '#plugin-sdk';
import { windowsDriver } from '../screen/index.js';

// The laptop's screen, live on the phone: tap to click, swipe to scroll, type with the phone's keyboard
// (user, 2026-11-04: "control my whole laptop from my phone"). Over Novi's own connection, paired phones
// only. Opening it always needs the voice PIN, it belongs to the one phone that opened it, and it closes
// after 15 minutes without a touch. What is typed is never logged.
const IDLE_MS = 15 * 60_000;
const GAP_MS = 350; // at most about 2-3 pictures a second; the phone asks for the next one
const MAX_TEXT = 2000;
const KEYS = new Set(['enter', 'esc', 'tab', 'backspace', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'alt+left', 'alt+right', 'f5']);
const unit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

export function createLiveScreenPlugin({ driver = windowsDriver, now = Date.now, gapMs = GAP_MS, idleMs = IDLE_MS } = {}) {
  return definePluginEntry({
    id: 'live-screen',
    name: 'Live screen',
    description: 'The laptop screen live on the phone, with taps, scrolling and typing.',
    register(api) {
      let session = null; // { deviceId, touched, width, height, hash, sentAt, sending, inputs }
      let queue = Promise.resolve(); // one input at a time, in order
      let asked = null; // the phone the PIN card was for; `active` in app.js moves on with whoever speaks next

      const end = (why) => {
        if (session) api.logger?.info?.(`[live] closed after ${session.inputs} input(s): ${why}`);
        session = null;
      };
      const open = (from) => {
        if (session && now() - session.touched >= idleMs) end('idle');
        return session && from?.deviceId === session.deviceId ? session : null;
      };

      async function sendFrame(s, reply) {
        if (s.sending) return;
        s.sending = true;
        try {
          const wait = gapMs - (now() - s.sentAt);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          // The same capture "show me my screen" uses (a compressing capture in win.ps1 tripped Defender,
          // 2026-11-04). About 110 ms and 230 KB on this laptop, more on a busy screen; the phone sets the pace.
          const { png, width, height } = await driver.screenshot();
          s.width = width; s.height = height; s.sentAt = now();
          const hash = crypto.createHash('sha1').update(png).digest('hex');
          if (hash === s.hash) return reply({ type: 'live_same' });
          s.hash = hash;
          return reply({ type: 'live_frame', png: png.toString('base64'), width, height });
        } catch (err) {
          api.logger?.warn?.(`[live] picture failed: ${err.message}`);
          return reply({ type: 'live_same' });
        } finally {
          s.sending = false;
        }
      }

      async function act(s, m, reply) {
        if (m.kind === 'tap' && unit(m.x) && unit(m.y) && s.width) return driver.click(Math.round(m.x * s.width), Math.round(m.y * s.height));
        if (m.kind === 'scroll' && Number.isInteger(m.notches) && Math.abs(m.notches) <= 10 && m.notches) return driver.scroll(m.notches);
        if (m.kind === 'text' && typeof m.text === 'string' && m.text.trim() && m.text.length <= MAX_TEXT) {
          const box = await driver.focused?.().catch(() => null);
          if (box?.password) { reply({ type: 'live_note', text: "That's a password box. Please type it on the laptop." }); return null; }
          return driver.type(m.text);
        }
        if (m.kind === 'key' && KEYS.has(m.key)) return driver.key(m.key);
        return null;
      }

      if (api.runtime) {
        api.runtime.liveMessage = async (msg, from, reply) => {
          const s = open(from);
          if (msg.type === 'live_stop') { if (s) end('closed on the phone'); return reply({ type: 'live_closed' }); }
          if (!s) return reply({ type: 'live_closed', reason: 'The live screen closed because it was idle. Open it again with your PIN.' });
          if (msg.type === 'live_ack') return sendFrame(s, reply);
          if (msg.type !== 'live_input') return undefined;
          s.touched = now();
          s.hash = null; // whatever the touch changes shows at once
          queue = queue.then(() => act(s, msg, reply)).then((did) => { if (did !== null) s.inputs += 1; }).catch((err) => api.logger?.warn?.(`[live] input failed: ${err.message}`));
          return queue;
        };
      }

      api.registerTool({
        name: 'live_screen_open',
        description: 'Show the laptop screen live on the phone that asked, to tap, scroll and type on it. Asks for the voice PIN.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          const deviceId = asked;
          asked = null;
          if (!deviceId) return { content: [], details: { error: 'The live screen is for your phone. Ask from the phone.' } };
          session = { deviceId, touched: now(), width: 0, height: 0, hash: null, sentAt: 0, sending: false, inputs: 0 };
          api.logger?.info?.('[live] opened on a phone');
          api.runtime.sendToDevice(deviceId, { type: 'live_open' });
          return { content: [], details: { note: 'Opening your laptop screen.' } };
        },
      });
      api.on('before_tool_call', ({ toolName, from }) => {
        if (toolName !== 'live_screen_open') return undefined;
        asked = from?.deviceId || null;
        if (!asked) return undefined; // the tool then says it is for the phone
        return { requireApproval: { title: 'Control the laptop from this phone', description: 'Taps, scrolling and typing on your phone will act on the laptop.', prompt: 'Control the laptop from this phone? Say your PIN.', severity: 'warning', category: 'screen', grantable: false, pin: true } };
      });
      api.registerService({ id: 'live-screen', start() {}, stop() { end('Novi stopped'); } });
    },
  });
}

export default createLiveScreenPlugin();
