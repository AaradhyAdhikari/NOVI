import { AllProvidersUnavailableError } from './router.js';
import { selectTools, isQuickTurn, ALWAYS } from './toolSelect.js';
import { classifyApproval } from '../grants.js';
import { UserFacingError } from '../errors.js';
import { firstSentence } from '../narrator.js';
import { answerKind } from './answers.js';
import { matchAnswer, answerFor } from '../claude/questions.js';
import { FILE_LEAD, FILE_TAIL } from './phrases.js';
import { controlCommand, isCancelWord, historyCommand, diskCommand, keysCommand } from './controlCommand.js';
import { browserCommand, isDoneWord } from './browserCommand.js';
import { previewCommand, openCommand } from './previewCommand.js';
import { browseCommand } from './browseCommand.js';
import { chatgptCommand } from './chatgptCommand.js';
import { sameCommand } from './sameCommand.js';
import { replyFrom } from './shortcuts.js';
import { briefCommand, changeCommand } from './briefCommand.js';
import { dictationCommand } from './dictationCommand.js';
import { claudeLinkCommand, linkFolderCommand, projectStatusCommand, projectAboutCommand } from './claudeLinkCommand.js';
import { describeTurn } from '../activity.js';
import { learningCommand } from './learning.js';
import { quietCommand } from '../quiet.js';
import path from 'node:path';
import fs from 'node:fs';

