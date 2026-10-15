// Safety levels for a PowerShell command line Novi wants to run (spec: laptop commands, §B).
//   never  → refused (turning off protection, download-and-run, wiping disks/backups/logs, boot)
//   danger → yes + voice PIN (delete, registry, services, firewall, users, installs, tasks, admin)
//   look   → runs at once (every part only reads)
//   change → yes (everything else — anything not provably look-only)
import fs from 'node:fs';

const LIST = JSON.parse(fs.readFileSync(new URL('./readList.json', import.meta.url), 'utf8'));
export const READ_COMMANDS = new Set([...LIST.cmdlets, ...LIST.programs]);
const NOT_LOOK = new Set(LIST.notLook);
// Any get-* cmdlet reads (except get-credential, which prompts); plus the list.
export const isReadCommand = (name) => { const n = String(name || '').toLowerCase(); return !NOT_LOOK.has(n) && (READ_COMMANDS.has(n) || n.startsWith('get-')); };

const ALIASES = {
  dir: 'get-childitem', ls: 'get-childitem', gci: 'get-childitem', cat: 'get-content', gc: 'get-content', type: 'get-content',
  ps: 'get-process', gps: 'get-process', gi: 'get-item', gp: 'get-itemproperty', gwmi: 'get-wmiobject', gsv: 'get-service',
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item', ri: 'remove-item',
  mv: 'move-item', move: 'move-item', mi: 'move-item', cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item',
  ren: 'rename-item', rni: 'rename-item', kill: 'stop-process', spps: 'stop-process', iex: 'invoke-expression',
  iwr: 'invoke-webrequest', curl: 'invoke-webrequest', wget: 'invoke-webrequest', irm: 'invoke-restmethod',
  '%': 'foreach-object', foreach: 'foreach-object', '?': 'where-object', where: 'where-object', sc: 'set-content',
  ni: 'new-item', md: 'new-item', mkdir: 'new-item', select: 'select-object', sort: 'sort-object', measure: 'measure-object',
  echo: 'write-output', write: 'write-output', saps: 'start-process', start: 'start-process', icm: 'invoke-command',
};

