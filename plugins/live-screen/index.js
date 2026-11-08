import crypto from 'node:crypto';
import { definePluginEntry } from '#plugin-sdk';
import { windowsDriver } from '../screen/index.js';
import { createStream } from './stream.js';

// The laptop's screen, live on the phone: tap to click, swipe to scroll, type with the phone's keyboard
// (user, 2026-11-04: "control my whole laptop from my phone"). Over Novi's own connection, paired phones
// only. Opening it always needs the voice PIN, it belongs to the one phone that opened it, and it closes
// after 15 minutes without a touch. What is typed is never logged.
const IDLE_MS = 15 * 60_000;
const GAP_MS = 350; // at most about 2-3 pictures a second; the phone asks for the next one
const MAX_TEXT = 2000;
const KEYS = new Set(['enter', 'esc', 'tab', 'backspace', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'alt+left', 'alt+right', 'f5']);
const unit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

// `stream`: the smooth video (stream.js); the pictures below stay as the backup when it can't start.
export function createLiveScreenPlugin({ driver = windowsDriver, now = Date.now, gapMs = GAP_MS, idleMs = IDLE_MS, stream = createStream, prewarmMs = 60_000 } = {}) {
  return definePluginEntry({
    id: 'live-screen',
    name: 'Live screen',
    description: 'The laptop screen live on the phone, with taps, scrolling and typing.',
    register(api) {
      let session = null; // { deviceId, touched, width, height, hash, sentAt, sending, inputs }
      let queue = Promise.resolve(); // one input at a time, in order
      let asked = null; // the phone the PIN card was for; `active` in app.js moves on with whoever speaks next
      // Edge warms up while the PIN card waits (user, 2026-11-08: "the fastest we can as we click"), so the
      // video is nearly ready when the PIN is given. Nobody approves it within prewarmMs: stopped.
      let warm = null; // { deviceId, video, result: Promise<{ offer } | { err }>, timer }
      const dropWarm = () => { if (warm) { clearTimeout(warm.timer); warm.video.stop(); warm = null; } };
      const warmUp = (deviceId) => {
        dropWarm();
        const video = stream({ logger: api.logger });
        const started = Date.now();
        const result = video.start().then((offer) => ({ offer, ms: Date.now() - started }), (err) => ({ err }));
        warm = { deviceId, video, result, timer: setTimeout(dropWarm, prewarmMs) };
        warm.timer.unref?.();
      };

      const end = (why) => {
        if (session) api.logger?.info?.(`[live] closed after ${session.inputs} input(s): ${why}`);
        session?.video?.stop();
        session?.warm?.video.stop();
        session = null;
      };

      // Live 2026-11-08: a start sometimes never got its offer while the next one worked in 2 s, so a
      // failed start gets one more try with a fresh Edge before the pictures take over.
      async function startVideo(s, reply, tries = 2) {
        s.video?.stop();
        const ready = s.warm;
        s.warm = null;
        const video = ready ? ready.video : stream({ logger: api.logger });
        s.video = video;
        try {
          const started = Date.now();
          const got = ready ? await ready.result : null;
          if (got?.err) throw got.err;
          const { sdp, width, height } = got ? got.offer : await video.start();
          api.logger?.info?.(`[live] video offer in ${Date.now() - started} ms${got ? ` (warmed up during the PIN card: ${got.ms} ms)` : ''}`);
          if (session !== s || s.video !== video) { video.stop(); return reply({ type: 'live_closed' }); }
          if (width && height) { s.width = width; s.height = height; }
          api.logger?.info?.(`[live] video stream ready (${width}x${height})`);
          return reply({ type: 'live_offer', sdp, width, height });
        } catch (err) {
          if (s.video === video) s.video = null;
          if (tries > 1 && session === s) {
            api.logger?.warn?.(`[live] video stream failed, trying again: ${err.message}`);
            return startVideo(s, reply, tries - 1);
          }
          api.logger?.warn?.(`[live] video stream failed, using pictures: ${err.message}`);
          return reply({ type: 'live_stream_failed' });
        }
      }
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
        if (m.kind === 'scroll' && Number.isInteger(m.notches) && Math.abs(m.notches) <= 10 && m.notches) {
          // Under the finger, so a side panel scrolls, not the middle of the window (live 2026-11-08).
          const at = unit(m.x) && unit(m.y) && s.width ? { x: Math.round(m.x * s.width), y: Math.round(m.y * s.height) } : undefined;
          return driver.scroll(m.notches, at);
        }
        if (m.kind === 'text' && typeof m.text === 'string' && m.text.trim() && m.text.length <= MAX_TEXT) {
          const box = await driver.focused?.().catch(() => null);
          if (box?.password) { reply({ type: 'live_note', text: "That's a password box. Please type it on the laptop." }); return null; }
          return driver.type(m.text);
        }
        if (m.kind === 'key' && KEYS.has(m.key)) return driver.key(m.key);
        return null;
      }

      if (api.runtime) {
        api.runtime.liveViewing = (from) => Boolean(open(from));
        api.runtime.liveMessage = async (msg, from, reply) => {
          const s = open(from);
          if (msg.type === 'live_stop') { if (s) end('closed on the phone'); return reply({ type: 'live_closed' }); }
          if (!s) return reply({ type: 'live_closed', reason: 'The live screen closed because it was idle. Open it again with your PIN.' });
          if (msg.type === 'live_ack') return sendFrame(s, reply);
          if (msg.type === 'live_stream') { api.logger?.info?.('[live] video stream asked'); return startVideo(s, reply); }
          if (msg.type === 'live_answer') { if (typeof msg.sdp === 'string' && msg.sdp.length < 20_000) await s.video?.answer(msg.sdp).catch((err) => api.logger?.warn?.(`[live] answer failed: ${err.message}`)); return undefined; }
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
          session?.video?.stop();
          const ready = warm && warm.deviceId === deviceId ? warm : null;
          if (ready) { clearTimeout(ready.timer); warm = null; } else dropWarm();
          session = { deviceId, touched: now(), width: 0, height: 0, hash: null, sentAt: 0, sending: false, inputs: 0, video: null, warm: ready };
          api.logger?.info?.('[live] opened on a phone');
          api.runtime.sendToDevice(deviceId, { type: 'live_open' });
          return { content: [], details: { note: 'Opening your laptop screen.' } };
        },
      });
      api.on('before_tool_call', ({ toolName, from }) => {
        if (toolName !== 'live_screen_open') return undefined;
        asked = from?.deviceId || null;
        if (!asked) return undefined; // the tool then says it is for the phone
        warmUp(asked);
        return { requireApproval: { title: 'Control the laptop from this phone', description: 'Taps, scrolling and typing on your phone will act on the laptop.', prompt: 'Control the laptop from this phone? Say your PIN.', severity: 'warning', category: 'screen', grantable: false, pin: true } };
      });
      api.registerService({ id: 'live-screen', start() {}, stop() { dropWarm(); end('Novi stopped'); } });
    },
  });
}

export default createLiveScreenPlugin();
