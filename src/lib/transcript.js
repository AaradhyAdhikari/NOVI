// The server keeps only text in its transcript (pictures are too big to resend on every refresh),
// so a refreshed list keeps the pictures, videos and links this page already received.
const EXTRAS = ['image', 'video', 'link', 'code'];
const key = (e) => `${e.at}|${e.role}|${e.text}`;

export function mergeTranscript(shown, fromServer) {
  if (!fromServer) return shown;
  const had = new Map(shown.filter((e) => EXTRAS.some((k) => e[k])).map((e) => [key(e), e]));
  const waiting = shown.filter((e) => e.pending); // sent, not echoed yet
  return [...fromServer.map((e) => {
    const old = had.get(key(e));
    if (!old) return e;
    const extra = {};
    for (const k of EXTRAS) if (old[k] && !e[k]) extra[k] = old[k];
    return { ...e, ...extra };
  }), ...waiting];
}

// What the user typed or said shows at once (live 2026-10-20 it waited for Novi's echo); the echo takes
// its place when it comes.
export const addPending = (list, text) => [...list, { role: 'user', text, at: new Date().toISOString(), pending: true }].slice(-100);

export function addChat(list, entry) {
  const i = entry.role === 'user' ? list.findIndex((e) => e.pending && e.text === entry.text) : -1;
  if (i < 0) return [...list, entry].slice(-100);
  return [...list.slice(0, i), entry, ...list.slice(i + 1)];
}

// A link in the chat reads "Open …" — once, even when its label already starts with "Open".
export const linkLabel = (text) => (/^open\b/i.test(String(text || '').trim()) ? String(text).trim() : `Open ${text || 'link'}`);
