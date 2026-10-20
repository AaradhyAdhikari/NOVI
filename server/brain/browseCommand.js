// "Browse X" without the AI (user, 2026-10-20: "a browser dot so it doesn't use any AI and whenever I
// say browse this it's easy"). Live, opening a website through the AI took 21–25 s; this is instant.
// Only clear website requests: "browse X" (anything — unknown words become a Google search), or
// "open/go to/visit X" when X is a domain, a known site or says website/site. Apps, files, folders,
// projects and YouTube playing stay with their own routes (which run before this one).

// Known sites by name → address (a domain in the words always wins).
const SITES = {
  youtube: 'https://www.youtube.com', google: 'https://www.google.com', gmail: 'https://mail.google.com',
  github: 'https://github.com', chatgpt: 'https://chatgpt.com', 'chat gpt': 'https://chatgpt.com', claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com', leetcode: 'https://leetcode.com', linkedin: 'https://www.linkedin.com',
  instagram: 'https://www.instagram.com', facebook: 'https://www.facebook.com', twitter: 'https://x.com', reddit: 'https://www.reddit.com',
  'stack overflow': 'https://stackoverflow.com', stackoverflow: 'https://stackoverflow.com', wikipedia: 'https://www.wikipedia.org',
  amazon: 'https://www.amazon.in', flipkart: 'https://www.flipkart.com', netflix: 'https://www.netflix.com',
  'whatsapp web': 'https://web.whatsapp.com', 'google drive': 'https://drive.google.com', drive: 'https://drive.google.com',
  'google docs': 'https://docs.google.com', 'google sheets': 'https://sheets.google.com', 'google maps': 'https://maps.google.com',
  maps: 'https://maps.google.com', 'google calendar': 'https://calendar.google.com', notion: 'https://www.notion.so',
  figma: 'https://www.figma.com', vercel: 'https://vercel.com', canva: 'https://www.canva.com', codeforces: 'https://codeforces.com',
  geeksforgeeks: 'https://www.geeksforgeeks.org', 'geeks for geeks': 'https://www.geeksforgeeks.org', hackerrank: 'https://www.hackerrank.com',
};
const LEAD = /^(?:(?:ok(?:ay)?|hey|hi)[,\s]+)?(?:(?:hey )?novi[,\s]+)?(?:(?:can|could|would) you |please )?/i;
const TAIL = /\s*(?:please|for me|right now|now)\s*$/i;
const ON = /\s*(?:on|in) (?:my |the )?(laptop|computer|pc)\s*$|\s*laptop (?:pe|par|mein)\s*$/i;
const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?$/i;
// Words that mean something other than a website.
const NOT_SITE = /\b(?:file|files|folder|folders|notes?|app|project|downloads?|documents?|desktop|play|song|video)\b|\band\b/i;

const urlOf = (name) => {
  const s = name.trim().replace(/[.!?,]+$/, '');
  const d = DOMAIN.exec(s);
  if (d) return /^https?:\/\//i.test(s) ? s : `https://${d[1].toLowerCase()}${d[2] || ''}`;
  return SITES[s.toLowerCase()] || null;
};

export function browseCommand(text) {
  let t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').replace(TAIL, '').trim();
  let on = null;
  if (ON.test(t)) { on = 'laptop'; t = t.replace(ON, '').trim(); }
  const out = (target) => (on ? { target, on } : { target });
  if (/^(?:browse|open) (?:this|it|that)(?: (?:link|page|site|website))?(?: in (?:the )?(?:browser|chrome))?$/i.test(t)) return on ? { last: true, on } : { last: true };

  // "browse X": always a website — a known one, a domain, or a Google search.
  let m = /^browse (?:to |for )?(.+)$/i.exec(t);
  if (m) {
    const what = m[1].trim();
    if (/^(?:my |the )?(?:files?|folders?|downloads|documents|desktop)\b/i.test(what)) return null;
    return out(urlOf(what) || what);
  }
  // "open/go to/visit X (website|site)", "X (website) kholo / khol do".
  m = /^(open|go to|visit|take me to) (?:the )?(.+?)(?: (website|site|web ?site|page|in the browser|in chrome))?$/i.exec(t)
    || /^()(.+?)(?: (website|site))? (?:kholo|khol do|open karo|pe jao)$/i.exec(t);
  if (!m) return null;
  const name = m[2].trim();
  const said = Boolean(m[3]) || /^(?:visit|take me to)$/i.test(m[1]); // "visit X" is always a website
  if (NOT_SITE.test(name)) return null;
  const url = urlOf(name);
  // A bare name ("open spotify", "go to chrome") is an app or a window unless it is a domain, or a known site said with "website".
  if (DOMAIN.test(name)) return out(url);
  return said && url ? out(url) : null;
}