// Strings out (they hold data, not commands), then split at every place a new command can start.
const stripStrings = (s) => s.replace(/"(?:[^"`]|`.)*"/g, '""').replace(/'(?:[^']|'')*'/g, "''");
export function commandWords(command) {
  const bare = stripStrings(String(command || ''));
  return bare.split(/[;|&\n{}()]|\$\(|@\(/).map((seg) => seg.trim()).filter(Boolean).map((seg) => {
    const first = seg.split(/\s+/)[0];
    if (first === '%' || first === '?') return ALIASES[first];
    if (!/^[a-z]/i.test(first)) return null; // $var, [Type]::, .Property, numbers: not a command
    const word = first.toLowerCase().replace(/\.exe$/, '');
    return ALIASES[word] || word;
  }).filter(Boolean);
}

const NEVER = [
  [/set-mppreference\b[^\n]*-disable/i, 'it would turn off your antivirus'],
  [/add-mppreference\b[^\n]*-exclusion/i, 'it would hide files from your antivirus'],
  [/netsh\s+advfirewall\b[^\n]*\bstate\s+off/i, 'it would turn off your firewall'],
  [/set-netfirewallprofile\b[^\n]*-enabled\s+(?:\$?false|0)\b/i, 'it would turn off your firewall'],
  [/\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-e(?:c|nc|ncodedcommand)?\s/i, 'it hides what it runs'],
  [/frombase64string[\s\S]*(?:\biex\b|invoke-expression|scriptblock)|(?:\biex\b|invoke-expression|scriptblock)[\s\S]*frombase64string/i, 'it hides what it runs'],
  [/\bvssadmin\b[^\n]*\bdelete\b|\bwbadmin\b[^\n]*\bdelete\b/i, 'it would delete your backups'],
  [/\bbcdedit\b/i, 'it changes how Windows starts'],
  [/(?:^|[;|&]\s*)format(?:\.com)?\s+[a-z]:|\bformat-volume\b|\bclear-disk\b|\bdiskpart\b|\bcipher\b[^\n]*\/w/i, 'it would wipe a disk'],
  [/\bclear-eventlog\b|\bwevtutil\b[^\n]*\bcl\b/i, 'it would erase the Windows logs'],
];
const DOWNLOAD = /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|downloadstring|downloadfile|net\.webclient|start-bitstransfer)\b/i;
const RUN_TEXT = /\b(?:iex|invoke-expression)\b|\|\s*(?:powershell|pwsh|cmd)\b|scriptblock\]::create/i;
const PROTECTED = /c:\\windows\b|c:\\program files|\$env:(?:systemroot|windir|programfiles)|(?:^|\s)['"]?[a-z]:\\?['"]?(?=\s|$)/i;

const DANGER = new Set(['remove-item', 'clear-content', 'clear-recyclebin', 'set-itemproperty', 'new-itemproperty', 'remove-itemproperty', 'rename-itemproperty',
  'set-service', 'stop-service', 'start-service', 'restart-service', 'suspend-service', 'new-service', 'remove-service',
  'new-netfirewallrule', 'set-netfirewallrule', 'remove-netfirewallrule', 'enable-netfirewallrule', 'disable-netfirewallrule',
  'new-localuser', 'remove-localuser', 'set-localuser', 'add-localgroupmember', 'remove-localgroupmember',
  'choco', 'msiexec', 'schtasks', 'register-scheduledtask', 'unregister-scheduledtask', 'set-executionpolicy',
  'takeown', 'icacls', 'stop-computer', 'restart-computer', 'invoke-expression', 'invoke-command']);
const SAFE_TYPES = /^\[(?:math|datetime|system\.math|system\.datetime)\]::|^\[environment\]::getfolderpath\(/i;
export const SAFE_METHODS = new Set(['tostring', 'toupper', 'tolower', 'trim', 'split', 'replace', 'substring', 'contains', 'startswith', 'endswith', 'round', 'equals', 'gettype', 'tostring', 'padleft', 'padright', 'indexof', 'getfolderpath', 'adddays', 'addhours']);

function dangerReason(words, raw) {
  for (const w of words) {
    if (DANGER.has(w)) return `it uses ${w}`;
    if (w === 'reg' && /\breg(?:\.exe)?\s+(?:add|delete|import|copy|restore|load|unload)\b/i.test(raw)) return 'it changes the registry';
    if (w === 'sc' && /\bsc\.exe\b/i.test(raw)) return 'it changes a service';
    if (w === 'netsh' && /\badvfirewall\b/i.test(raw)) return 'it changes the firewall';
    if (w === 'net' && /\bnet\s+(?:user|localgroup)\b/i.test(raw)) return 'it changes user accounts';
    if (w === 'winget' && /\bwinget\s+(?:install|uninstall|upgrade|import)\b/i.test(raw)) return 'it installs or removes software';
    if (/^(?:install|uninstall)-/.test(w)) return 'it installs or removes software';
    if (w === 'start-process' && /-verb\s+['"]?runas/i.test(raw)) return 'it asks for admin rights';
    if ((w === 'invoke-webrequest' || w === 'invoke-restmethod') && /-outfile\b|-method\s+['"]?(?:post|put|delete|patch)/i.test(raw)) return 'it downloads or sends data';
  }
  return null;
}

function lookProblem(words, bare) {
  for (const w of words) {
    if (w === 'wmic') { if (/\b(?:call|delete|set|create)\b/i.test(bare)) return 'wmic can change things'; continue; }
    if (!isReadCommand(w)) return `${w} is not on the read-only list`;
  }
  if (/>/.test(bare.replace(/-(?:gt|ge)\b/gi, ''))) return 'it writes to a file';
  if (/(?:^|\s)-force\b/i.test(bare)) return 'it uses -Force';
  // Read-only programs and Get- commands that still change things with some switches.
  if (/\bipconfig\b[^|;]*\/(?:release|renew|flushdns|registerdns|setclassid)/i.test(bare)) return 'ipconfig with a switch that changes the network';
  if (/(?:^|\s)-(?:install|acceptall|download|autoreboot|delete|remove|kill|stop|reset|clear)\b/i.test(bare)) return 'a switch that changes things';
  for (const m of bare.matchAll(/\[[\w.]+\]::\w+\(?/g)) if (!SAFE_TYPES.test(m[0])) return `it calls ${m[0]}`;
  for (const m of bare.matchAll(/\.(\w+)\(/g)) if (!SAFE_METHODS.has(m[1].toLowerCase())) return `it calls .${m[1]}()`;
  if (/(?:^|[;|{(]\s*)[&.]\s/.test(bare)) return 'it runs another script';
  return null;
}

export function classify(command) {
  const raw = String(command || '').trim();
  if (!raw) return { level: 'change', reason: 'empty command' };
  for (const [pattern, reason] of NEVER) if (pattern.test(raw)) return { level: 'never', reason };
  if (DOWNLOAD.test(raw) && RUN_TEXT.test(raw)) return { level: 'never', reason: 'it would download and run code' };
  const words = commandWords(raw);
  if (words.includes('remove-item') && PROTECTED.test(raw)) return { level: 'never', reason: 'it would delete Windows, your programs or a whole drive' };
  const danger = dangerReason(words, raw);
  if (danger) return { level: 'danger', reason: danger };
  if (!words.length) return { level: 'change', reason: 'no command found' };
  const problem = lookProblem(words, stripStrings(raw));
  return problem ? { level: 'change', reason: problem } : { level: 'look', reason: 'it only reads' };
}
