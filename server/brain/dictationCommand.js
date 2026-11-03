// Dictation by voice (user, 2026-10-18): "type: see you at 5", "type this …", "likho …", "… likh do"
// → those exact words typed into the app in front ("… in notepad" picks the app). Messages to
// people stay with WhatsApp, notes with Novi Memory.
const SEND = /(?:[\s,]+(?:and|then|aur)?\s*(?:send(?: it)?|press enter|hit enter|search(?: it)?|bhej do|bhejo)|(?:[,.]\s*|\s+(?:and|then|aur)\s+)enter)[.!]?$/i;
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please)[, ]+)+/i;
const APPS = 'notepad|word|whatsapp|chrome|vs code|code|excel|teams|discord|telegram|gmail|docs|cursor|youtube|brave|edge|firefox|notion|slack|spotify|instagram';
const NEXT_LINE = /^(?:(?:on|in|to|go to)\s+)?(?:the\s+|a\s+)?(?:next|new|another)\s+line[.,:]?\s+(.+)$/i;
const BOXES = /^(.+?)\s+(?:in|into)\s+(?:the\s+)?((?:search|message|chat)\s+(?:box|bar))[.!?]*$/i;

// "Enter" as its own step after "type …" (2026-11-04): the words wait in the box until this. The bare
// words count only while working step by step (`steps`); "press enter" always does.
export function enterCommand(text, { steps = false } = {}) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim().toLowerCase();
  return /^(?:press|hit) enter$/.test(t) || (steps && /^(?:enter|send(?: it)?|search|go|bhej do|bhejo|next line|new line)$/.test(t));
}

// All in one sentence (2026-11-04): "open youtube type claude code and enter", "open notepad and type
// hi", "youtube kholo aur type lofi". The two halves run one after the other (agent.js).
export function chainCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  const m = /^(?:open|start|launch)\s+([\w.-]+(?:\s+(?!and\b|then\b|aur\b|type\b)[\w.-]+)?)(?:\s*,)?(?:\s+(?:and|then|aur)(?:\s+then)?)?(?:\s*,)?\s+type\s+(.+)$/i.exec(t)
    || /^([\w.-]+(?:\s+[\w.-]+)?)\s+kholo(?:\s*,)?(?:\s+(?:and|then|aur))?\s+type\s+(.+)$/i.exec(t);
  if (!m || /^(?:my|the|a|an)\b/i.test(m[1])) return null;
  return { open: `open ${m[1]}`, type: `type ${m[2]}` };
}

// "Type." alone (or "also type,"): the next sentence is the words.
export const typeNextCommand = (text) => /^(?:(?:also|and|now)\s+)?(?:type|tipe|taip|likho)[.,:!\s]*$/i.test(String(text || '').trim());

// "I have to sleep. Enter.": while working step by step, words with Enter at the end are to be typed.
export function sentenceEnter(text) {
  const m = /^(.+?)[.,]\s*enter[.!]?$/i.exec(String(text || '').trim());
  return m ? { text: m[1].trim(), enter: true } : null;
}

// "On the next line, …" with no "type" in front.
export const nextLineWords = (text) => NEXT_LINE.test(String(text || '').trim());

export function dictationCommand(text) {
  // Whisper makes up a closing "Thank you." from the quiet after a sentence.
  const t = String(text || '').trim().replace(LEAD, '').replace(/([.!?])\s+thank you[.!]?$/i, '$1');
  if (/^type (?:a |an )?(?:message|mail|email|text)\b/i.test(t) || (/\bnotes?\b/i.test(t) && /likh/i.test(t))) return null;
  const m = /^(?:type|tipe|taip)(?: this| out| it)?\s*[:,-]?\s+(.+)$/i.exec(t)
    || /^(?:likho|likh do)\s*[:,-]?\s+(.+)$/i.exec(t)
    || /^(.+?)\s+(?:likho|likh do)[.!]?$/i.exec(t);
  // '… and send' / '… aur bhej do': Enter after typing — the user's words are the yes (2026-10-29).
  const send = SEND.test(m?.[1] || '');
  // "Type again. I won't…": "again" is the instruction. "Type on the next line, …": a new line first.
  const said = m?.[1]?.replace(SEND, '').trim().replace(/^again[.,:]?\s+/i, '');
  const line = NEXT_LINE.exec(said || '');
  const words = line ? line[1].trim() : said;
  if (!words) return null;
  const inApp = new RegExp(`^(.+?)\\s+(?:in|into)\\s+(?:the\\s+)?(${APPS})(?:\\s+app)?[.!?]*$`, 'i').exec(words);
  const inBox = BOXES.exec(words);
  const out = inApp ? { text: inApp[1].trim(), app: inApp[2].toLowerCase() }
    : inBox ? { text: inBox[1].trim(), target: inBox[2].toLowerCase() } : { text: words };
  if (line) out.newLine = true;
  return send ? { ...out, enter: true } : out;
}
