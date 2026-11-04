// "Commit my work" / "push my code" / "pull my code", by voice without the AI (plugins/commit).
// Committing still shows its card; the words only ask for it.
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const name = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').replace(/\s+(?:project|app|site|code)$/i, '').trim();
const WHERE = String.raw`(?:\s+(?:on|in|for|of)\s+(.+?))?`;
const WORK = String.raw`(?:my |the |our |all (?:my |the )?)?(?:work|changes|code)`;
const KARO = String.raw`kar(?:o| do| dena)`;

const PULL = new RegExp(String.raw`^(?:git pull|pull ${WORK}|pull (?:it |the latest )?from github|pull the latest|get (?:me )?the latest(?: code| changes)?(?: from github)?|(?:github se |code )pull ${KARO})${WHERE}$`, 'i');
const COMMIT = [
  new RegExp(String.raw`^(?:commit and push|commit|push) ${WORK}(?: to github)?${WHERE}$`, 'i'),
  new RegExp(String.raw`^save ${WORK} to github${WHERE}$`, 'i'),
  new RegExp(String.raw`^push (?:it )?to github${WHERE}$`, 'i'),
  new RegExp(String.raw`^(?:code |changes? )?(?:commit|push) ${KARO}()$`, 'i'),
  new RegExp(String.raw`^github pe push ${KARO}()$`, 'i'),
];
const NAMED = /^(?:commit|push|commit and push) (?:my |the )(.+?) project$/i;

export function commitCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  const asked = (tool, x) => ({ tool, args: x ? { project: name(x) } : {} });
  let m;
  if ((m = PULL.exec(t))) return asked('code_pull', m[1]);
  for (const re of COMMIT) if ((m = re.exec(t))) return asked('code_commit', m[1]);
  if ((m = NAMED.exec(t))) return asked('code_commit', m[1]);
  return null;
}
