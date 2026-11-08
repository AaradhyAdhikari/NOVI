// Which boxes on the laptop become cards, and what a card says. The words come from other apps, so they
// are only ever shown, never followed.
// Invisible and lookalike letters must not hide a word from the checks below.
const seen = (text) => String(text || '').normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '');

const plain = (name) => String(name || '').replace(/&/g, '').replace(/[’]/g, "'").trim().toLowerCase();

const YES = ['allow once', 'allow this time', 'allow', 'approve', 'grant', 'yes'];
const NO = ['decline', 'deny', "don't allow", 'do not allow', 'block', 'reject', 'no'];

// The one-time yes, and the no. An "always" button is never chosen: a phone tap gives one permission.
export function pickButtons(names = []) {
  const find = (list) => {
    for (const want of list) {
      const hit = names.find((n) => plain(n) === want);
      if (hit) return hit;
    }
    return null;
  };
  const yes = find(YES);
  const no = find(NO);
  return yes && no ? { yes, no } : null;
}

const PRIVATE = /\b(?:passwords?|passcode|pin\b|otp|one[- ]time|card number|cvv|upi|payment|pay\b|purchase|buy|checkout|bank)\b/i;
export const isPrivateBox = ({ text = '', title = '' }) => PRIVATE.test(seen(`${title} ${text}`));

// Computer access (user, 2026-11-05: all four kinds): control, commands, a whole drive, installs and admin.
// Deleting and overwriting are here too: a tap from far away shouldn't lose a file on a plain yes.
const COMPUTER = [
  /\b(?:control|mouse|keyboard|screen(?:shot)?s?|other apps?|computer use)\b/i,
  /\b(?:terminal|shell|commands?|powershell|cmd|scripts?|run code|execute)\b/i,
  /\b(?:whole|entire) (?:drive|disk|computer)\b|\b[a-z] drive\b|\b[a-z]:[\\/]?(?=\s|$|["'|])|\b(?:home|user) folder\b|(?:^|\s)~[\\/]?(?=\s|$)/i,
  /\b(?:install|uninstall|administrator|admin|elevat\w*|sudo)\b/i,
  /\b(?:delete|erase|remove|format|overwrite|replace)\b/i,
];
export const needsPin = (text) => COMPUTER.some((re) => re.test(seen(text)));

const appName = ({ process = '', title = '' }) => {
  const name = String(process).replace(/\.exe$/i, '');
  return name ? name[0].toUpperCase() + name.slice(1) : title || 'An app';
};
// The box's question: not the window's own name or a button label (live: Notepad's card said "Notepad: Notepad").
// The line ending in "?" when there is one, else the longest.
function questionLine(box, app) {
  const skip = new Set([app, box.title, String(box.process || '').replace(/\.exe$/i, ''), ...(box.buttons || [])].filter(Boolean).map((s) => String(s).toLowerCase()));
  const lines = String(box.text || '').split(/[|\r\n]/).map((s) => s.trim()).filter((s) => s && !skip.has(s.toLowerCase()) && s.split(/\s+/).length > 1);
  const pick = lines.find((s) => s.endsWith('?')) || [...lines].sort((a, b) => b.length - a.length)[0] || '';
  return pick.replace(/[.!?:]+$/, '').slice(0, 90);
}

// All of its words: a box that changes is a new question and gets a new card.
export const boxKey = (box) => `${box.hwnd}:${box.process || ''}:${[...(box.buttons || [])].sort().join('+')}:${box.text || ''}`;

export function cardFor(box) {
  const app = appName(box);
  const line = questionLine(box, app);
  const words = String(box.text || '').split('|').map((s) => s.trim()).filter(Boolean).join('\n').slice(0, 600);
  return {
    tag: boxKey(box),
    title: `${app}: ${line || 'asks for your OK'}`,
    prompt: `${app} asks: ${line || 'for your OK'}.`,
    detail: `${words}${words ? '\n\n' : ''}In the window: ${box.title || app}`,
    detailLabel: 'Show the whole box',
    tier: 'medium',
    // Words cut off could hide anything.
    pin: Boolean(box.cut) || needsPin(`${box.title || ''} ${box.text || ''}`),
    grantable: false,
    timeoutMs: null,
    source: 'watch',
    category: 'watch',
  };
}
