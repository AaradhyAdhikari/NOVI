// Dictation by voice (user, 2026-10-18): "type: see you at 5", "type this …", "likho …", "… likh do"
// → those exact words typed into the app in front ("… in notepad" picks the app). Messages to
// people stay with WhatsApp, notes with Novi Memory.
const SEND = /[\s,]+(?:and|then|aur)?\s*(?:send(?: it)?|press enter|hit enter|search(?: it)?|bhej do|bhejo)[.!]?$/i;
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please)[, ]+)+/i;
const APPS = 'notepad|word|whatsapp|chrome|vs code|code|excel|teams|discord|telegram|gmail|docs|cursor';

export function dictationCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '');
  if (/^type (?:a |an )?(?:message|mail|email|text)\b/i.test(t) || (/\bnotes?\b/i.test(t) && /likh/i.test(t))) return null;
  const m = /^type(?: this| out| it)?\s*[:,-]?\s+(.+)$/i.exec(t)
    || /^(?:likho|likh do)\s*[:,-]?\s+(.+)$/i.exec(t)
    || /^(.+?)\s+(?:likho|likh do)[.!]?$/i.exec(t);
  // '… and send' / '… aur bhej do': Enter after typing — the user's words are the yes (2026-10-29).
  const send = SEND.test(m?.[1] || '');
  const words = m?.[1]?.replace(SEND, '').trim();
  if (!words) return null;
  const inApp = new RegExp(`^(.+?)\\s+(?:in|into)\\s+(?:the\\s+)?(${APPS})(?:\\s+app)?[.!?]*$`, 'i').exec(words);
  const out = inApp ? { text: inApp[1].trim(), app: inApp[2].toLowerCase() } : { text: words };
  return send ? { ...out, enter: true } : out;
}
