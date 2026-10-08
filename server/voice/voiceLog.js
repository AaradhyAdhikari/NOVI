// Misunderstanding log (Settings → Words): every voice command with what was heard, what it
// became after your word-list fixes, and Novi's reply. The last 50 recordings are kept so a
// "Wrong" one can join your personal test set (data/voice-samples/real) for the speech benchmark.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ENTRIES = 200;
const KEEP_AUDIO = 50;
const EXT = { 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' };
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');

// The one stretch of words that differs between what was heard and what was said, as a fix.
export function suggestFix(heard, said) {
  const a = String(heard).trim().split(/\s+/).filter(Boolean);
  const b = String(said).trim().split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < a.length && start < b.length && norm(a[start]) === norm(b[start])) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && norm(a[a.length - 1 - end]) === norm(b[b.length - 1 - end])) end++;
  const from = a.slice(start, a.length - end);
  const to = b.slice(start, b.length - end);
  if (!from.length || !to.length || from.length > 3 || to.length > 3) return null;
  return { from: from.map(norm).join(' '), to: to.join(' ').replace(/[.,!?]+$/, '') };
}

export function createVoiceLog({ dir, realDir }) {
  const file = path.join(dir, 'recent.json');
  const audioDir = path.join(dir, 'audio');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* empty */ }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries));
  };
  const audioPath = (e) => path.join(audioDir, e.audio);

  return {
    add({ heard, text, audio = null, mimeType = 'audio/wav', source }) {
      const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const entry = { id, at: new Date().toISOString(), source, heard: String(heard), text: String(text), reply: null, audio: null, wrong: false, said: null };
      if (audio?.length) {
        fs.mkdirSync(audioDir, { recursive: true });
        entry.audio = `${id}.${EXT[mimeType] || 'bin'}`;
        fs.writeFileSync(audioPath(entry), audio);
      }
      entries.push(entry);
      // Older recordings go first (the text stays), then the oldest entries.
      for (const old of entries.filter((e) => e.audio).slice(0, -KEEP_AUDIO)) {
        fs.rmSync(audioPath(old), { force: true });
        old.audio = null;
      }
      entries = entries.slice(-MAX_ENTRIES);
      save();
      return id;
    },
    setReply(id, reply) {
      const e = entries.find((x) => x.id === id);
      if (!e) return;
      e.reply = String(reply || '').slice(0, 200);
      save();
    },
    recent(n = 20) {
      return entries.slice(-n).reverse().map(({ audio, ...e }) => ({ ...e, hasAudio: Boolean(audio) }));
    },
    markWrong(id, said) {
      const e = entries.find((x) => x.id === id);
      if (!e) throw new Error('That command is no longer in the log.');
      const text = String(said || '').trim();
      if (!text) throw new Error('Type what you actually said.');
      e.wrong = true;
      e.said = text;
      let saved = false;
      if (e.audio && fs.existsSync(audioPath(e))) {
        fs.mkdirSync(realDir, { recursive: true });
        fs.copyFileSync(audioPath(e), path.join(realDir, e.audio));
        const listFile = path.join(realDir, 'expected.json');
        let list = [];
        try { list = JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch { /* first one */ }
        list = [...list.filter((x) => x.file !== e.audio), { file: e.audio, said: text, heard: e.heard }];
        fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
        saved = true;
      }
      save();
      return { saved, suggestion: suggestFix(e.heard, text) };
    },
  };
}
