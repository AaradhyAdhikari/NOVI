import path from 'node:path';

// What a commit card shows and what it must never send. The repo may be public, and other projects may
// have no .gitignore, so private files are left out here too, not only by .gitignore.
const baseOf = (file) => path.posix.basename(String(file).replace(/\\/g, '/'));

export function isPrivateFile(file) {
  const where = String(file).replace(/\\/g, '/').toLowerCase();
  if (/^data\//.test(where) || /(?:^|\/)\.(?:aws|ssh|gnupg)\//.test(where)) return true;
  const name = baseOf(file).toLowerCase();
  if (name === '.npmrc' || name === '.netrc') return true;
  if (/^\.env(?:\..+)?$/.test(name)) return !/\.(?:example|sample|template)$/.test(name);
  return name === 'novi context.txt'
    || /\.(?:pem|key|pfx|p12|jks|keystore)$/.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)
    || /(?:secret|credential|password)s?[^/]*\.(?:json|txt|ya?ml|env)$/.test(name);
}

const KEY_IN_TEXT = [
  /\b(?:sk|gsk|csk|ghp|gho|ghs|hf|jina|tvly|xox[abp])[-_][A-Za-z0-9_-]{20,}/,
  /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*['"]?[A-Za-z0-9_\-+/]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

// The first file whose added lines hold a key, from `git diff --cached -U0`.
export function fileWithKey(diff) {
  let file = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '').trim();
    else if (line.startsWith('+') && KEY_IN_TEXT.some((re) => re.test(line))) return file;
  }
  return null;
}

// `git status --porcelain -z --no-renames`: every changed path.
export const parseStatus = (text) => String(text || '').split('\0').filter(Boolean).map((row) => row.slice(3));
export const parseNames = (text) => String(text || '').split('\0').filter(Boolean);

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function namesMessage(files) {
  const names = files.slice(0, 2).map(baseOf);
  const more = files.length - names.length;
  return `Update ${names.join(' and ')}${more ? ` and ${more} more` : ''}`.slice(0, 72);
}

// One line, or null when the AI's answer can't be a commit message.
export function cleanMessage(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const clean = line.replace(/^(?:commit message:\s*)/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  return clean.length >= 4 ? clean.slice(0, 72) : null;
}

// "the message to Fix the cart" → "Fix the cart".
export const changedMessage = (words) => cleanMessage(String(words || '').replace(/^(?:the\s+)?(?:commit\s+)?message\s*(?:to|:|is)?\s*/i, '').replace(/^(?:to|as)\s+/i, ''));