// Asked for directly, these just run even though they can't be "always allowed" in Settings
// (code_start_task: the user already named Claude). Moving files Novi picked always asks.
// "What went wrong?" (the activity log) and "what's running?" — answered without the AI.
const WRONG_RE = /^(?:what went wrong|what happened(?: last time| just now| there)?|why didn'?t (?:that|it|this) work|why did (?:that|it) fail|kya (?:galat )?hua(?: tha)?|kya gadbad hui)$/i;
const RUNNING_RE = /^(?:what(?:'s| is) (?:running|going on|happening)(?: right now)?|what are you (?:doing|working on)(?: right now)?|(?:sab )?kya (?:kya )?chal raha hai|anything running)$/i;
const DIRECT_OK = new Set(['code_start_task', 'code_send_message', 'rename_project', 'file_new_folder', 'open_project', 'file_open', 'file_rename', 'note_write', 'notes_ask', 'note_open', 'whatsapp_send', 'claude_project_make', 'remember_project']); // whatsapp_send: the user's decision 2026-10-17 — their command is the yes
const ASK_ANYWAY = new Set(['file_gather', 'file_undo_move', 'laptop_run', 'preview_show', 'preview_open']); // preview_show/open: only its first start of a project's own command asks
const MAX_ROUNDS = 10; // screen tasks: open the app, look, click, type, …
const MAX_HISTORY = 40;
const SUMMARY_AT = 20; // with a summarizer, history past this many messages folds its oldest 10 into one line

export function systemPrompt({ projects, task, accounts = [] }) {
  return [
    'You are Novi, a voice-first personal AI companion. Your replies are spoken aloud: answer in 1-2 short, natural sentences (about 25 words), with no markdown, lists, code or links; never offer more help at the end. Details and links only when asked.',
    "You control a coding agent on the user's laptop through tools. For coding work on a project, call code_start_task with the project name and a clear, complete instruction for the coding agent. For follow-ups and changes to the current or most recent task, even while it is running ('make the button blue', 'add dark mode'), call code_send_message. To show code ('show me the HTML'), call code_show. To start a brand-new project, call code_new_project. Use code_status for progress questions and code_stop to stop.",
    'If the user mentions a project you do not know, ask for its folder path, then call remember_project.',
    'You can also act directly: open_website (use a full https URL when you know the site) and play_youtube open things right away on the device the user is using; open_app opens installed apps on the laptop. To watch or play anything ("show me valorant", "play X"), call play_youtube (top result by default; position for "the 5th one"); use youtube_search only when the user asks to see the options. Never read out a list of videos; after playing, just say the title. To log in, fill a form, click or read a page on a website, use browser_open and the other browser_* tools (Chrome on the laptop), not open_website. LeetCode problems and stats come from the leetcode tools; never play a video for LeetCode. The user\'s own projects and apps ("my X app", their GitHub repos, claude.ai projects) are never searched on the web or opened as a Google search: use project_about (what it is), project_status (progress) or github_repo. To skip forward/back or jump to a time in a video or song, use laptop_seek.',
    'To do something inside an app on the laptop that has no tool of its own (e.g. "open Claude and make a project named X"), do it yourself step by step: open_app, then screen_items, screen_click, screen_type and screen_key until it is done. Do not stop after opening the app or tell the user to do it.',
    'For anything visible on the laptop screen in any app or browser (e.g. Brave, Kick, YouTube, WhatsApp): "play the first video", "click X", "open that stream" — call screen_items (a numbered list of the links, buttons and video tiles, no app name needed), then screen_click with the number. Use screen_look only to describe the screen. To send or copy "this page / this video / the current website", use laptop_current_link.',
    'Deleting a file or folder: only file_delete (it asks for the PIN). Never delete with screen control (keys, clicks) or laptop_run. "Open X" without the word file or folder is never file_open: a coding project → preview_open (its website), "open X in VS Code / Antigravity / Cursor…" → open_project with that editor, anything else → open_app. Files: file_find / file_open find and open files and folders on the laptop by name when the user says file, folder or a document type; file_summary reads a file or Google Sheet in the background, so say you are reading it and keep helping with whatever the user asks next; file_gather moves files about a topic into a new folder.',
    'Never say you played, opened, sent or did something unless a tool result in this turn says it happened; if you did not call the tool, call it. Never say a task is finished unless a tool result says so. If a tool returns an error, explain it briefly.',
    `Known projects: ${projects.length ? projects.map((p) => `${p.name} (${p.path})`).join('; ') : 'none yet'}.`,
    `Current coding task: ${task.active ? `${task.status} on ${task.project}: "${task.instruction}"` : 'none'}.`,
    'For email use gmail_search (Gmail search syntax), gmail_read and gmail_send; gmail_connect connects a new account. If a tool result contains "ask", ask the user which account and call the tool again with account. Never guess email addresses. Write the complete email before gmail_send; the user approves it on screen. When summarising mail, mention sender and subject briefly.',
    `Connected accounts: ${accounts.length ? accounts.map((a) => `${a.provider === 'github' ? 'GitHub' : 'Gmail'} ${a.label} (${a.email}${a.isDefault ? ', default' : ''}${a.status === 'expired' ? ', expired' : ''})`).join('; ') : 'none'}.`,
  ].join('\n');
}

const CHOICE_RE = /^(?:no[, ]+)?(?:(?:use|with|switch to)\s+)?(?:the\s+)?(claude(?: code)?|novi coder|free one)(?:\s+instead)?(?:[, ]+please)?$/;

// The owner's everyday yes / no / cancel in Hinglish, Hindi and Marathi (Latin or Devanagari: Sarvam
// writes Hindi in Devanagari). Whole reply only: "haan but use cursor" still goes to the brain.
const APPROVE_LOCAL = /^(?:approved|go for it|include kar(?:o|do)?|kar ?le(?: update)?|kar ?lo|kar do|haa?n?(?: kar do| karo)?|theek hai|thik hai|chalega|हाँ|हां|हा|कर दो|कर लो|कर ले|ठीक है|चलेगा|हो|चालेल|कर)$/;
const DENY_LOCAL = /^(?:nahi|nahin|nai|nahi karna|mat kar(?:o)?|rehne de|rehne do|nako|नहीं|नही|मत करो|मत कर|रहने दो|नको)$/;
const STOP_LOCAL = /^(?:cancel (?:kar|karo|it|kar do)|ruk ja|ruko|band kar(?:o)?|बंद करो|बंद कर|रुक जा|रुको|कैंसल कर(?:ो| दो)?|थांब)$/;

// YouTube by voice without the AI: "open YouTube" opens it now and the next answer names the video;
// "play X on YouTube" / "YouTube pe X lagao" plays at once. Returns { open } | { play } | { maybe } | null.
const YT = '(?:youtube|yt|you tube|यूट्यूब)';
const PLAY_VERB = '(?:play|show(?: me)?|put on|watch|search(?: for)?)';
const HI_VERB = '(?:(?:laga|chala|dikha|lagao|chalao|dikhao)(?: do| de)?|play kar(?:o|do| do)?|search kar(?:o)?)';
const OPEN = '(?:open|start|launch|khol(?:o|do|de)?|open kar(?:o|do)?)';
export function youtubeCommand(text, { awaiting = false } = {}) {
  const t = String(text || '').trim().replace(/[.!?।,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:(?:hey )?novi|please) /i, '');
  const hiTail = (q) => q.replace(new RegExp(` ${HI_VERB}$`, 'iu'), '').trim();
  let m = new RegExp(`^(?:${OPEN} ${YT}|${YT} ${OPEN})(?: (?:and|aur|then|and then)(?: ${PLAY_VERB})? (.+))?$`, 'iu').exec(t);
  if (m) return m[1] ? { play: hiTail(m[1]) } : { open: true };
  m = new RegExp(`^${PLAY_VERB} (.+?) (?:on|in) ${YT}$`, 'iu').exec(t)
    || new RegExp(`^${YT} (?:open|khol) ?(?:kar ?ke|ke) (.+?)(?: (?:sunna|sunao|dekhna|dekhni|dekho|${HI_VERB}))?$`, 'iu').exec(t)
    || new RegExp(`^${YT} (?:pe|par|per|on) (.+?) ${HI_VERB}$`, 'iu').exec(t)
    || new RegExp(`^${YT} (?:pe|par|per|on) ${PLAY_VERB} (.+)$`, 'iu').exec(t);
  if (m) return { play: m[1] };
  if (!awaiting || !t) return null;
  m = new RegExp(`^${PLAY_VERB} (.+)$`, 'iu').exec(t) || new RegExp(`^(.+?) ${HI_VERB}$`, 'iu').exec(t);
  return m ? { play: m[1] } : { maybe: t };
}
// "Show my GitHub contributions (yesterday)" → the graph picture, without the AI. "Open my GitHub" is not this.
export function githubGraphCommand(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  if (!/github|गिटहब/.test(t) || !/contri|graph|ss\b|screenshot|photo|picture|कॉन्ट्रि/.test(t)) return null;
  if (/\b(?:open|khol\w*)\b|खोल/.test(t)) return null;
  const d = new Date(now);
  const yesterday = /yesterday|\bkal\b|कल/.test(t);
  if (yesterday) d.setDate(d.getDate() - 1);
  return { date: d.toLocaleDateString('en-CA'), when: yesterday ? 'yesterday' : 'today' };
}

// "Show me the HTML code" / "navbar ka code dikhao" → code_show with the user's words (no AI call).
export function codeCommand(text) {
  const t = String(text || '').trim();
  // Show words, or asking for "the full / whole / complete … code" in any words ("give me…", "was it the full header code?").
  if (!/\bcode\b|कोड/i.test(t) || !(/\b(show|see|dikha\w*|dekh\w*)\b|दिखा/i.test(t) || /\b(full|whole|complete|entire|poora|pura)\b/i.test(t) || /\b(give|send|get)\b.*\bcode (of|for)\b/i.test(t))) return null;
  if (/\b(fix|change|add|write|make|remove|delete|update|bana\w*|badal\w*)\b/i.test(t) && !/\b(show|see)\b.*\b(wrote|written|did you)\b|\bdid you write\b/i.test(t)) return null;
  return t;
}

// "Rename (my folder / project named) X to Y" → { name | null (= the current project), newName }.
export function renameCommand(text) {
  const t = String(text || '').trim().replace(/[.!?।]+$/, '').replace(/\s+(?:in|on|with) (?:claude|the laptop|my laptop)$/i, '');
  const m = /^(?:please )?(?:rename|change the name of)\s+(?:my |the )?(?:(?:folder|project)\s+)?(?:(?:named|called)\s+)?(.+?)\s+(?:to|as)\s+(.+)$/i.exec(t)
    || /^(?:my |the )?(?:(?:folder|project)\s+)?(.+?) ka naam (.+?) (?:kar do|karo|kar de|rakh do|rakho)$/i.exec(t)
    || /^name (?:the |my |this )?(project|folder|it) (.+)$/i.exec(t);
  if (!m) return null;
  const name = /^(?:(?:my|the|this) )?(?:project|folder|it)$/i.test(m[1]) ? null : m[1];
  return { name, newName: m[2] };
}

// "Ask Claude to …", "Claude, …", "in Claude …": a coding job for Claude Code on the Pro plan, passed on
// in the user's own words (no free AI in the middle). → the job, or null.
const JOB_VERB = /^(?:make|build|fix|add|change|create|write|remove|delete|update|refactor|rename|implement|set up|setup|start|continue|test|improve|style|design|redesign|convert|move|clean|debug|deploy|run|finish|complete|bana\w*|kar\w*|badal\w*|likh\w*|hata\w*|jod\w*)\b/i;
export function claudeCommand(text) {
  const t = String(text || '').trim().replace(/[.!?।]+$/, '');
  const m = /^(?:hey )?(?:ask|tell|use|get) claude(?: code)?\s+(?:to\s+)?(.+)$/i.exec(t)
    || /^claude(?: code)?[,:]?\s+(.+)$/i.exec(t)
    || /^(?:in|on|with|via) claude(?: code)?[,:]?\s+(.+)$/i.exec(t);
  return m && JOB_VERB.test(m[1]) ? m[1] : null;
}

// A spoken yes the approval queue refused (it needs more than a yes): say what's missing, never "Approved."
function needsProof(need) {
  if (need === 'pin') return 'That one needs your voice PIN. Say your PIN, or type it on the card.';
  if (need === 'no-pin') return "That one needs a voice PIN, and you haven't set one yet. Set it in Settings, then say yes again.";
  return 'Please confirm that one on screen.';
}

// "Also X" (or "yes, also X", "aur X"): X is added to the job Novi is asking about or the coder is doing.
export function alsoCommand(text) {
  const t = String(text || '').trim().replace(/[.!?।]+$/, '');
  const m = /^(?:(?:yes|yeah|ok|okay|haan|sure|allow)[, ]+)?(?:and )?(?:also|plus)[, ]+(.+)$/i.exec(t) || /^aur (?:bhi )?(.+)$/i.exec(t);
  return m ? m[1].trim() : null;
}

// File commands without the AI: open / summarize / gather into a folder / undo the gather.
const FILE_WORD = /\b(?:files?|folders?|pdfs?|docs?|docx|documents?|sheets?|excel|csv|notes|ppt|pptx|slides|presentation|assignment|report|resume|cv|spreadsheet)\b/i;
const GATHER_KIND = { pdf: 'pdf', document: 'doc', doc: 'doc', sheet: 'sheet', spreadsheet: 'sheet', slide: 'slides', presentation: 'slides', picture: 'image', photo: 'image', image: 'image', file: 'any' };
// The way it's actually said: "Okay, can you open …", "… on my laptop right now".

export function fileCommand(text) {
  const t = String(text || '').trim().replace(/[.!?।]+$/, '').replace(FILE_LEAD, '').replace(FILE_TAIL, '');
  if (/^(?:undo (?:that|it|the move)|put (?:them|it|those) back)$/i.test(t)) return { tool: 'file_undo_move', args: {} };
  const nf = /^(?:create|make)\s+(?:a\s+|an\s+)?(?:new\s+)?folder\s+(?:called|named|name)\s+(.+?)(?:\s+(?:on|in|inside|into)\s+(?:my\s+|the\s+)?(desktop|downloads|documents|.+?)(?:\s+folder)?)?$/i.exec(t)
    || /^(.+?)\s+naam\s+ka\s+(?:naya\s+)?folder\s+(?:banao|bana do|banado|bana de)$/i.exec(t);
  if (nf) return { tool: 'file_new_folder', args: { name: nf[1].trim(), ...(nf[2] ? { where: nf[2].trim() } : {}) } };
  if (/^open (?:up )?(?:my |the )?claude(?: code)?(?: app)?$/i.test(t)) return { tool: 'open_project', args: { editor: 'claude-code' } };
  // "Send me my resume" / "send X to my phone" / "X phone pe bhejo" → a download link (never WhatsApp words).
  if (!/\bwhats ?app\b/i.test(t)) {
    const toPhone = /^(?:send|give|get)\s+(?:me\s+)?(.+?)\s+(?:to|on)\s+(?:my\s+)?(?:phone|mobile)$/i.exec(t)
      || /^send\s+me\s+((?:my|the)\s+.+)$/i.exec(t)
      || /^(.+?)\s+(?:phone|mobile)\s+(?:pe|par)\s+(?:bhejo|bhej do|bhejdo)$/i.exec(t);
    if (toPhone) return { tool: 'file_send_phone', args: { query: toPhone[1].trim() } };
  }
  // "Delete the test2 folder (on my desktop)" → file_delete (always asks for the PIN). "this/it" is memoryCommand's.
  const del = /^(?:(?:i meant|no|i said|now)[, ]+)?(?:please\s+)?(?:delete|remove|trash)\s+(?:the\s+|my\s+)?(?:(?:folder|file)\s+(?:called\s+|named\s+)?)?(.+?)(?:\s+(?:folder|file))?(?:\s+(?:on|in|from)\s+(?:my\s+|the\s+)?(desktop|downloads|documents))?$/i.exec(t);
  if (del && !/^(?:it|this|that|them|these|those)$/i.test(del[1]) && /\b(?:folder|file)\b|\.\w{2,4}$/i.test(t)) return { tool: 'file_delete', args: { name: del[1].trim(), ...(del[2] ? { where: del[2].toLowerCase() } : {}) } };
  const g = /^(?:take|move|put|gather|collect|arrange)\s+all\s+(?:the\s+|my\s+)?(pdfs?|documents?|docs?|sheets?|spreadsheets?|slides?|presentations?|pictures?|photos?|images?|files?)\s+(?:about|of|on|for|related to)\s+(.+?)(?:\s+(?:and\s+)?(?:put|move)\s+them)?\s+(?:in|into|to)\s+(?:(?:a|the|one)\s+)?(?:new\s+)?folder(?:\s+(?:called|named)\s+(.+))?$/i.exec(t);
  if (g) {
    const kind = GATHER_KIND[g[1].toLowerCase().replace(/s$/, '')] || 'any';
    return { tool: 'file_gather', args: { topic: g[2].trim(), kind, ...(g[3] ? { folder: g[3].trim() } : {}) } };
  }
  const sum = /^(?:please\s+)?(?:summari[sz]e|give me (?:a\s+)?summary of|read and summari[sz]e)\s+(.+)$/i.exec(t);
  if (sum && (FILE_WORD.test(sum[1]) || /\bgoogle\b/i.test(sum[1]))) return { tool: 'file_summary', args: { query: sum[1], ...(/\bgoogle\b/i.test(sum[1]) ? { where: 'google' } : {}) } };
  const opening = /^(?:please\s+)?open\b/i.test(t) || /\b(?:kholo|khol do|open karo)$/i.test(t);
  // Something left to look for besides the command words ("open in my folder" names nothing: not a search).
  const named = t.replace(/\b(?:please|open|up|in|on|inside|my|the|a|an|folders?|files?|laptop|computer|pc|kholo|khol do|open karo|it|that|this)\b/gi, '').trim();
  if (opening && named && FILE_WORD.test(t) && !/\b(?:project|youtube|in (?:cursor|vs ?code|vscode|antigravity|kiro|claude))\b/i.test(t)) return { tool: 'file_open', args: { query: t } };
  return null;
}

const QUESTION = /^(?:what|whats|what's|how|why|who|when|where|which|is|are|can|could|do|does|kya|kaise|kab|kaun|kahan|kitna)\b/i;

// The AI saying it did something ("Opened the folder", "Playing it now") — only true if a tool ran.
export function claimsAction(text) {
  const t = String(text).trim();
  // "Here's a screenshot of your laptop screen." with none taken (live 2026-10-22).
  if (/^(?:(?:ok(?:ay)?|sure)[,.!]?\s*)?here(?:'s| is) (?:a |the |your )?(?:screenshot|screen ?shot|picture|photo|pic|ss)\b/i.test(t)) return true;
  return /^(?:(?:ok(?:ay)?|sure|done|alright)[,.!]?\s*)?(?:i(?:'ve| have| just)?\s+)?(?:opened|opening|launched|launching|started|starting|playing|played|renamed|moved|created|closed|sent|deleted|showing|here it is|it'?s open|done[,.!])/i.test(t);
}

// Web search by voice, without the AI: "search the web/online/internet for X", "google X",
// "look up X online", "X internet/google pe dekho", "google pe search karo X". "Search my files /
// notes" stays with those tools.
export function webCommand(text) {
  const t = String(text || '').trim().replace(/[.!?।]+$/, '').replace(FILE_LEAD, '').replace(FILE_TAIL, '');
  const m = /^(?:search|look up|find)(?: on)? (?:the )?(?:web|internet|online|google) (?:for |about )?(.+)$/i.exec(t)
    || /^(?:search|look up|find) (?:for )?(.+?) (?:online|on the (?:web|internet)|on google)$/i.exec(t)
    || /^google(?: pe| par)? (?:search karo |dekho |search )?(.+)$/i.exec(t)
    || /^(.+?) (?:internet|google|online) (?:pe|par) (?:dekho|search karo|dhundo)$/i.exec(t);
  const query = m?.[1]?.trim();
  return query && !/^(?:my|mere|meri) /i.test(query) ? { tool: 'web_search', args: { query } } : null;
}
const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export function webReply(out = {}) {
  if (out.error) return out.error;
  const sources = out.sources || [];
  if (out.answer) return `${out.answer} (${sources.slice(0, 2).map((s) => siteOf(s.url)).filter(Boolean).join(', ')})`.replace(/ \(\)$/, '');
  return `Top results: ${sources.slice(0, 3).map((s) => `${s.title} (${siteOf(s.url)})`).join('; ')}.`;
}

// Memory by voice, without the AI: "rename it", "open the folder you just made", "what did you do
// today" (from Novi's actions log) and notes ("note that …", "check my notes about X").
// recent = wiki_recent actions, newest first; null = not read yet → { needsRecent: true } when the
// words need them (so the log is read only for "rename it" / "open that" / "what did you do").
const isPath = (a) => a.path && !/^https?:/i.test(a.path);
const NEEDS_RECENT = /^(?:rename (?:it|that|this)\b|open (?:it|that|the (?:folder|file|project|one) (?:you|u)\b)|(?:(?:now|ok(?:ay)?|and)[, ]+)?(?:delete|remove) (?:it|that|this)\b|what (?:all )?(?:did|have) (?:you|u)\b|(?:tumne )?aaj kya kiya)/i;
export function memoryCommand(text, recent = [], now = new Date()) {
  const t = String(text || '').trim().replace(/[.!?।]+$/, '').replace(FILE_LEAD, '').replace(FILE_TAIL, '');
  if (recent === null) {
    if (NEEDS_RECENT.test(t)) return { needsRecent: true };
    recent = [];
  }
  const target = recent.find(isPath);
  const ren = /^rename (?:it|that|this)(?: (?:folder|file|project|one))? (?:to|as) (.+)$/i.exec(t);
  if (ren) {
    if (!target) return { reply: 'Rename what? Tell me the name.' };
    return target.project ? { tool: 'rename_project', args: { name: target.name, newName: ren[1].trim() } } : { tool: 'file_rename', args: { path: target.path, newName: ren[1].trim() } };
  }
  // "Now delete this folder" = the newest thing with a path; file_delete always asks for the PIN.
  if (/^(?:(?:now|ok(?:ay)?|and)[, ]+)?(?:delete|remove) (?:it|that|this)(?: (?:folder|file|one))?$/i.test(t)) {
    return target ? { tool: 'file_delete', args: { path: target.path } } : { reply: 'Delete what? Tell me the name.' };
  }
  if (/^open (?:it|that|the (?:folder|file|project|one) (?:you|u) (?:just )?(?:made|created|opened|renamed|moved))$/i.test(t)) {
    return target ? { tool: 'file_open', args: { path: target.path } } : { reply: 'Open what? Tell me the name.' };
  }
  if (/^(?:what (?:did|have) (?:you|u) (?:do|done)(?: today)?|what all did you do(?: today)?|(?:tumne )?aaj kya kiya)$/i.test(t)) {
    const day = (d) => new Date(d).toDateString();
    const today = recent.filter((a) => day(a.at) === day(now));
    if (!today.length) return { reply: 'Nothing yet today.' };
    const say = (a) => `${a.verb.charAt(0).toLowerCase()}${a.verb.slice(1)}${a.name ? ` ${a.name}` : ''}`;
    return { reply: `Today I did ${today.length} thing${today.length === 1 ? '' : 's'}. Last: ${today.slice(0, 3).map(say).join(', ')}.` };
  }
  let m = /^add to my (.+?) note[:,]?\s+(.+)$/i.exec(t);
  if (m) return { tool: 'note_write', args: { title: m[1].trim(), text: m[2].trim() } };
  m = /^write (?:a |this )?note about ([^:,]+)[:,]\s*(.+)$/i.exec(t);
  if (m) return { tool: 'note_write', args: { title: m[1].trim(), text: m[2].trim() } };
  m = /^(?:note (?:that|down)|make a note(?: that)?|write (?:a |this )?note(?: that)?[:,]?|remember in (?:my )?notes?(?: that)?)\s+(.+)$/i.exec(t);
  if (m) return { tool: 'note_write', args: { text: m[1].trim() } };
  m = /^(?:check|search|look in) my notes (?:about|for|on) (.+)$/i.exec(t) || /^what do my notes say about (.+)$/i.exec(t) || /^notes? (?:mein|me|madhe) (.+?) (?:dekho|check karo|bagh)$/i.exec(t);
  if (m) return { tool: 'notes_ask', args: { question: m[1].trim() } };
  m = /^open my (.+?) note$/i.exec(t);
  if (m) return { tool: 'note_open', args: { title: m[1].trim() } };
  return null;
}

// Short spoken replies Novi handles without calling the AI (stop, yes/no, "use Claude instead", status).
export function quickCommand(text) {
  const t = text.trim().toLowerCase().replace(/[.!?।]+$/, '').replace(/\s+/g, ' ');
  if (/^(stop|cancel|abort|stop it|stop claude|stop the task)$/.test(t) || STOP_LOCAL.test(t)) return 'stop';
  const choice = CHOICE_RE.exec(t);
  if (choice) return choice[1].startsWith('claude') ? 'choose:claude' : 'choose:novi-coder';
  if (/^(?:(?:yes|yeah|ok|okay)[, ]+)?(?:always allow|allow always|always)(?:[, ]+(?:allow )?(?:it|this|that))?(?:[, ]+please)?$/.test(t)) return 'approve-always';
  if (/^(yes|yeah|yep|yup|sure|allow|allow it|approve|go ahead|do it|ok|okay|start|start it)(?:[, ]+(?:please|start|go ahead|do it))?$/.test(t) || APPROVE_LOCAL.test(t)) return 'approve';
  if (/^(?:no[, ]+)?(no|nope|nah|deny|decline|reject|block|don't|do not|don't allow|do not allow|don't do it)(?:[, ]+(?:it|that|this|the request|this request|thanks|thank you|please))?$/.test(t) || DENY_LOCAL.test(t)) return 'deny';
  if (/^(what('s| is) (claude|the coder|novi coder|it) doing|status|progress|what('s| is) the progress|how far( along)?( is it)?|progress kya hai|kitna hua|kaha tak pahuncha|status kya hai)$/.test(t)) return 'status';
  if (/^(what('s| is) next|what('s| is) the next step|next step|aage kya( hai)?|ab kya( hai)?|next kya hai)$/.test(t)) return 'next';
  return null;
}

const lower = (t) => String(t).charAt(0).toLowerCase() + String(t).slice(1).replace(/[.!]+$/, '');

// "What's next": the next step of the coder's plan (null when no task, so the brain answers instead).
export function describeNext(s) {
  if (!s.active) return null;
  const plan = s.plan || [];
  const pending = plan.filter((p) => p.status === 'pending');
  if (pending.length) {
    const more = pending.length - 2;
    return `Next, ${s.agent || 'Claude'} will ${lower(pending[0].step)}${pending[1] ? `, then ${lower(pending[1].step)}` : ''}. ${more > 0 ? `${more} more step${more === 1 ? '' : 's'} after that.` : 'That finishes the plan.'}`;
  }
  const doing = plan.find((p) => p.status === 'in_progress');
  if (doing) return `That's the last step: ${lower(doing.doing)}.`;
  if (plan.length) return s.status === 'running' ? 'All planned steps are done; it is finishing up.' : describeStatus(s);
  const latest = (s.recent || []).at(-1);
  return `${s.agent || 'Claude'} hasn't shared a plan yet.${latest ? ` Latest: ${latest}.` : ''}`;
}

export function describeStatus(s) {
  if (!s.active) return 'No coding task is running right now.';
  const who = s.agent || 'Claude';
  if (s.status === 'running') {
    const plan = s.plan || [];
    const at = plan.findIndex((p) => p.status === 'in_progress');
    if (at >= 0) {
      // Two short sentences (that's what gets spoken): where it is, then what's done and what it's doing right now.
      const done = plan.filter((p) => p.status === 'completed').slice(-2).map((p) => lower(p.step));
      const now = (s.recent || []).at(-1);
      const extra = [done.length ? `Done so far: ${done.join(', ')}` : '', now ? `right now: ${now.replace(/[.!]+$/, '')}` : ''].filter(Boolean).join('; ');
      return `${who} is on step ${at + 1} of ${plan.length} for ${s.project}: ${lower(plan[at].doing)}.${extra ? ` ${extra.charAt(0).toUpperCase()}${extra.slice(1)}.` : ''}`;
    }
    const latest = (s.recent || []).at(-1);
    return `${who} is working on ${s.project}.${latest ? ` Latest: ${latest}.` : ''}`;
  }
  if (s.status === 'done') return `${who} finished the task on ${s.project}. ${firstSentence(s.summary || '')}`.trim();
  if (s.status === 'stopped') return `The task on ${s.project} was stopped.`;
  return `The last task on ${s.project} failed. ${firstSentence(s.summary || '')}`.trim();
}

export class Agent {
  constructor({ router, tools, approvals, memory, tasks, accounts = null, privateProviders = ['groq'], summarize = null, activity = null, quiet = null, shortcuts = null, learning = null, logger = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.activity = activity; // "what happened" log (server/activity.js)
    this.quiet = quiet; // quiet mode (server/quiet.js): no speech, everything on screen
    this.shortcuts = shortcuts; // learned shortcuts (server/brain/shortcuts.js): words → one quiet tool
    this.learning = learning; // the learning loop (server/brain/learning.js): misses noticed, corrections learned
    this.sleep = sleep;
    this.logger = logger;
    this.accounts = accounts;
    this.privateProviders = privateProviders;
    this.router = router;
    this.tools = tools;
    this.approvals = approvals;
    this.memory = memory;
    this.tasks = tasks;
    this.history = [];
    this.summarize = summarize; // (text) → 2-sentence summary on the private provider; long chats keep earlier context
    this._summarizing = null;
  }

  // from: 'local' (the laptop) or { deviceId } — approvals answered by voice check it (server/remoteTrust.js).
  // Every request is recorded in the activity log: what was heard, the route, the tools, the reply.
  async handle(text, opts = {}) {
    const rec = this.activity?.begin(text, opts.from || 'local') || null;
    this._rec = rec;
    const runs = [];
    this._turnRuns = runs;
    try {
      const out = await this._handle(text, opts);
      this.activity?.end(rec, out);
      try { this.learning?.observe({ heard: text, reply: out, tools: rec?.tools || runs.map((r) => ({ name: r.tool, ok: !r.output?.error, error: r.output?.error })), runs }); } catch { /* never break a request */ }
      return out;
    } catch (err) {
      this.activity?.fail(rec, err);
      throw err;
    } finally {
      if (this._rec === rec) this._rec = null;
    }
  }

  async _handle(text, { from = 'local' } = {}) {
    this._from = from; // who asked, for plugin approvals (phone warnings)
    this._turnYes = new Set(); // kinds of step the user said yes to in this request
    // "Novi, quiet" / "quiet for 30 minutes" / "talk again".
    const hush = this.quiet && quietCommand(text);
    if (hush) {
      if (!hush.quiet) { this.quiet.off(); return this._remember(text, "Okay, I'm talking again."); }
      this.quiet.on(hush.minutes);
      return this._remember(text, hush.minutes
        ? `Okay, quiet for ${hush.minutes} minutes. Everything will still show on screen.`
        : 'Okay, I\'ll stay quiet. Everything will still show on screen. Say "talk again" when you want my voice back.');
    }
    // "What did you get wrong this week?" — the learning loop's summary.
    if (this.learning && learningCommand(text)) return this._remember(text, this.learning.summary());
    // "What went wrong?" — the last request from the activity log, in words.
    if (this.activity && WRONG_RE.test(String(text).trim().replace(/[.!?]+$/, ''))) {
      return this._remember(text, describeTurn(this.activity.list(1)[0]));
    }
    const running = await this._runningCommand(text);
    if (running) return this._remember(text, running);
    const answered = this._answerQuestion(text, from);
    if (answered) return this._remember(text, answered);
    // The brief card waits: "change it to X" sends X back to ChatGPT (plugins/orchestrator).
    const changeCard = this.approvals.pending?.().filter((a) => a.changeable).at(-1);
    const change = changeCard ? changeCommand(text) : null;
    if (change) {
      this.approvals.resolve(changeCard.id, false, 'voice', null, { from, change });
      return this._remember(text, "Okay, I'm asking for that change.");
    }
    const also = alsoCommand(text);
    if (also) {
      const reply = await this._also(also, from);
      if (reply) return this._remember(text, reply);
    }
    // A shut down / restart is counting down: "cancel" / "stop" / "ruko" cancel that first.
    if (this._countdown && this._countdown.until > Date.now() && isCancelWord(text)) {
      this._countdown = null;
      const { output } = await this._runTool({ id: `power-${Date.now()}`, function: { name: 'laptop_power', arguments: JSON.stringify({ action: 'cancel' }) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || 'Okay, cancelled.');
    }
    // While Novi waits for a yes/no, short answers the way they're said and heard ("A low", "Nay",
    // "Dino", "haan kar do") answer it — never a song, never the AI.
    const waiting = Boolean(this.approvals.latest?.({ excludeTier: 'high' }));
    const quick = (waiting && answerKind(text)) || quickCommand(text);
    if (quick) {
      const quickReply = await this._quick(quick, from);
      if (quickReply) return this._remember(text, quickReply);
    }
    const control = await this._controlCommand(text);
    if (control) return this._remember(text, control);
    const browse = await this._browserCommand(text);
    if (browse) return this._remember(text, browse);
    // "Type: …" / "likho …": those exact words into the app in front (plugins/dictation), no AI.
    const dictate = this.tools.get('dictate_type') ? dictationCommand(text) : null;
    if (dictate) {
      const { output } = await this._runTool({ id: `type-${Date.now()}`, function: { name: 'dictate_type', arguments: JSON.stringify(dictate) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || 'Typed.');
    }
    // "Put portfolio on Claude" / "sync my Claude projects" (plugins/claude-link), no AI.
    const linked = await this._linkFolder(text);
    if (linked) return this._remember(text, linked);
    // "Progress of my FlexR project" / "what's next for X" (plugins/claude-link project_status), no AI.
    const st = projectStatusCommand(text);
    if (st && this.tools.get(st.tool)) {
      const { output } = await this._runTool({ id: `status-${Date.now()}`, function: { name: st.tool, arguments: JSON.stringify(st.args) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || 'Checking…');
    }
    // "What does my TraceBites app do": its README / GitHub repo / notes, never the web (2026-10-22).
    // A name Novi knows nothing about goes on to the AI.
    const ab = projectAboutCommand(text);
    if (ab && this.tools.get(ab.tool)) {
      const { output } = await this._runTool({ id: `about-${Date.now()}`, function: { name: ab.tool, arguments: JSON.stringify(ab.args) } }, { direct: true });
      if (!output?.unknown) return this._remember(text, output?.error || output?.note || '');
    }
    // "Sync my pinned chats" / "check my ChatGPT plan" and "X and Y are the same / different": no AI.
    const said = (this.tools.get('chatgpt_plan_sync') && chatgptCommand(text)) || (this.tools.get('same_set') && sameCommand(text)) || null;
    if (said) {
      const { output } = await this._runTool({ id: `said-${Date.now()}`, function: { name: said.tool, arguments: JSON.stringify(said.args) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || 'Done.');
    }
    const linkSaid = claudeLinkCommand(text);
    // "Open X in Claude": a folder project opens in Claude Code (below), only a claude.ai-only one here.
    const link = linkSaid?.soft && this.memory?.findProject?.(linkSaid.args.project) ? null : linkSaid;
    if (link && this.tools.get(link.tool)) {
      const { output } = await this._runTool({ id: `claude-${Date.now()}`, function: { name: link.tool, arguments: JSON.stringify(link.args) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || 'Done.');
    }
    const preview = await this._previewCommand(text);
    if (preview) return this._remember(text, preview);
    const opened = this._openKnown(text);
    if (opened) {
      const open = async (name, args) => (await this._runTool({ id: `open-${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }, { direct: true })).output || {};
      let out = await open(opened.tool, opened.args);
      // No website to run (a CLI, a library…): open the project in the editor instead.
      if (out.askClaude && this.tools.get('open_project')) out = await open('open_project', { project: opened.args.project });
      return this._remember(text, out.error || out.note || out.text || 'Done.');
    }
    const keys = keysCommand(text);
    if (keys && this.tools.get(keys.tool)) {
      const { output } = await this._runTool({ id: `keys-${Date.now()}`, function: { name: keys.tool, arguments: '{}' } }, { direct: true });
      return this._remember(text, output?.error || output?.note || "I couldn't check the keys.");
    }
    const disk = diskCommand(text);
    if (disk && this.tools.get(disk.tool)) {
      const { output } = await this._runTool({ id: `disk-${Date.now()}`, function: { name: disk.tool, arguments: JSON.stringify(disk.args) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || "I couldn't check that.");
    }
    const hist = historyCommand(text);
    if (hist && this.tools.get(hist.tool)) {
      const { output } = await this._runTool({ id: `hist-${Date.now()}`, function: { name: hist.tool, arguments: JSON.stringify(hist.args) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || 'None today.');
    }
    const yt = await this._youtube(text);
    if (yt) return this._remember(text, yt);
    const code = this.tools.get('code_show') ? codeCommand(text) : null;
    if (code) {
      const { output } = await this._runTool({ id: `code-${Date.now()}`, function: { name: 'code_show', arguments: JSON.stringify({ what: code }) } });
      return this._remember(text, output?.error || `Here's ${output?.file}.`);
    }
    const mem = this.tools.get('wiki_recent') ? await this._memoryCommand(text) : null;
    if (mem?.reply) return this._remember(text, mem.reply);
    if (mem && this.tools.get(mem.tool)) {
      const { output } = await this._runTool({ id: `mem-${Date.now()}`, function: { name: mem.tool, arguments: JSON.stringify(mem.args) } }, { direct: true });
      return this._remember(text, output?.error || output?.answer || output?.note || output?.text || (output?.opened ? `Opened ${output.opened}.` : 'Done.'));
    }
    const file = fileCommand(text);
    if (file && this.tools.get(file.tool)) {
      const { output } = await this._runTool({ id: `file-${Date.now()}`, function: { name: file.tool, arguments: JSON.stringify(file.args) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || output?.text || (output?.opened ? `Opened ${output.opened}.` : 'Done.'));
    }
    const web = webCommand(text);
    if (web && this.tools.get(web.tool)) {
      const { output } = await this._runTool({ id: `web-${Date.now()}`, function: { name: web.tool, arguments: JSON.stringify(web.args) } }, { direct: true });
      return this._remember(text, webReply(output || {}));
    }
    const direct = await this._projectCommand(text);
    if (direct) return this._remember(text, direct);
    // A big job without Claude named: a brief from ChatGPT + Gemini first (an unknown name = a new project).
    const brief = this.tools.get('project_brief') ? briefCommand(text) : null;
    if (brief) {
      const args = brief.project && !this.memory?.findProject?.(brief.project) ? { isNew: true, name: brief.project, request: brief.request } : brief;
      const { output } = await this._runTool({ id: `brief-${Date.now()}`, function: { name: 'project_brief', arguments: JSON.stringify(args) } }, { direct: true });
      return this._remember(text, output?.error || output?.note || "I'm working on the brief.");
    }
    const gh = this.tools.get('github_graph') ? githubGraphCommand(text) : null;
    if (gh) {
      const { output } = await this._runTool({ id: `gh-${Date.now()}`, function: { name: 'github_graph', arguments: JSON.stringify({ date: gh.date }) } });
      const n = output?.contributions;
      return this._remember(text, output?.error || `You made ${n} contribution${n === 1 ? '' : 's'} ${gh.when}.`);
    }
    // "Browse X" / "open X website": straight to open_website, no AI (it took 21–25 s through the AI).
    const browsed = await this._browse(text);
    if (browsed) return this._remember(text, browsed);

    // A learned shortcut: words the AI already solved with one quiet tool → that tool at once.
    const learned = this.shortcuts?.find(text);
    if (learned && this.tools.get(learned.tool)) {
      const r = await this._runTool({ id: `sc-${Date.now()}`, function: { name: learned.tool, arguments: JSON.stringify(learned.args) } });
      if (!r.output?.error) {
        this.shortcuts.used(learned.key);
        this.activity?.route?.(this._rec, 'shortcut');
        return this._remember(text, replyFrom(r.output));
      }
      // It doesn't work any more (app gone, file moved): forget it and let the AI work it out.
      if (/declined/i.test(r.output.error)) return this._remember(text, 'Okay, not done.');
      this.shortcuts.forget(learned.key);
    }

    const { extra, messages, offered, purpose } = await this._prepare(text);
    const notes = [];
    const runs = []; // { tool, args, output, asked } — one quiet successful run → a learned shortcut
    // Personal context (memories) only goes to providers the user trusts with private data.
    let provider = extra.sensitive ? this.privateProviders[0] : undefined;
    let waited = false;
    let ranTool = false;
    let toolFailed = false;
    let pushedBack = false;
    let lastText = ''; // a tool's own answer (screen_items' list…), shown if the AI is busy afterwards
    let exclude = []; // providers this turn moved off (busy mid-turn)
    let switched = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let res;
      try {
        res = await this.router.chat({ messages, tools: offered, purpose, only: provider, ...(exclude.length ? { exclude } : {}) });
        this.activity?.ai(this._rec, res?.provider);
      } catch (err) {
        if (!(err instanceof AllProvidersUnavailableError)) throw err;
        // A private turn can't fall back to another provider; a short rate-limit is worth waiting out.
        // A private turn can't fall back, so it waits up to 20 s; any turn waits out a few seconds.
        if (!waited && err.retryInMs <= (extra.sensitive ? 20_000 : 5_000)) {
          waited = true;
          await this.sleep(err.retryInMs);
          round -= 1;
          continue;
        }
        // The provider this turn is on ran out mid-turn (live 2026-10-22: Groq's per-minute limit after a
        // tool round, while Gemini and OpenRouter were free): another one finishes it — never for a private
        // turn. Gemini isn't used for a turn another provider started (it rejects tool steps without its own
        // thought signatures); a turn Gemini started loses those markers before moving on.
        if (provider && !extra.sensitive && !switched) {
          switched = true;
          exclude = provider === 'gemini' ? ['gemini'] : [provider, 'gemini'];
          if (provider === 'gemini') for (const m of messages) for (const c of m.tool_calls || []) delete c.extra_content;
          provider = undefined;
          round -= 1;
          continue;
        }
        // A tool already did the job (the graph is on screen): no "busy" line under it, just nothing more.
        const fallback = notes.length ? notes.join(' ') : lastText || (ranTool && !toolFailed ? '' : `My AI providers are busy right now. Try again in about ${Math.ceil(err.retryInMs / 1000)} seconds.`);
        return this._remember(text, fallback);
      }
      provider = res.provider; // a turn's tool rounds stay on one provider (Gemini thought signatures)
      const calls = res.message.tool_calls || [];
      if (!calls.length) {
        const content = (res.message.content || '').trim();
        // "Opened the folder for you." with no tool run means nothing happened: push back once, then be honest.
        if (!ranTool && claimsAction(content)) {
          if (pushedBack) return this._remember(text, "Sorry, I couldn't do that: nothing actually ran on the laptop. Try saying it another way.");
          pushedBack = true;
          messages.push({ role: 'assistant', content }, { role: 'user', content: 'You did not run any tool, so nothing happened. Call the tool that does it now, or say plainly that you can\'t.' });
          continue;
        }
        if (runs.length === 1) this.shortcuts?.learn(text, runs[0]);
        return this._remember(text, content || notes.join(' ') || 'Done.');
      }
      ranTool = true;
      messages.push(res.message);
      let sensitive = false;
      for (const call of calls) {
        const result = await this._runTool(call);
        let callArgs = {};
        try { callArgs = JSON.parse(call.function?.arguments || '{}'); } catch { /* bad JSON: the tool already said so */ }
        runs.push({ tool: call.function?.name, args: callArgs, output: result.output, asked: result.asked });
        if (result.output?.error) toolFailed = true;
        if (result.note) notes.push(result.note);
        else if (typeof result.output?.text === 'string' && result.output.text.trim() && !result.output.error) lastText = result.output.text.trim();
        if (result.output?.sensitive) sensitive = true;
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.output) });
      }
      // Private data (email) only ever goes to providers the user trusts with it.
      if (sensitive && !this.privateProviders.includes(provider)) {
        return this._remember(text, "I can't read your mail right now — my private AI provider is busy. Try again in a minute.");
      }
    }
    return this._remember(text, notes.join(' ') || 'I got stuck working that out. Could you rephrase?');
  }

  // The system prompt, messages and tools for one turn (shared by handle and firstStep).
  async _prepare(text) {
    // Plugins (e.g. long-term memory) add guidance and context for this turn.
    const extra = (await this.tools.promptContext?.({ prompt: text, messages: this.history })) || {};
    const system = [systemPrompt({ projects: this.memory.listProjects(), task: this.tasks.status(), accounts: this._accountsForPrompt() }), extra.system, extra.context].filter(Boolean).join('\n');
    const messages = [
      { role: 'system', content: system },
      ...this.history,
      { role: 'user', content: text },
    ];
    // Only the tools this request needs (keeps each call small enough for free rate limits).
    const taskActive = Boolean(this.tasks.status().active);
    const offered = selectTools(this.tools.schemas(), { text, history: this.history, taskActive });
    const purpose = isQuickTurn(text, offered, { taskActive }) ? 'quick' : 'fast';
    return { extra, messages, offered, purpose };
  }

  // Dry run for tools/understanding-benchmark.mjs: what the brain would do first for `text`
  // (a quick yes/no/cancel, tool calls with their arguments, or a plain reply). Runs nothing and
  // leaves the conversation history alone.
  async firstStep(text) {
    const said = String(text).trim().replace(/[.!?]+$/, '');
    const hush = this.quiet && quietCommand(said);
    if (hush) return { quick: null, calls: [], reply: hush.quiet ? 'Quiet mode on.' : 'Quiet mode off.', provider: 'direct' };
    if (this.activity && WRONG_RE.test(said)) return { quick: null, calls: [], reply: describeTurn(this.activity.list(1)[0]), provider: 'direct' };
    if (RUNNING_RE.test(said)) return { quick: null, calls: [], reply: await this._runningCommand(said), provider: 'direct' };
    const quick = quickCommand(text);
    if (quick) return { quick, calls: [], reply: null, provider: null };
    const yt = this.tools.get('play_youtube') ? youtubeCommand(text) : null;
    if (yt?.play) return { quick: null, calls: [{ name: 'play_youtube', args: { query: yt.play } }], reply: null, provider: 'direct' };
    const gh = this.tools.get('github_graph') ? githubGraphCommand(text) : null;
    if (gh) return { quick: null, calls: [{ name: 'github_graph', args: { date: gh.date } }], reply: null, provider: 'direct' };
    const mem = this.tools.get('wiki_recent') ? await this._memoryCommand(text) : null;
    if (mem?.reply) return { quick: null, calls: [], reply: mem.reply, provider: 'direct' };
    if (mem && this.tools.get(mem.tool)) return { quick: null, calls: [{ name: mem.tool, args: mem.args }], reply: null, provider: 'direct' };
    const ctl = controlCommand(text);
    if (ctl && this.tools.get(ctl.tool)) return { quick: null, calls: [{ name: ctl.tool, args: ctl.args }], reply: null, provider: 'direct' };
    const link = claudeLinkCommand(text);
    if (link && this.tools.get(link.tool)) return { quick: null, calls: [{ name: link.tool, args: link.args }], reply: null, provider: 'direct' };
    const st = projectStatusCommand(text);
    if (st && this.tools.get(st.tool)) return { quick: null, calls: [{ name: st.tool, args: st.args }], reply: null, provider: 'direct' };
    const ab = projectAboutCommand(text);
    if (ab && this.tools.get(ab.tool)) return { quick: null, calls: [{ name: ab.tool, args: ab.args }], reply: null, provider: 'direct' };
    const pv = this._previewKnown(previewCommand(text));
    if (pv) return { quick: null, calls: [{ name: pv.tool, args: pv.args }], reply: null, provider: 'direct' };
    const op = this._openKnown(text);
    if (op) return { quick: null, calls: [{ name: op.tool, args: op.args }], reply: null, provider: 'direct' };
    const br = browserCommand(text, { lastTo: this._waLastTo });
    if (br && this.tools.get(br.tool)) return { quick: null, calls: [{ name: br.tool, args: br.args }], reply: null, provider: 'direct' };
    const file = fileCommand(text);
    if (file && this.tools.get(file.tool)) return { quick: null, calls: [{ name: file.tool, args: file.args }], reply: null, provider: 'direct' };
    const web = webCommand(text);
    if (web && this.tools.get(web.tool)) return { quick: null, calls: [{ name: web.tool, args: web.args }], reply: null, provider: 'direct' };
    const sd = (this.tools.get('chatgpt_plan_sync') && chatgptCommand(text)) || (this.tools.get('same_set') && sameCommand(text)) || null;
    if (sd) return { quick: null, calls: [{ name: sd.tool, args: sd.args }], reply: null, provider: 'direct' };
    const bw = this.tools.get('open_website') ? browseCommand(text) : null;
    if (bw?.target) return { quick: null, calls: [{ name: 'open_website', args: { target: bw.target, ...(bw.on ? { on: bw.on } : {}) } }], reply: null, provider: 'direct' };
    const sc = this.shortcuts?.find(text);
    if (sc && this.tools.get(sc.tool)) return { quick: null, calls: [{ name: sc.tool, args: sc.args }], reply: null, provider: 'shortcut' };
    const { extra, messages, offered, purpose } = await this._prepare(text);
    const res = await this.router.chat({ messages, tools: offered, purpose, only: extra.sensitive ? this.privateProviders[0] : undefined });
    this.activity?.ai(this._rec, res?.provider);
    const calls = (res.message.tool_calls || []).map((c) => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* keep {} */ }
      return { name: c.function?.name, args };
    });
    return { quick: null, calls, reply: calls.length ? null : (res.message.content || '').trim(), provider: res.provider };
  }

  // "Also X": yes + X added to the job being asked about; or, while the coder works, sent straight to it.
  async _also(addition, from) {
    const asking = this.approvals.latest?.({ excludeTier: 'high' });
    if (asking) {
      if (asking.addable) {
        this.approvals.resolve(asking.id, true, 'voice', null, { from, addition });
        return "Okay, I'll add that too.";
      }
      this.approvals.resolve(asking.id, true, 'voice', null, { from });
      return `Approved. ${await this._handle(addition, { from })}`; // same request in the activity log
    }
    const st = this.tasks.status();
    const send = this.tools.get('code_send_message');
    if (st.active && st.status === 'running' && send) {
      // The user already said what they want ("also …"): no second question.
      try {
        const out = await send.run({ instruction: addition });
        return out?.note || 'Sent.';
      } catch (err) {
        return err.message;
      }
    }
    return null;
  }

  // Rename a project / hand a job to Claude Code without the free AI (it got these wrong or was "busy").
  async _projectCommand(text) {
    const run = async (name, args) => {
      const { output } = await this._runTool({ id: `${name}-${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }, { direct: true });
      return output?.error || output?.note || 'Okay.';
    };
    const st = this.tasks.status();
    const rename = this.tools.get('rename_project') ? renameCommand(text) : null;
    if (rename) {
      const name = rename.name || st.project;
      return name ? run('rename_project', { name, newName: rename.newName }) : 'Which project should I rename?';
    }
    const job = this.tools.get('code_start_task') ? claudeCommand(text) : null;
    if (!job) return null;
    if (st.active && st.status === 'running') return run('code_send_message', { instruction: job });
    const lower = text.toLowerCase();
    const named = this.memory.listProjects().filter((p) => lower.includes(p.name)).sort((a, b) => b.name.length - a.name.length)[0];
    const project = named?.name || st.project;
    return project ? run('code_start_task', { project, instruction: job, agent: 'claude' }) : null; // no project: the brain asks
  }

  async _youtube(text) {
    if (!this.tools.get('play_youtube') || !this.tools.get('open_website')) return null;
    const awaiting = this._ytUntil > Date.now();
    this._ytUntil = 0;
    const cmd = youtubeCommand(text, { awaiting });
    if (!cmd) return null;
    let query = cmd.play;
    if (cmd.maybe) {
      if (this.approvals.pending?.().length) return null; // a question is waiting: answers aren't song names
      // Only a plain answer ("valorant") is a video name; anything that needs another tool goes to the brain.
      const offered = selectTools(this.tools.schemas(), { text });
      const plain = offered.every((s) => ALWAYS.has(s.function.name)) && cmd.maybe.split(' ').length <= 8 && !QUESTION.test(cmd.maybe);
      if (!plain) return null;
      query = cmd.maybe;
    }
    const run = (name, args) => this._runTool({ id: `yt-${Date.now()}`, function: { name, arguments: JSON.stringify(args) } });
    if (cmd.open) {
      const { output } = await run('open_website', { target: 'https://www.youtube.com' });
      if (output?.error) return output.error;
      this._ytUntil = Date.now() + 2 * 60_000;
      return output?.on === 'phone' ? "Here's YouTube. What should I play?" : "YouTube's open. What should I play?";
    }
    const { output } = await run('play_youtube', { query });
    if (output?.error) return output.error;
    if (output?.note) return output.note;
    return `Playing ${output?.playing?.title || query}.`;
  }

  // While Claude waits on one of its questions, what the user says answers it ("doosra", "dark",
  // "make it purple", "skip"). A yes/no for another waiting card, and "progress" / "what's next" /
  // "stop", keep their usual meaning.
  _answerQuestion(text, from) {
    const q = this.approvals.waitingQuestion?.();
    if (!q) return null;
    const match = matchAnswer(text, q.question.options, { multiSelect: q.question.multiSelect });
    if (match.kind === 'skip') {
      this.approvals.resolve(q.id, false, 'voice', null, { from });
      return 'Okay, Claude will choose.';
    }
    if (this.approvals.latest?.({ excludeTier: 'high' }) && answerKind(text)) return null;
    if (match.kind === 'own' && ['stop', 'status', 'next'].includes(quickCommand(text))) return null;
    const answer = answerFor(match);
    this.approvals.resolve(q.id, true, 'voice', null, { from, answer });
    return `Okay, I told Claude: ${answer}.`;
  }

  async _quick(kind, from = 'local') {
    if (kind === 'stop') {
      // While Novi is asking something, "cancel" answers that question; it doesn't stop the task.
      const asking = this.approvals.latest({ excludeTier: 'high' });
      if (asking) {
        this.approvals.resolve(asking.id, false, 'voice', null, { from });
        return 'Okay, cancelled. What do you want instead? Tell me.';
      }
      return (await this.tasks.stop()) ? 'Okay, I stopped the coding task.' : 'Nothing is running right now.';
    }
    if (kind === 'status') return describeStatus(this.tasks.status());
    if (kind === 'next') return describeNext(this.tasks.status());
    if (kind.startsWith('choose:')) {
      const choice = kind.slice('choose:'.length);
      const open = this.approvals.pending().filter((a) => a.tier !== 'high' && !a.kind && a.choices);
      const withChoice = open.filter((a) => a.choices.some((c) => c.id === choice)).at(-1);
      const label = choice === 'claude' ? 'Claude Code' : 'Novi Coder';
      if (withChoice) {
        this.approvals.resolve(withChoice.id, true, 'voice', choice, { from });
        return `Okay, using ${label}.`;
      }
      // Picking the option Novi already proposed is just a yes.
      if (open.length) {
        this.approvals.resolve(open.at(-1).id, true, 'voice', null, { from });
        return `Okay, using ${label}.`;
      }
      return null;
    }
    const item = this.approvals.latest({ excludeTier: 'high' });
    if (!item) {
      const pending = this.approvals.pending();
      if (!pending.length) return null;
      return pending.some((a) => a.kind) ? 'That one deletes or pays for something, so please confirm it on screen.' : 'That one is high risk, so please confirm it on screen.';
    }
    if (kind === 'approve-always') {
      if (!item.grant) {
        if (!this.approvals.resolve(item.id, true, 'voice', null, { from })) return needsProof(this.approvals.trust?.check?.(item, from, null)?.need);
        return "Approved. I can't remember that kind of action, so I'll ask each time.";
      }
      if (!this.approvals.resolve(item.id, true, 'voice', null, { always: true, from })) return needsProof(this.approvals.trust?.check?.(item, from, null)?.need);
      return `Approved. I'll always allow ${item.grant.label} from now on.`;
    }
    const allow = kind === 'approve';
    if (!this.approvals.resolve(item.id, allow, 'voice', null, { from })) return needsProof(this.approvals.trust?.check?.(item, from, null)?.need);
    return allow ? 'Approved.' : 'Okay, denied.';
  }

  // One log line per tool run (name + ok or the error; never the arguments, which can be private).
  // direct: the user's own words named exactly this action ("make a folder called X"), so asking
  // "should I?" again is noise. Big or risky things still ask; see _skipAsking.
  async _runTool(call, { direct = false } = {}) {
    const t0 = Date.now();
    const result = await this._runToolInner(call, { direct });
    if (result.output?.countdownUntil) this._countdown = { until: result.output.countdownUntil };
    let runArgs = {};
    try { runArgs = JSON.parse(call.function?.arguments || '{}'); } catch { /* reported below */ }
    this._turnRuns?.push({ tool: call.function?.name, args: runArgs, output: result.output, asked: result.asked });
    // "her" / "him" in the next WhatsApp request = the chat Novi just checked.
    if (call.function?.name === 'whatsapp_prepare' && result.output?.ready?.name) this._waLastTo = result.output.ready.name;
    const err = result.output?.error;
    let params = {};
    try { params = JSON.parse(call.function?.arguments || '{}'); } catch { /* bad JSON: reported by the run */ }
    Promise.resolve(this.tools.afterToolCall?.({ toolName: call.function?.name, params, result: result.output, ...(err ? { error: err } : {}) })).catch(() => {});
    this.logger?.log?.(`[tool] ${call.function?.name} ${err ? `error: ${String(err).slice(0, 200)}` : 'ok'}`);
    this.activity?.tool(this._rec, { name: call.function?.name, ok: !err, error: err, ms: Date.now() - t0 });
    return result;
  }

  // No question when the user asked for exactly this, or already said yes to this kind of step in
  // this request (screen tasks: one yes, not one per click). Never for high risk, sends/deletes/
  // payments (kind), choices, or moving files Novi picked herself.
  _skipAsking(name, { tier, kind, grantable, category, pin }, direct) {
    // A PIN card (deletes, dangerous commands) is never skipped — not even after a yes in this request.
    if (tier === 'high' || kind || pin || ASK_ANYWAY.has(name)) return false;
    if (direct && (grantable || DIRECT_OK.has(name))) return true;
    return Boolean(grantable && this._turnYes?.has(category));
  }

  async _runToolInner(call, { direct = false } = {}) {
    const tool = this.tools.get(call.function?.name);
    if (!tool) return { output: { error: `Unknown tool ${call.function?.name}` } };
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return { output: { error: 'Arguments were not valid JSON' } };
    }
    // "$"-prefixed arguments are reserved for choices the user makes (e.g. "use Claude instead"); never from the model.
    for (const key of Object.keys(args)) if (key.startsWith('$')) delete args[key];
    let lastApproval = false;
    if (tool.gate) {
      // Plugin tools: approval and blocking come from before_tool_call hooks (OpenClaw shape).
      const gate = await tool.gate(args, { toolCallId: call.id, from: this._from || 'local', direct });
      if (gate.block) return { output: { error: gate.blockReason, ...(gate.details || {}) }, note: gate.blockReason };
      if (gate.approval) {
        lastApproval = true;
        const { title, detail, tier, prompt, choices } = gate.approval;
        // Which kind of action this is, and whether "always allow" may apply (never for sends/deletes/high risk).
        const { category, grantable } = classifyApproval({ toolName: tool.name, pluginId: tool.pluginId, tier, choices, category: gate.approval.category, grantable: gate.approval.grantable });
        const skip = this._skipAsking(tool.name, { tier, kind: gate.approval.kind, grantable: grantable && !choices?.length, category, pin: gate.approval.pin }, direct);
        const decision = skip ? { allow: true } : await this.approvals.decide({
          title, detail: detail || '', tier, source: 'novi', prompt,
          choices: choices?.map(({ id, label }) => ({ id, label })),
          category, grantable, ...(gate.approval.kind ? { kind: gate.approval.kind } : {}), ...(gate.approval.pin ? { pin: true } : {}),
          addable: typeof args.instruction === 'string',
        });
        if (!decision.allow) return { output: { error: 'The user declined this action.' } };
        this._turnYes?.add(category);
        if (decision.addition && typeof args.instruction === 'string') args.instruction += `\n\nAlso: ${decision.addition}`;
        const picked = decision.choice && choices?.find((c) => c.id === decision.choice);
        if (picked?.params) Object.assign(args, picked.params);
      }
    } else {
      if (tool.precheck) {
        const pre = await tool.precheck(args);
        if (pre) return { output: pre, note: pre.note };
      }
      if (tool.tier !== 'low') {
        const { category, grantable } = classifyApproval({ toolName: tool.name, tier: tool.tier });
        const skip = this._skipAsking(tool.name, { tier: tool.tier, grantable, category }, direct);
        const decision = skip ? { allow: true } : await this.approvals.decide({ title: tool.describe(args), detail: tool.detail ? tool.detail(args) : '', tier: tool.tier, source: 'novi', addable: typeof args.instruction === 'string' });
        if (!decision.allow) return { output: { error: 'The user declined this action.' } };
        this._turnYes?.add(category);
        if (decision.addition) args.instruction += `\n\nAlso: ${decision.addition}`;
      }
    }
    // asked: this kind of action needs an approval (even when it was skipped) — never a learned shortcut.
    const asked = Boolean(tool.gate ? lastApproval : tool.tier !== 'low');
    try {
      const output = await tool.run(args, { toolCallId: call.id });
      return { output, note: output?.note, asked };
    } catch (err) {
      return { output: { error: err.message }, note: err instanceof UserFacingError ? err.message : undefined };
    }
  }

  // Laptop controls without the AI (volume, windows, clipboard…). "Go to X" with no such window
  // returns null so the request goes on (X may be a website or an app to open).
  async _controlCommand(text) {
    const ctl = controlCommand(text);
    if (!ctl || !this.tools.get(ctl.tool)) return null;
    const args = { ...ctl.args };
    if (ctl.lastReply) {
      const last = [...this.history].reverse().find((m) => m.role === 'assistant')?.content;
      if (!last) return "There's nothing to copy yet.";
      args.text = last;
    }
    const { output } = await this._runTool({ id: `laptop-${Date.now()}`, function: { name: ctl.tool, arguments: JSON.stringify(args) } }, { direct: true });
    if (output?.notFound && args.do === 'focus') return null;
    return output?.error || output?.note || 'Done.';
  }

  // LeetCode / WhatsApp without the AI. A WhatsApp file or folder is found first; sending always
  // asks (whatsapp_send). "done" after a pause (QR scan) tries the same send again.
  async _browserCommand(text) {
    // "On my laptop" / "open it" right after a LeetCode answer: open that problem.
    const t = String(text).trim().replace(/[.!?]+$/, '');
    if (this._lastLink && Date.now() - this._lastLink.at < 5 * 60_000 && this.tools.get('open_website')) {
      const later = /^(?:(?:ok(?:ay)?|no|i said)[, ]+)?(?:(open|show|put)(?: it| that| this| the problem| the question)?(?: up)?)?(?:\s*(?:on|in) (?:my |the )?(laptop|computer|pc))?$/i.exec(t);
      if (later && (later[1] || later[2])) {
        const out = await this._openLink(this._lastLink.url, later[2] ? 'laptop' : 'here');
        return out.error || (later[2] ? 'Opened it on the laptop.' : 'Opened it.');
      }
    }
    let cmd = browserCommand(text, { lastTo: this._waLastTo });
    if (!cmd && this._browserPause && isDoneWord(text)) cmd = this._browserPause;
    this._browserPause = null;
    const run = async (name, args) => (await this._runTool({ id: `br-${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }, { direct: true })).output || {};
    const args = { ...cmd?.args };
    // "Send this video to Isha" / "… to my phone" / "copy this link": the page open in the laptop's front
    // browser first (2026-10-22).
    if (cmd?.link) {
      if (!this.tools.get('laptop_current_link')) return null;
      const page = await run('laptop_current_link', {});
      if (!page.url) return page.error || "I couldn't read the page open on the laptop.";
      const where = page.browser ? ` in ${page.browser}` : '';
      if (cmd.phone) return `Here is the page open${where}: ${page.url}`;
      if (cmd.copy) {
        const out = await run('laptop_clipboard', { do: 'set', text: page.url });
        return out.error || `Copied the link of the page open${where}: ${page.url}`;
      }
      args.text = page.url;
    }
    if (!cmd || !this.tools.get(cmd.tool)) return null;
    if (cmd.find) {
      if (!this.tools.get('file_find')) return "I can't look for files right now.";
      const hit = (await run('file_find', { query: `${cmd.find}${cmd.kind && cmd.kind !== 'file' ? ` ${cmd.kind}` : ''}` })).files?.[0];
      if (!hit) return `I can't find ${cmd.find}.`;
      args.path = path.join(hit.folder, hit.name);
    }
    const out = await run(cmd.tool, args);
    if (cmd.tool === 'whatsapp_prepare') {
      if (out.pause) this._browserPause = { tool: cmd.tool, args };
      if (!out.ready) return out.error || out.note || 'I could not get that ready.';
      const sent = await run('whatsapp_send', {});
      return /declined/i.test(String(sent.error || '')) ? 'Okay, not sent.' : sent.error || sent.note || 'Okay, not sent.';
    }
    if (cmd.tool === 'leetcode_today' && out.link) {
      this._lastLink = { url: out.link, at: Date.now() };
      if (cmd.open && this.tools.get('open_website')) {
        const opened = await this._openLink(out.link, cmd.open);
        return `${out.note}${opened.error ? ` ${opened.error}` : cmd.open === 'laptop' ? ' Opened it on the laptop.' : ' Opened it.'}`;
      }
    }
    return out.error || out.note || 'Done.';
  }

  async _openLink(url, where) {
    return (await this._runTool({ id: `link-${Date.now()}`, function: { name: 'open_website', arguments: JSON.stringify({ target: url, ...(where === 'laptop' ? { on: 'laptop' } : {}) }) } }, { direct: true })).output || {};
  }

  // "What's running?" — everything going on, in one answer: the coding task, previews, the next reminder.
  async _runningCommand(text) {
    const t = String(text).trim().replace(/[.!?]+$/, '');
    if (!RUNNING_RE.test(t)) return null;
    const run = async (name) => (this.tools.get(name) ? (await this._runTool({ id: `run-${name}-${Date.now()}`, function: { name, arguments: '{}' } }, { direct: true })).output || {} : {});
    const parts = [];
    const s = this.tasks?.status?.() || {};
    if (s.active && s.status === 'running') parts.push(describeStatus(s));
    const preview = (await run('preview_status')).note;
    if (preview) parts.push(preview);
    const next = (await run('reminder_list')).items?.[0];
    if (next) parts.push(`Next reminder: ${next.when}: ${String(next.text).replace(/[.!]+$/, '')}.`);
    return parts.length ? parts.join(' ') : 'Nothing is running right now.';
  }

  // A preview needs a project: one named, the running task's, or the last task's. Else the AI asks.
  _previewKnown(cmd) {
    if (!cmd || !this.tools.get(cmd.tool)) return null;
    const known = cmd.args.project || this.tasks?.status?.()?.project || this.memory?.lastTask?.()?.project;
    return known ? cmd : null;
  }

  // "Browse X": a domain, a known site or a Google search; "browse it" = the site opened last (30 min).
  async _browse(text) {
    const cmd = this.tools.get('open_website') ? browseCommand(text) : null;
    if (!cmd) return null;
    const recent = [this._browsed, this._lastLink].filter((l) => l && Date.now() - l.at < 30 * 60_000).sort((a, b) => b.at - a.at)[0];
    const target = cmd.last ? recent?.url : cmd.target;
    if (!target) return null; // "browse this" with nothing opened lately → the AI
    const { output = {} } = await this._runTool({ id: `browse-${Date.now()}`, function: { name: 'open_website', arguments: JSON.stringify({ target, ...(cmd.on ? { on: cmd.on } : {}) }) } }, { direct: true });
    if (output.error) return output.error;
    const url = output.opened || target;
    this._browsed = { url, at: Date.now() };
    const search = !/^https?:\/\//i.test(target);
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the words */ }
    if (output.on === 'phone') return search ? `Here's a Google search for ${target}. Tap the link to open it.` : `Here's ${host}. Tap the link to open it.`;
    return search ? `Searching Google for ${target}.` : `Opened ${host}.`;
  }

  // "Open portfolio" / "open portfolio in VS Code" — only for a project Novi knows; "open spotify" goes on.
  _openKnown(text) {
    const cmd = openCommand(text);
    const known = cmd && this.tools.get(cmd.tool) && this.memory?.findProject?.(cmd.args.project);
    // Novi's own folder: "open Novi" must never start a second Novi as a "site".
    if (!known || (cmd.tool === 'preview_open' && known.name === 'novi')) return null;
    return cmd;
  }

  // "Show me the homepage": the preview plugin answers; when it can't tell how to run the project,
  // Claude is asked to start the site (and write .novi/run.json for next time).
  async _previewCommand(text) {
    const cmd = this._previewKnown(previewCommand(text));
    if (!cmd) return null;
    const run = async (name, args) => (await this._runTool({ id: `pv-${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }, { direct: true })).output || {};
    const out = await run(cmd.tool, cmd.args);
    if (out.askClaude && this.tools.get('code_send_message')) {
      const sent = await run('code_send_message', { message: 'Please start the website so it can be previewed, and write .novi/run.json.' });
      if (!sent.error) return 'I asked Claude to start the site. Say "show me the homepage" again in a minute.';
    }
    return out.error || out.note || 'Done.';
  }

  // "Link the FLEXR context folder to my FlexR project" / a pasted path (linkFolderCommand). A project with
  // no folder yet (claude.ai-only) gets this one; one that has its folder gets it as context in its note.
  // Not found → ask for the path once; the pasted path (within 5 min) finishes it. A path on its own with
  // nothing pending opens it.
  async _linkFolder(text) {
    const said = linkFolderCommand(text);
    if (!said) return null;
    const run = async (name, args) => (await this._runTool({ id: `link-${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }, { direct: true })).output || {};
    const pending = this._pendingLink && Date.now() - this._pendingLink.at < 5 * 60_000 ? this._pendingLink : null;
    if (said.path && !said.project && !pending) {
      if (!this.tools.get('file_open')) return null;
      if (!fs.existsSync(said.path)) return `I can't find ${said.path} on the laptop.`;
      const out = await run('file_open', { path: said.path });
      return out.error || `Opened ${path.basename(said.path)}.`;
    }
    const project = said.project || pending?.project;
    let target = said.path || null;
    if (said.path && !fs.existsSync(said.path)) return `I can't find ${said.path} on the laptop.`;
    if (!target && said.name && this.tools.get('file_find')) {
      const found = (await run('file_find', { query: said.name })).files || [];
      const pick = found.find((f) => f.folderItself && f.path) || found.find((f) => f.path);
      target = pick?.path && fs.existsSync(pick.path) ? pick.path : null;
    }
    if (!target) {
      this._pendingLink = { project, at: Date.now() };
      return `I couldn't find "${said.name || said.path}" on the laptop. Paste or say its folder path and I'll link it to ${project}.`;
    }
    this._pendingLink = null;
    const isDir = fs.statSync(target).isDirectory();
    const label = `${path.basename(target)} ${isDir ? 'folder' : 'file'}`;
    const known = this.memory?.findProject?.(project);
    if (known?.path || !isDir) {
      const owner = known?.path ? path.basename(known.path) : project;
      const out = await run('note_write', { title: `${owner} project`, text: `Context: ${target}` });
      return out.error || `Added the ${label} to ${owner} as its context.`;
    }
    const out = await run('remember_project', { name: project, path: target });
    if (out.error) return out.error;
    // The project's note gets the folder too: Novi Memory shows a project's files from its `Folder:` line.
    if (this.tools.get('note_write')) await run('note_write', { title: `${project} project`, text: `Folder: ${target}` });
    return `Linked the ${label} to ${project}. Ask me about ${project}, open it, or tell Claude to work on it anytime.`;
  }

  async _memoryCommand(text) {
    const first = memoryCommand(text, null);
    return first?.needsRecent ? memoryCommand(text, await this._recentActions()) : first;
  }

  async _recentActions() {
    try {
      const out = await this.tools.get('wiki_recent').run({ limit: 20 });
      return out?.actions || [];
    } catch {
      return [];
    }
  }

  _accountsForPrompt() {
    if (!this.accounts) return [];
    return this.accounts.list().map((a) => ({ ...a, isDefault: this.accounts.defaultFor(a.provider)?.id === a.id }));
  }

  _remember(text, replyText) {
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: replyText });
    if (this.summarize && this.history.length > SUMMARY_AT && !this._summarizing) this._summarizing = this._summarizeOldest();
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    Promise.resolve(this.tools.agentEnd?.({ messages: [{ role: 'user', content: text }, { role: 'assistant', content: replyText }], success: true })).catch(() => {});
    return replyText;
  }

  // Runs after the reply: the oldest 10 messages leave history now; their 2-sentence summary comes
  // back as one system line at the top. If summarizing fails they're just gone (as before).
  async _summarizeOldest() {
    const old = this.history.splice(0, 10);
    try {
      const said = old.map((m) => `${m.role === 'assistant' ? 'Novi' : m.role === 'user' ? 'User' : 'Note'}: ${m.content}`).join('\n');
      const summary = String((await this.summarize(`Summarize in 2 sentences what was said:\n${said}`)) || '').trim();
      if (summary) this.history.unshift({ role: 'system', content: `Earlier in this chat: ${summary}` });
    } catch (err) {
      this.logger.warn?.(`[agent] chat summary failed: ${err.message}`);
    } finally {
      this._summarizing = null;
    }
  }
}
