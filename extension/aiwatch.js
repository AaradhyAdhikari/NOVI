// Runs in ChatGPT, Gemini, Perplexity and Gamma pages. When an answer has finished arriving, it tells the
// extension, which tells Novi. Reads only the newest answer; Novi's own hidden work tabs are left out
// (those are briefs Novi already handles). Selectors are best guesses until tried on each live site.
const REST_CHECKS = 3; // the text must stay the same this many checks
const CHECK_MS = 1500;
const MAX_TEXT = 6000;
const AI_SITES = {
  'chatgpt.com': { name: 'ChatGPT', busy: 'button[data-testid="stop-button"], button[aria-label*="Stop"]', answer: '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]' },
  'gemini.google.com': { name: 'Gemini', busy: 'button[aria-label*="Stop response"]', answer: 'model-response' },
  'www.perplexity.ai': { name: 'Perplexity', busy: 'button[aria-label*="Stop"]', answer: '[id^="markdown-content"], .prose' },
  'gamma.app': { name: 'Gamma', busy: '[aria-label*="Stop"], [data-testid*="generating"]', answer: '.ProseMirror' },
};

// One check of the page. Reports the text once when an answer that really arrived (the stop button was up,
// or it grew over several checks) has come to rest. A chat opened from history appears in one jump: no report.
function noviWatchStep(state, { text, busy }) {
  if (state.last === undefined) { state.last = text; state.reported = text; state.grew = 0; state.rest = 0; state.wasBusy = false; state.first = true; return null; }
  if (busy) { state.wasBusy = true; state.rest = 0; state.last = text; return null; }
  if (text !== state.last) {
    state.grew += 1;
    state.rest = 0;
    state.last = text;
    return null;
  }
  state.rest += 1;
  if (state.rest < REST_CHECKS || !text || text === state.reported) return null;
  const arrived = state.wasBusy || state.grew >= 2;
  state.reported = text;
  state.grew = 0;
  state.wasBusy = false;
  return arrived ? text : null;
}
globalThis.noviWatchStep = noviWatchStep;

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  const site = AI_SITES[location.hostname];
  const isWorkTab = () => { try { return Boolean(sessionStorage.getItem('__noviWork')); } catch { return false; } };
  if (site) {
    const state = {};
    const newest = () => {
      const all = document.querySelectorAll(site.answer);
      return all.length ? String(all[all.length - 1].innerText || '').trim().slice(0, MAX_TEXT) : '';
    };
    setInterval(() => {
      if (isWorkTab()) return;
      const text = noviWatchStep(state, { text: newest(), busy: Boolean(document.querySelector(site.busy)) });
      if (text) chrome.runtime.sendMessage({ type: 'ai_answer', site: site.name, text }).catch(() => {});
    }, CHECK_MS);
  }
}
