// Novi Flick v2: the AI sites a flicked thing can go to. A link goes straight into the site's question where the
// site takes one in its address (?q=); otherwise (and for pictures and files) it is copied and the site opens,
// so one Ctrl+V adds it. Only these fixed sites: the user can never be sent anywhere a page or a name chose.
export const AI_SITES = {
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', q: 'https://chatgpt.com/?q=' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
  claude: { name: 'Claude', url: 'https://claude.ai/new', q: 'https://claude.ai/new?q=' },
  perplexity: { name: 'Perplexity', url: 'https://www.perplexity.ai/', q: 'https://www.perplexity.ai/search?q=' },
  google: { name: 'Google', url: 'https://www.google.com/', q: 'https://www.google.com/search?q=', picture: 'https://lens.google.com/' },
};

const AI_WORDS = { chatgpt: 'chatgpt', 'chat gpt': 'chatgpt', gpt: 'chatgpt', gemini: 'gemini', claude: 'claude', perplexity: 'perplexity', google: 'google', 'google lens': 'google', lens: 'google' };

// The "Send to" box after a flick (user, 2026-11-16): a typed place → an AI site from the list, else a WhatsApp
// contact ("Rahul", "Rahul on WhatsApp"). Never a website a name chose.
export function destination(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '').replace(/^(?:send(?: it)?|share|forward)?\s*(?:to\s+)?/i, '').trim();
  if (!t) return null;
  const app = AI_WORDS[t.toLowerCase()];
  if (app) return { action: 'ai', app };
  const to = t.replace(/\s+on\s+whats\s?app$/i, '').replace(/^whats\s?app\s+/i, '').trim();
  return to ? { action: 'whatsapp', to: to.slice(0, 60) } : null;
}

// { url, copy? } for one item on one site.
export function aiTarget(site, item) {
  if (item.text) return site.q && item.text.length <= 1500 ? { url: site.q + encodeURIComponent(item.text) } : { url: site.url, copy: { text: item.text } };
  if (item.url) return site.q ? { url: site.q + encodeURIComponent(item.url) } : { url: site.url, copy: { text: item.url } };
  if (item.kind === 'photo') return { url: site.picture || site.url, copy: { image: item.path } };
  return { url: site.url, copy: { file: item.path } };
}
