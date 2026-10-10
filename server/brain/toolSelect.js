// Sends the model only the tools a request needs. All ~40 tool schemas cost ~3,900 tokens per
// call — more than Groq's free per-minute budget allows for a tool turn (two calls).
export const ALWAYS = new Set(['memory_remember', 'memory_recall', 'open_app', 'open_website', 'clock_now']);

// Tools that belong together (a match on one brings the whole group).
const GROUP = {
  play_youtube: 'youtube', youtube_search: 'youtube',
  open_project: 'ide', list_projects: 'projects', remember_project: 'projects', forget_project: 'projects',
  timer_set: 'reminder', conversation_history: 'memory',
  project_next: 'projects', rename_project: 'projects', study_log: 'sheets', sheets_log_link: 'sheets',
};
const groupOf = (name) => GROUP[name] || name.split('_')[0];

// Everyday words → tool groups.
const WORDS = {
  weather: 'weather temperature rain raining forecast hot cold humid humidity sunny umbrella climate mausam mosam barish baarish havaman हवामान मौसम पाऊस बारिश तापमान',
  gmail: 'gmail email emails mail mails inbox reply unread',
  youtube: 'youtube video videos song songs music play playing lofi watch',
  reminder: 'remind reminder reminders timer timers alarm alarms wake utha uthana uthade jaga jagana jagade yaad',
  github: 'github repo repos repository issue issues pr prs pull notification notifications commit commits contribution contributions',
  ide: 'cursor vscode antigravity kiro editor ide claude',
  projects: 'project projects folder leave left progress far continue rename',
  // "claude" is in both ide and code: "open X in Claude and do Y" may open it and start a task.
  code: 'code html css javascript jsx fix bug bugs build implement refactor tests coding coder feature claude back takeover sambhal add bana banao karwa karwao change mode page button',
  memory: 'remember forget memory memories told yesterday earlier talked said ago',
  backup: 'backup backups drive',
  sheets: 'study studied studying log logged hours sheet sheets spreadsheet',
  clock: 'announce announcement',
  accounts: 'account accounts',
  // "make a project named X in Claude": doing things inside an app = screen control.
  screen: 'screen click type press key button window whatsapp notepad look see showing tab screenshot screenshots ss picture photo image snapshot capture make create named inside',
  briefing: 'briefing brief morning agenda summary day',
  calendar: 'calendar meeting meetings event events schedule free busy appointment lecture class classes plans',
  tasks: 'task tasks todo todos to-do list lists done complete finished',
};
// A word can pick several groups.
const WORD_GROUP = new Map();
for (const [g, list] of Object.entries(WORDS)) {
  for (const w of list.split(' ')) WORD_GROUP.set(w, [...(WORD_GROUP.get(w) || []), g]);
}
// Words in tool names too generic to pick a group on their own.
const GENERIC = new Set('get read add list status now set open search start stop connect cancel create mark comment rename default allow edits message task app send show'.split(' '));

// \p{M}: Hindi / Marathi vowel signs (ा, े) are part of the word, not a break.
const words = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];

function groupsFor(text, nameWords) {
  const found = new Set();
  for (const w of words(text)) {
    for (const g of WORD_GROUP.get(w) || []) found.add(g);
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

// Short questions that need only the always-on basics (time, small talk, open an app, recall a memory)
// go to the quick lane: a small fast model (Groq gpt-oss-20b, low reasoning), falling back to bigger ones.
export function isQuickTurn(text, offered, { taskActive = false } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return !taskActive && words > 0 && words <= 12 && offered.every((s) => ALWAYS.has(s.function.name));
}
