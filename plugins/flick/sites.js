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

// { url, copy? } for one item on one site.
export function aiTarget(site, item) {
  if (item.url) return site.q ? { url: site.q + encodeURIComponent(item.url) } : { url: site.url, copy: { text: item.url } };
  if (item.kind === 'photo') return { url: site.picture || site.url, copy: { image: item.path } };
  return { url: site.url, copy: { file: item.path } };
}
