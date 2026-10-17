// "Show me the homepage / contact page / the site", "homepage dikhao", "stop the preview" — the
// coding project's website preview (plugins/preview), without the AI.
import { clean } from './phrases.js';

const HOME = /^(?:home ?page|home|site|website|preview|main page|landing page)$/i;
const page = (word) => (HOME.test(word) ? 'home' : word.toLowerCase().replace(/\s*page$/, '').trim());
const show = (word, project) => ({ tool: 'preview_show', args: { page: page(word), ...(project ? { project: project.trim() } : {}) } });

export function previewCommand(text) {
  const t = clean(text).replace(/[.!?]+$/, '');
  // A named website (LeetCode login, YouTube…) is the browser's job, not the project's preview.
  if (/\b(?:leet ?code|github|youtube|whats ?app|google|gmail|instagram|login|log in|sign ?in|sign ?up)\b/i.test(t)) return null;
  if (/^(?:stop|close|end) (?:the )?preview$|^preview (?:band|bandh) (?:karo|kar do)$/i.test(t)) return { tool: 'preview_stop', args: {} };
  let m = /^show(?: me)? (?:the |my )?(home ?page|site|website|preview|(?:[a-z]+ )?[a-z]+ page)(?: of (?:my |the )?(.+))?$/i.exec(t);
  if (m) return show(m[1], m[2]);
  m = /^(?:(.+?) ka )?(home ?page|site|website|preview|[a-z]+ page) (?:dikhao|dikha do|dikhaao)$/i.exec(t);
  if (m) return show(m[2], m[1]);
  // "A screenshot / picture / ss of the homepage (of the portfolio)": the project's page, not the laptop.
  if (/\b(?:screen ?shot|ss|picture|pic|photo|image)\b/i.test(t) && !/\b(?:laptop|screen|desktop|computer|pc|window)\b/i.test(t.replace(/screen ?shot/gi, ''))) {
    const named = /\b(?!home\b)([a-z]+) page\b/i.exec(t);
    if (named) return show(`${named[1]} page`);
    if (/\b(?:home ?page|website|site|portfolio)\b/i.test(t)) return show('home');
  }
  return null;
}
