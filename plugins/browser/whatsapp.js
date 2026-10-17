// WhatsApp Web through the Novi extension: find one contact, check the opened chat is that person,
// attach a file (folders are zipped first) and/or type a message, then — only after the user's
// yes — press Send and wait for the tick. WhatsApp's page changes over time, so every place Novi
// touches is in WA below (sent to the extension with each command; a fix needs no extension reload).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

export const WA = {
  qr: 'canvas[aria-label*="Scan" i], div[data-ref] canvas',
  ready: '#side, #pane-side, [aria-label="Chat list" i]',
  search: '#side div[contenteditable="true"], [aria-label*="Search" i][contenteditable="true"]',
  chatTitles: '#pane-side span[title]',
  header: '#main header span[dir="auto"][title], #main header span[dir="auto"]',
  attachButton: '#main [data-icon="plus-rounded"], #main [data-icon="plus"], #main [data-icon="attach-menu-plus"], #main [aria-label="Attach" i]',
  fileInput: 'input[type="file"][accept="*"], input[type="file"]',
  caption: 'div[contenteditable="true"][aria-label*="caption" i], div[contenteditable="true"][data-tab="10"]',
  compose: '#main footer div[contenteditable="true"]',
  send: '[data-icon="send"], [aria-label="Send" i]',
  closePreview: '[data-icon="x"], [aria-label="Close" i]',
  sentTick: '#main [role="row"]:last-child [data-icon="msg-check"], #main [role="row"]:last-child [data-icon="msg-dblcheck"]',
};
export const MAX_BYTES = 100 * 1024 * 1024;
const BIG = 'That folder is too big to send (over 100 MB).';
const MIME = { '.pdf': 'application/pdf', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain' };
export const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // never follow links out of the folder
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) { try { out.push({ abs, size: fs.statSync(abs).size }); } catch { /* unreadable: skipped */ } }
  }
  return out;
}

// A folder → <tmp>/<name>.zip (unreadable files skipped); a file as it is. Both ≤ 100 MB.
export function zipForSend(target, { tmpDir = path.join(os.tmpdir(), 'Novi'), maxBytes = MAX_BYTES } = {}) {
  const st = fs.statSync(target);
  if (!st.isDirectory()) {
    if (st.size > maxBytes) throw new Error('That file is too big to send (over 100 MB).');
    return { file: target, name: path.basename(target), bytes: st.size };
  }
  const files = walk(target);
  if (files.reduce((n, f) => n + f.size, 0) > maxBytes) throw new Error(BIG);
  const zip = new AdmZip();
  for (const f of files) {
    try { zip.addFile(path.relative(target, f.abs).split(path.sep).join('/'), fs.readFileSync(f.abs)); } catch { /* locked: skipped */ }
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const name = `${path.basename(target)}.zip`;
  const file = path.join(tmpDir, name);
  zip.writeZip(file);
  return { file, name, bytes: fs.statSync(file).size };
}

// Who "Rahul" means among visible chat names: an exact name wins; else every word must match.
// One letter more or less ("Isha" heard, "Ishaa" saved, or the other way round) — not a different
// letter, so "Ishaa" never becomes "Ishan".
const oneOff = (a, b) => {
  if (Math.abs(a.length - b.length) !== 1 || Math.min(a.length, b.length) < 3) return false;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i += 1) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
};

export function pickContact(names, to) {
  const want = String(to).trim().toLowerCase();
  const list = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  const exact = list.filter((n) => n.toLowerCase() === want);
  if (exact.length === 1) return { name: exact[0] };
  const words = want.split(/\s+/);
  const parts = (n) => n.toLowerCase().split(/\s+/);
  let close = list.filter((n) => words.every((w) => parts(n).some((p) => p.startsWith(w))));
  if (!close.length) close = list.filter((n) => words.every((w) => parts(n).some((p) => p.startsWith(w) || oneOff(p, w))));
  if (!close.length) return { none: true };
  return close.length === 1 ? { name: close[0] } : { choose: close.slice(0, 3) };
}

// What goes in WhatsApp's search box: the first 4 letters of the first name, so "Isha" also lists
// "Ishaa" (pickContact then chooses).
export const searchWord = (to) => String(to).trim().toLowerCase().split(/\s+/)[0].slice(0, 4);

