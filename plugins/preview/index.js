// "Show me the homepage": runs the coding project's website (no AI to find how), sends a
// phone-sized picture of the page and a protected live link (preview port, one-time link) to the
// device that asked. Starting a project's own command asks once per project per Novi run.
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

// The page's path: Claude's run.json pages, else a link on the homepage whose text names it.
function pagePath(page, pages, homeHtml) {
  if (isHome(page)) return { path: '/', found: true };
  const word = String(page).trim().toLowerCase().replace(/\s*page$/, '');
  const key = Object.keys(pages || {}).find((k) => k.toLowerCase() === word);
  if (key) return { path: pages[key], found: true };
  for (const m of String(homeHtml || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, ' ').toLowerCase();
    if (text.includes(word) && /^\/(?!\/)/.test(m[1])) return { path: m[1], found: true };
  }
  return { path: '/', found: false };
}

// Does the site answer at all? (any HTTP reply within 5 s)
async function answersHttp(port) {
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(5000) }); return true; } catch { return false; }
}

export function createPreviewPlugin({ sites = createSites(), proxy = null, shot = pageShot, fetchHome = null, check = answersHttp } = {}) {
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
          const where = pagePath(page, site.pages, isHome(page) ? '' : await readHome(site.port));
          const label = where.found && !isHome(page) ? `${String(page).trim().toLowerCase().replace(/\s*page$/, '')} page` : 'homepage';
          let pictured = true;
          let blank = false;
          try {
            const { png } = await shot(`http://localhost:${site.port}${where.path}`, PHONE);
            runtime.showImage?.({ png, caption: `${p.name} — ${label}` });
          } catch (err) { pictured = false; blank = Boolean(err?.blank); }
          runtime.showLink?.({ url: link.link({ project: p.name, targetPort: site.port, host: runtime.deviceHost?.() || 'localhost' }), label: `Open the ${p.name} ${label} live` });
          const note = blank ? 'The picture came out blank (the page may still be loading). Tap the live link to see it.'
            : !pictured ? "I couldn't take a picture, but here's the live link."
            : !where.found ? `I couldn't find a ${String(page).trim().toLowerCase().replace(/\s*page$/, '')} page, so here's the homepage.`
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
