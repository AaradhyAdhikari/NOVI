// "Show me the homepage": runs the coding project's website (no AI to find how), sends a
// phone-sized picture of the page and a protected live link (preview port, one-time link) to the
// device that asked. Starting a project's own command asks once per project per Novi run.
import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { pageShot } from '../screen/pageShot.js';
import { howToRun } from './run.js';
import { createSites } from './sites.js';
import { createPreviewProxy } from './proxy.js';

const PHONE = { width: 390, height: 844 };
const reply = (details) => ({ content: [], details });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const NO_PROJECT = 'Which project? Say "show me the homepage of portfolio".';
const isHome = (page) => !page || /^(home|homepage|home page|main|index|site|website|landing)$/i.test(String(page).trim());

// What the user asked to see ("blog", "blog section", "contact page") → the word.
const pageWord = (page) => String(page || '').trim().toLowerCase().replace(/\s*(?:page|section|part|tab)$/, '');
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Where it is: Claude's run.json pages; a link on the homepage whose text or address names it
// (/blog, blog.html, #blog); a section of the homepage with that id; a blog.html in the project.
// kind: 'page' or 'section' (a part of the homepage). Not found → found: false (live 2026-10-18:
// "the blog section" must never come back as the homepage).
function pagePath(page, pages, homeHtml, root) {
  if (isHome(page)) return { path: '/', found: true, kind: 'page' };
  const word = pageWord(page);
  const key = Object.keys(pages || {}).find((k) => k.toLowerCase() === word);
  if (key) return { path: pages[key], found: true, kind: 'page' };
  const html = String(homeHtml || '');
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].trim();
    const text = m[2].replace(/<[^>]+>/g, ' ').toLowerCase();
    if ((!text.includes(word) && !href.toLowerCase().includes(word)) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
    if (href.startsWith('#')) return { path: `/${href}`, found: true, kind: 'section' };
    return { path: href.startsWith('/') ? href : `/${href.replace(/^\.\//, '')}`, found: true, kind: 'page' };
  }
  const id = new RegExp(`\\bid\\s*=\\s*["']([^"']*${escapeRe(word)}[^"']*)["']`, 'i').exec(html);
  if (id) return { path: `/#${id[1]}`, found: true, kind: 'section' };
  for (const f of [`${word}.html`, `${word}/index.html`, `pages/${word}.html`, `public/${word}.html`]) {
    if (root && fs.existsSync(path.join(root, f))) return { path: `/${f.replace(/^public\//, '').replace(/index\.html$/, '')}`, found: true, kind: 'page' };
  }
  return { path: '/', found: false };
}

// Does the site answer at all? (any HTTP reply within 5 s)
async function answersHttp(port) {
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(5000) }); return true; } catch { return false; }
}