// Works in the WhatsApp tab without bringing it to the front (live 2026-10-17: the user wants it done in
// the background, not on their screen): every command names that tab. A missing tab opens in the
// background; if the typed text didn't land (some pages ignore typing while hidden), the tab comes
// to the front once and it is typed again.
const isWa = (t) => /^https:\/\/web\.whatsapp\.com/.test(t.url || '');
export function createWebDriver({ bridge, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), sendWaitMs = 20_000, log = () => {} } = {}) {
  let tabId = null;
  const ask = (cmd, args = {}, opts) => bridge.request(cmd, tabId ? { ...args, tabId } : args, opts);
  const q = async (selector) => (await ask('query', { selector })).texts || [];
  // Type into a box and check it took; else the tab to the front and once more.
  const typeIn = async (selector, text) => {
    await ask('typeSel', { selector, text });
    if (!text || ((await q(selector))[0] || '').includes(text.slice(0, 20))) return;
    log('[whatsapp] web: typing in the background did not land, bringing the tab forward');
    await bridge.request('switch', { tabId });
    await ask('typeSel', { selector, text });
  };
  let prepared = false;
  return {
    async prepare({ to, text, file }) {
      const tab = ((await bridge.request('tabs')).tabs || []).find(isWa);
      if (tab) tabId = tab.id;
      else {
        const opened = await bridge.request('open', { url: 'https://web.whatsapp.com/', newTab: true, background: true });
        tabId = opened?.tabId ?? ((await bridge.request('tabs')).tabs || []).find(isWa)?.id ?? null;
      }
      // Chrome's answer is waited for longer than the page wait itself (live: the 15 s default gave up first → "timeout").
      const loaded = async () => (await ask('waitFor', { selector: WA.ready, ms: 20_000 }, { timeoutMs: 25_000 })).found;
      const needsQr = async () => (await q(WA.qr)).length > 0;
      let ready = await loaded();
      if (!ready && !(await needsQr())) {
        // Chrome may hold back a page that is still loading in the background: bring it forward once.
        log('[whatsapp] web: still loading in the background, bringing the tab forward');
        await bridge.request('switch', { tabId });
        ready = await loaded();
      }
      if (await needsQr()) return { pause: 'qr', note: 'Scan the QR code in WhatsApp on your phone, then say done.' };
      if (!ready) return { error: "WhatsApp Web didn't finish loading in Chrome. Check it opens on the laptop, then try again." };
      const word = searchWord(to);
      await ask('typeSel', { selector: WA.search, text: word });
      await sleep(800);
      const names = await q(WA.chatTitles);
      log(`[whatsapp] web: searched "${word}", ${names.length} result(s)`);
      const pick = pickContact(names, to);
      if (pick.none) return { error: `I searched WhatsApp Web for "${word}" and nobody called ${to} came up.` };
      if (pick.choose) return { choose: pick.choose };
      await ask('clickSel', { selector: WA.chatTitles, text: pick.name });
      await sleep(600);
      const header = (await q(WA.header))[0] || '';
      if (header.trim().toLowerCase() !== pick.name.toLowerCase()) return { error: `I opened ${header || 'a different chat'} instead of ${pick.name}, so I stopped.` };
      if (file) {
        await ask('clickSel', { selector: WA.attachButton });
        await ask('attach', { selector: WA.fileInput, name: file.name, mime: mimeOf(file.name), b64: fs.readFileSync(file.file).toString('base64') }, { timeoutMs: 60_000 });
        await sleep(1000);
        if (text) await typeIn(WA.caption, text);
      } else if (text) {
        await typeIn(WA.compose, text);
      }
      prepared = true;
      return { ok: true, name: pick.name };
    },
    async send() {
      if (!prepared) return { sent: false };
      prepared = false;
      await ask('clickSel', { selector: WA.send });
      const until = Date.now() + sendWaitMs;
      do {
        if ((await q(WA.sentTick)).length) return { sent: true };
        await sleep(500);
      } while (Date.now() < until);
      return { sent: false };
    },
    async cancel() {
      prepared = false;
      try { await ask('clickSel', { selector: WA.closePreview }); } catch { /* no preview open */ }
      try { await ask('typeSel', { selector: WA.compose, text: '' }); } catch { /* nothing typed */ }
    },
  };
}
