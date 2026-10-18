// "Show me the homepage / contact page / the site", "homepage dikhao", "stop the preview" — the
// coding project's website preview (plugins/preview), without the AI.
import { clean } from './phrases.js';

const HOME = /^(?:home ?page|home|site|website|preview|main page|landing page)$/i;
const page = (word) => (HOME.test(word) ? 'home' : word.toLowerCase().replace(/\s*(?:page|section|part|tab)$/, '').trim());
const show = (word, project) => ({ tool: 'preview_show', args: { page: page(word), ...(project ? { project: project.trim() } : {}) } });

export function previewCommand(text) {
  const t = clean(text).replace(/[.!?]+$/, '');
  // A named website (LeetCode login, YouTube…) is the browser's job, not the project's preview.
  if (/\b(?:leet ?code|github|youtube|whats ?app|google|gmail|instagram|login|log in|sign ?in|sign ?up)\b/i.test(t)) return null;
  if (/^(?:stop|close|end) (?:the )?preview$|^preview (?:band|bandh) (?:karo|kar do)$/i.test(t)) return { tool: 'preview_stop', args: {} };
  let m = /^show(?: me)? (?:the |my )?(home ?page|site|website|preview|(?:[a-z]+ )?[a-z]+ (?:page|section|part|tab))(?: of (?:my |the )?(.+))?$/i.exec(t);
  if (m) return show(m[1], m[2]);
  m = /^(?:(.+?) ka )?(home ?page|site|website|preview|[a-z]+ (?:page|section|part)) (?:dikhao|dikha do|dikhaao)$/i.exec(t);
  if (m) return show(m[2], m[1]);
  // "A screenshot of the work you're doing" / "show me what you're building": the coding project's
  // site, not the laptop screen (live 2026-10-17 it sent the laptop).
  const pic = /\b(?:screen ?shot|ss|picture|pic|photo|image)\b/i.test(t);
  const work = /\b(?:work|working on|building|kaam|making)\b|\bwhat (?:you(?:'re| are)|u r|claude is) doing\b/i.test(t);
  const onLaptop = /\b(?:laptop|screen|desktop|computer|pc|window)\b/i.test(t.replace(/screen ?shot/gi, ''));
  if (!onLaptop && ((pic && (work || /\bprogress\b/i.test(t))) || (/^(?:show|send)\b/i.test(t) && work))) return show('home');
  // "A screenshot / picture / ss of the homepage (of the portfolio)": the project's page, not the laptop.
  if (/\b(?:screen ?shot|ss|picture|pic|photo|image)\b/i.test(t) && !/\b(?:laptop|screen|desktop|computer|pc|window)\b/i.test(t.replace(/screen ?shot/gi, ''))) {
    const named = /\b(?!home\b)([a-z]+) (page|section|part|tab)\b/i.exec(t);
    if (named) return show(`${named[1]} ${named[2]}`);
    if (/\b(?:home ?page|website|site|portfolio)\b/i.test(t)) return show('home');
  }
  return null;
}

// "Open portfolio" = the project's website; "open portfolio in VS Code / antigravity" = that editor
// (the user, 2026-10-17: a file or folder only when they say "file" / "folder"). The agent uses this
// only for a project it knows; anything else ("open spotify") goes on as before.
const EDITOR = /^(.+?) (?:in|on|with|using) (?:the )?(vs ?code|visual studio code|cursor|antigravity(?: ide)?|anti gravity|kiro|claude(?: code)?)(?: app| ide| editor)?$/i;
const NOT_A_PROJECT = /\b(?:files?|folders?|pdfs?|docs?|documents?|sheets?|notes?|excel|slides?|ppt|and|it|that|this)\b/i;
export function openCommand(text) {
  const t = clean(text).replace(/[.!?]+$/, '');
  const m = /^open (?:up )?(.+)$/i.exec(t);
  if (!m || NOT_A_PROJECT.test(m[1])) return null;
  const name = (s) => s.replace(/^(?:the |my )?(?:project )?/i, '').replace(/ (?:project|site|website|web ?site|web app|app)$/i, '').trim();
  const ed = EDITOR.exec(m[1]);
  if (ed) return { tool: 'open_project', args: { project: name(ed[1]), editor: ed[2].toLowerCase().replace(/\s+/g, ' ') } };
  const project = name(m[1].replace(/ (?:in|on) (?:the )?(?:browser|chrome|edge)$/i, ''));
  return project ? { tool: 'preview_open', args: { project } } : null;
}
