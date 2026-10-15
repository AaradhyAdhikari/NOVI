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
export function pickContact(names, to) {
  const want = String(to).trim().toLowerCase();
  const list = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  const exact = list.filter((n) => n.toLowerCase() === want);
  if (exact.length === 1) return { name: exact[0] };
  const words = want.split(/\s+/);
  const close = list.filter((n) => words.every((w) => n.toLowerCase().split(/\s+/).some((p) => p.startsWith(w))));
  if (!close.length) return { none: true };
  return close.length === 1 ? { name: close[0] } : { choose: close.slice(0, 3) };
}

export function createWebDriver({ bridge, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), sendWaitMs = 20_000 } = {}) {
  const q = async (selector) => (await bridge.request('query', { selector })).texts || [];
  let prepared = false;
  return {
    async prepare({ to, text, file }) {
      const tab = ((await bridge.request('tabs')).tabs || []).find((t) => /^https:\/\/web\.whatsapp\.com/.test(t.url || ''));
      if (tab) await bridge.request('switch', { tabId: tab.id });
      else await bridge.request('open', { url: 'https://web.whatsapp.com/', newTab: true });
      await bridge.request('waitFor', { selector: WA.ready, ms: 20_000 });
      if ((await q(WA.qr)).length) return { pause: 'qr', note: 'Scan the QR code in WhatsApp on your phone, then say done.' };
      await bridge.request('typeSel', { selector: WA.search, text: to });
      await sleep(800);
      const pick = pickContact(await q(WA.chatTitles), to);
      if (pick.none) return { error: `I can't find ${to} on WhatsApp.` };
      if (pick.choose) return { choose: pick.choose };
      await bridge.request('clickSel', { selector: WA.chatTitles, text: pick.name });
      await sleep(600);
      const header = (await q(WA.header))[0] || '';
      if (header.trim().toLowerCase() !== pick.name.toLowerCase()) return { error: `I opened ${header || 'a different chat'} instead of ${pick.name}, so I stopped.` };
      if (file) {
        await bridge.request('clickSel', { selector: WA.attachButton });
        await bridge.request('attach', { selector: WA.fileInput, name: file.name, mime: mimeOf(file.name), b64: fs.readFileSync(file.file).toString('base64') }, { timeoutMs: 60_000 });
        await sleep(1000);
        if (text) await bridge.request('typeSel', { selector: WA.caption, text });
      } else if (text) {
        await bridge.request('typeSel', { selector: WA.compose, text });
      }
      prepared = true;
      return { ok: true, name: pick.name };
    },
    async send() {
      if (!prepared) return { sent: false };
      prepared = false;
      await bridge.request('clickSel', { selector: WA.send });
      const until = Date.now() + sendWaitMs;
      do {
        if ((await q(WA.sentTick)).length) return { sent: true };
        await sleep(500);
      } while (Date.now() < until);
      return { sent: false };
    },
    async cancel() {
      prepared = false;
      try { await bridge.request('clickSel', { selector: WA.closePreview }); } catch { /* no preview open */ }
      try { await bridge.request('typeSel', { selector: WA.compose, text: '' }); } catch { /* nothing typed */ }
    },
  };
}
