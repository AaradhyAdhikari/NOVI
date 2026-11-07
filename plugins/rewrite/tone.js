// Per-app tone (checklist row "Per-app tone"): the app in front picks how dictated words are polished. Only
// the kind of app goes further. Window titles are "<page> - <app> - <browser>", so an app counts only as the
// first or last part: a video called "How to use WhatsApp" is not WhatsApp.
const BROWSER = /^(?:google chrome|chrome|brave|microsoft\s*edge|edge|firefox|mozilla firefox|opera|vivaldi|arc)$/i;
const COUNT = /^\(\d+\+?\)\s*/;
const APPS = [
  ['chat', /^(?:whatsapp(?: web)?|telegram(?: web)?|discord|slack|signal|messenger|instagram|(?:microsoft )?teams)$/i],
  ['email', /^(?:gmail|outlook|mail|yahoo mail|proton mail|thunderbird)$/i],
  ['code', /^(?:visual studio code|vs code|visual studio|cursor|antigravity|kiro|zed|intellij idea|pycharm|webstorm|android studio|sublime text|notepad\+\+|windows powershell|powershell|command prompt|windows terminal|terminal)$/i],
];

export function toneFor(title) {
  const parts = String(title || '').replace(/[​-‏]/g, '').split(/\s+[-–—|]\s+/).map((p) => p.replace(COUNT, '').trim()).filter((p) => p && !BROWSER.test(p));
  if (!parts.length) return null;
  const ends = [parts[parts.length - 1], parts[0]];
  for (const name of ends) for (const [tone, re] of APPS) if (re.test(name)) return tone;
  return null;
}

const LINES = {
  chat: ' Keep it casual and short, like a text message. Do not add a greeting or sign-off.',
  email: ' Use a polite, professional tone in complete sentences. Do not add a greeting or sign-off that was not said.',
  code: ' This is for a code editor: keep code words, file names and commands exactly as they are. Do not add a final full stop.',
};
export const toneLine = (tone) => LINES[tone] || '';
