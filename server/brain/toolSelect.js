// Sends the model only the tools a request needs. All ~40 tool schemas cost ~3,900 tokens per
// call — more than Groq's free per-minute budget allows for a tool turn (two calls).
const ALWAYS = new Set(['memory_remember', 'memory_recall', 'open_app', 'open_website', 'clock_now']);

// Tools that belong together (a match on one brings the whole group).
const GROUP = {
  play_youtube: 'youtube', youtube_search: 'youtube',
  open_project: 'ide', list_projects: 'projects', remember_project: 'projects', forget_project: 'projects',
  timer_set: 'reminder', conversation_history: 'memory',
};
const groupOf = (name) => GROUP[name] || name.split('_')[0];

// Everyday words → tool groups.
const WORDS = {
  weather: 'weather temperature rain raining forecast hot cold humid humidity sunny umbrella climate',
  gmail: 'gmail email emails mail mails inbox reply unread',
  youtube: 'youtube video videos song songs music play playing lofi watch',
  reminder: 'remind reminder reminders timer timers alarm alarms wake',
  github: 'github repo repos repository issue issues pr prs pull notification notifications commit commits',
  ide: 'cursor vscode antigravity kiro editor ide claude',
  projects: 'project projects folder',
  code: 'fix bug bugs build implement refactor tests coding coder feature',
  memory: 'remember forget memory memories told yesterday earlier talked said ago',
  backup: 'backup backups',
  clock: 'announce announcement',
  accounts: 'account accounts',
  screen: 'screen click type press key button window whatsapp notepad look see showing tab',
};
const WORD_GROUP = new Map(Object.entries(WORDS).flatMap(([g, words]) => words.split(' ').map((w) => [w, g])));
// Words in tool names too generic to pick a group on their own.
const GENERIC = new Set('get read add list status now set open search start stop connect cancel create mark comment rename default allow edits message task app send'.split(' '));

const words = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

function groupsFor(text, nameWords) {
  const found = new Set();
  for (const w of words(text)) {
    if (WORD_GROUP.has(w)) found.add(WORD_GROUP.get(w));
    if (nameWords.has(w)) for (const g of nameWords.get(w)) found.add(g);
  }
  return found;
}

export function selectTools(schemas, { text, history = [], taskActive = false } = {}) {
  // Distinctive words from tool names (e.g. "weather", "gmail", "send") also pick their group.
  const nameWords = new Map();
  for (const s of schemas) {
    for (const w of s.function.name.split('_')) {
      if (w.length < 3 || (GENERIC.has(w) && w !== 'send')) continue;
      if (!nameWords.has(w)) nameWords.set(w, new Set());
      nameWords.get(w).add(groupOf(s.function.name));
    }
  }
  const groups = groupsFor(text, nameWords);
  // Follow-ups ("yes, send it", "the second one") keep the tools of the previous exchange.
  for (const g of groupsFor(history.slice(-2).map((m) => m.content).join(' '), nameWords)) groups.add(g);
  if (taskActive) groups.add('code');
  return schemas.filter((s) => ALWAYS.has(s.function.name) || groups.has(groupOf(s.function.name)));
}