export function createPreviewPlugin({ sites = createSites(), proxy = null, shot = pageShot, fetchHome = null, check = answersHttp, followEveryMs = 5000 } = {}) {
  return definePluginEntry({
    id: 'preview',
    name: 'Preview',
    description: "Show the coding project's website on the phone: a picture and a live link.",
    register(api) {
      const runtime = api.runtime || {};
      const link = proxy || createPreviewProxy({ port: Number(api.pluginConfig?.port || process.env.NOVI_PREVIEW_PORT) || 3005, tls: runtime.tls || null });
      const readHome = fetchHome || (async (port) => { try { return await (await fetch(`http://localhost:${port}/`)).text(); } catch { return ''; } });
      const allowed = new Set(); // projects whose command the user already OK'd in this run
      // A name Novi doesn't know ("the portfolio site") falls back to the current coding project.
      const project = (name) => runtime.codingProject?.(name) || (name ? runtime.codingProject?.() : null) || null;

      // A picture taken while the coder is still working may be out of date in a minute (live
      // 2026-10-17: the old button colour): once the coder is done, send a fresh one (once, ≤20 min).
      const following = new Set();
      function followUp(p, url, label) {
        if (following.has(p.name)) return;
        following.add(p.name);
        const until = Date.now() + 20 * 60_000;
        const tick = async () => {
          const now = project(p.name);
          if (now?.working && Date.now() < until) { setTimeout(tick, followEveryMs).unref?.(); return; }
          following.delete(p.name);
          if (!now || now.working) return;
          try {
            const { png } = await shot(url, PHONE);
            runtime.showImage?.({ png, caption: `${p.name} — ${label}, after Claude finished` });
          } catch { /* the site was stopped or the picture failed: the live link still works */ }
        };
        setTimeout(tick, followEveryMs).unref?.();
      }

      // The project's site, running and answering → { p, site }, else { error, askClaude? }.
      async function start(name) {
        const p = project(name);
        if (!p) return { error: NO_PROJECT };
        const plan = howToRun(p.path);
        if (!plan) return { error: "I don't know how to run this project yet.", askClaude: true };
        allowed.add(p.name);
        try {
          let site = await sites.start(p.name, p.path, plan);
          // Never hand out a link to a site that isn't answering: start it once more, then say so.
          if (!(await check(site.port))) {
            sites.stop(p.name);
            site = await sites.start(p.name, p.path, plan);
            if (!(await check(site.port))) { sites.stop(p.name); return { error: `The ${p.name} site started but isn't answering. Ask Claude to check that it runs.` }; }
          }
          return { p, site };
        } catch (err) { return { error: String(err.message || err) }; }
      }

      api.registerTool({
        name: 'preview_show',
        description: "Show the user a page of the coding project's website (picture + live link on their device). page: home, contact, about…",
        parameters: obj({ page: { type: 'string' }, project: { type: 'string' } }),
        async execute(_id, { page, project: name } = {}) {
          const started = await start(name);
          if (started.error) return reply(started);
          const { p, site } = started;
          const where = pagePath(page, site.pages, isHome(page) ? '' : await readHome(site.port), p.path);
          if (!where.found) return reply({ note: `I couldn't find a ${pageWord(page)} page or section on the ${p.name} site, so I didn't send a picture. If Claude is still adding it, ask again when it's done.`, port: site.port });
          const label = isHome(page) ? 'homepage' : `${pageWord(page)} ${where.kind}`;
          let pictured = true;
          let blank = false;
          const url = `http://localhost:${site.port}${where.path}`;
          try {
            const { png } = await shot(url, PHONE);
            runtime.showImage?.({ png, caption: `${p.name} — ${label}` });
          } catch (err) { pictured = false; blank = Boolean(err?.blank); }
          if (p.working) followUp(p, url, label);
          runtime.showLink?.({ url: link.link({ project: p.name, targetPort: site.port, host: runtime.deviceHost?.() || 'localhost' }), label: `Open the ${p.name} ${label} live` });
          const note = p.working ? `Claude is still working on ${p.name}, so this is how it looks right now. I'll send a fresh picture when Claude finishes.`
            : blank ? 'The picture came out blank (the page may still be loading). Tap the live link to see it.'
            : !pictured ? "I couldn't take a picture, but here's the live link."
            : `Here's the ${label}. Tap the link to open it live.`;
          return reply({ note, port: site.port });
        },
      });

      // "Open portfolio": the site itself — in the laptop's browser when asked at the laptop, a
      // tap-to-open link on a phone. No picture.
      api.registerTool({
        name: 'preview_open',
        description: "Open the coding project's website (\"open portfolio\"): in the laptop's browser, or a link on the phone. For opening it in an editor use open_project.",
        parameters: obj({ project: { type: 'string' } }),
        async execute(_id, { project: name } = {}) {
          const started = await start(name);
          if (started.error) return reply(started);
          const { p, site } = started;
          const host = runtime.deviceHost?.() || 'localhost';
          if (host === 'localhost') {
            const out = await runtime.callTool?.('open_website', { target: `http://localhost:${site.port}/`, on: 'laptop' });
            if (out?.error) return reply({ error: out.error });
            return reply({ note: `Opened the ${p.name} site.`, port: site.port });
          }
          runtime.showLink?.({ url: link.link({ project: p.name, targetPort: site.port, host }), label: `Open the ${p.name} site` });
          return reply({ note: `Here's the ${p.name} site. Tap the link to open it.`, port: site.port });
        },
      });

      api.registerTool({
        name: 'preview_stop',
        description: "Stop the coding project's website preview.",
        parameters: obj({ project: { type: 'string' } }),
        async execute(_id, { project: name } = {}) {
          const p = project(name);
          if (!p || !sites.stop(p.name)) return reply({ note: 'No preview is running.' });
          return reply({ note: `Stopped the ${p.name} preview.` });
        },
      });

      api.registerTool({
        name: 'preview_status',
        description: 'Which coding-project website previews are running right now.',
        parameters: obj({}),
        async execute() {
          const names = sites.list?.() || [];
          const note = !names.length ? '' : names.length === 1 ? `The ${names[0]} preview is running.` : `Previews running: ${names.join(', ')}.`;
          return reply({ note, running: names });
        },
      });

      // Running the project's own command = running its code: ask once per project per Novi run.
      api.on('before_tool_call', async ({ toolName, params = {} }) => {
        if (toolName !== 'preview_show' && toolName !== 'preview_open') return undefined;
        const p = project(params.project);
        if (!p || allowed.has(p.name) || sites.running(p.name)) return undefined;
        if (howToRun(p.path)?.kind !== 'command') return undefined;
        const title = `Start the ${p.name} site to preview it?`;
        return { requireApproval: { title, prompt: title, severity: 'warning', category: 'preview', grantable: true } };
      });

      api.registerService({
        id: 'preview',
        start: () => link.start().catch((err) => api.logger?.warn?.(`[preview] port not started: ${err.message}`)),
        stop: () => { sites.stopAll(); link.stop(); },
      });
    },
  });
}

export default createPreviewPlugin();
