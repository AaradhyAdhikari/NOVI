// The done-check's checklist, from the brief Claude built against (no AI): each "Done when" line is one
// check, "Look & feel" is one visual check. The kind comes from the words.

// Never tried by Novi: these touch real accounts, money or the outside world.
const MANUAL = /\b(?:log ?in|logs? in|sign(?:s|ed)? ?(?:in|up)|password|payments?|pay|checkout|e-?mails?|sms|otp|deploy\w*|hosting|hosted|external api|third[- ]party|real data|stripe|razorpay|paypal|webhook)\b/i;
// Novi tries these in the page: someone types / clicks / picks something and the page answers.
const FUNCTIONAL = /\b(?:typ(?:e|es|ing)|click\w*|tap\w*|choos\w*|select\w*|enter\w*|submit\w*|calculat\w*|convert\w*|adds?|adding|saves?|saving|filter\w*|search\w*|sorts?|sorting|toggl\w*|delet\w*|remov\w*|reset\w*|splits?|splitting|updates? (?:the|when|live))\b|\bshows?\b.*\bwhen\b|\bwhen\b.*\bshows?\b/i;
// Checked from the page itself: loads, errors, speed.
const TECHNICAL = /\b(?:loads?|loading|errors?|console|builds?|compil\w*|fast|speed|performance|offline|lighthouse|crash\w*)\b/i;

// Clearly about the build itself: these win over a passing "calculation" (live, Tip calculator brief).
const BUILD = /\b(?:console|builds?|compil\w*|tests? pass|lighthouse)\b/i;

export function kindOf(text) {
  const t = String(text || '');
  if (MANUAL.test(t)) return 'manual';
  if (BUILD.test(t)) return 'technical';
  if (FUNCTIONAL.test(t)) return 'functional';
  if (TECHNICAL.test(t)) return 'technical';
  return 'visual';
}

// "## Done when (ChatGPT)" → { 'done when': '…' } (the brief always writes "## Heading (source)").
function parts(brief) {
  const out = {};
  let current = null;
  for (const line of String(brief || '').split('\n')) {
    const h = /^##\s+(.+?)(?:\s+\([^)]*\))?\s*$/.exec(line);
    if (h) { current = h[1].trim().toLowerCase(); out[current] = []; } else if (current) out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

const missing = (s) => !s || /^\((?:not given|missing\b)/i.test(s);

export function checksFrom(brief) {
  const p = parts(brief);
  const done = p['done when'];
  if (missing(done)) return [];
  const lines = done.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim()).filter(Boolean);
  const checks = lines.map((text) => ({ text, kind: kindOf(text) }));
  const look = p['look & feel'] || p['look and feel'];
  if (!missing(look)) checks.push({ text: `Looks like the brief: ${look.replace(/\s+/g, ' ').slice(0, 300)}`, kind: 'visual' });
  return checks.map((c, i) => ({ id: `c${i + 1}`, ...c }));
}
