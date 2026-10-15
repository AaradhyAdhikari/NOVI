// The WhatsApp desktop app, driven with the laptop-control helper (keyboard + clipboard) and
// Gemini vision on a screenshot of the WhatsApp window (to read the contact list and the chat name —
// the user allowed screenshots to Gemini). Same driver shape as WhatsApp Web: prepare → send/cancel.
import { findWindows } from '../laptop-control/windows.js';
import { pickContact, searchWord } from './whatsapp.js';

const NAMES = 'This is the WhatsApp app after searching. List the names of the chats shown in the search results, top to bottom, as a JSON array of strings. Only names, nothing else.';
const HEADER = 'This is the WhatsApp app with a chat open. What is the contact name in the header at the top of the open chat? Answer with the name only.';
const SENT = 'This is the WhatsApp app. Is the last message in the open chat one I just sent (on the right side, not still waiting with a clock icon)? Answer yes or no.';

export function createAppDriver({ worker, vision, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let win = null;
  let prepared = false;
  const keys = (combo) => worker.run('keys', { combo });
  const paste = async (text) => { await worker.run('clip-set', { text }); await keys('paste'); };
  async function look(prompt) {
    const { png } = await worker.run('shot-window', { id: win.id });
    return String(await vision(Buffer.from(png, 'base64'), prompt) || '').trim();
  }
  async function findWindow() {
    const list = (await worker.run('windows', {})).windows || [];
    return findWindows(list, 'whatsapp')[0] || null;
  }

  return {
    async prepare({ to, text, file }) {
      win = await findWindow();
      if (!win) {
        await worker.run('start-whatsapp', {});
        await sleep(4000);
        win = await findWindow();
        if (!win) return { error: 'Open WhatsApp first.' };
      }
      await worker.run('window', { id: win.id, do: 'focus' });
      await sleep(300);
      await keys('find');
      await keys('selectall'); // the search box keeps old text; replace it, never add to it
      await paste(searchWord(to));
      await sleep(1000);
      let names = [];
      try { names = JSON.parse((await look(NAMES)).replace(/^```(?:json)?|```$/g, '')); } catch { names = []; }
      const pick = pickContact(Array.isArray(names) ? names : [], to);
      if (pick.none) return { error: `I can't find ${to} on WhatsApp.` };
      if (pick.choose) return { choose: pick.choose };
      await keys('enter');
      await sleep(800);
      const header = await look(HEADER);
      if (header.toLowerCase() !== pick.name.toLowerCase()) return { error: `I opened ${header || 'a different chat'} instead of ${pick.name}, so I stopped.` };
      if (file) {
        await worker.run('clip-files', { paths: [file.file] });
        await keys('paste');
        await sleep(1500);
        if (text) await paste(text);
      } else if (text) {
        await paste(text);
      }
      prepared = true;
      return { ok: true, name: pick.name };
    },
    async send() {
      if (!prepared) return { sent: false };
      prepared = false;
      await keys('enter');
      await sleep(2000);
      return { sent: /^yes\b/i.test(await look(SENT)) };
    },
    async cancel() {
      prepared = false;
      await keys('escape');
    },
    async shot() { return win ? (await worker.run('shot-window', { id: win.id })).png : null; },
  };
}
