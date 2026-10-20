import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { listClaudeCodeProjects, CONTAINER } from './codeProjects.js';
import { createClaudeWeb } from './claudeWeb.js';

// Novi ⇄ Claude (user, 2026-10-18): every folder Claude Code has worked in becomes one of Novi's
// projects (with a note in Novi Memory), so old projects can be driven by voice like new ones; and
// every project gets a claude.ai Project (name, description, instructions naming its folder) — made
// for each new project and for any coding task on a project that doesn't have one yet.
const reply = (details) => ({ content: [], details: { sensitive: true, ...details } });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const key = (s) => String(s || '').trim().toLowerCase();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const NO_CHROME = "Chrome isn't connected, so I can't reach claude.ai. Open Chrome with the Novi extension and ask again.";

export function createClaudeLinkPlugin({ driver = null, listCode = () => listClaudeCodeProjects(), track = (p) => p.catch(() => {}), now = () => new Date(), syncEveryMs = 30 * 60_000, webEveryMs = 3 * 3600_000 } = {}) {
  return definePluginEntry({
    id: 'claude-link',
    name: 'Claude link',
    description: "Claude Code's projects in Novi's memory, and a claude.ai Project for each of Novi's projects.",
    register(api) {
      const rt = api.runtime || {};
      const log = (m) => api.logger?.info?.(m);
      const file = path.join(rt.dataDir || '.', 'claude-link.json');
      const load = () => { try { return { linked: {}, about: {}, web: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { linked: {}, about: {}, web: [] }; } };
      const state = load();
      const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state, null, 2)); } catch (err) { log(`[claude-link] ${err.message}`); } };
      let web = driver;
      const getWeb = () => web || (rt.browserRequest ? (web = createClaudeWeb({ request: rt.browserRequest })) : null);
      const connected = () => Boolean(rt.browserStatus?.().connected && getWeb());
      const onWeb = (name) => state.web.some((n) => key(n) === key(name));
      const pending = new Set(); // claude.ai projects being made right now
      const displayOf = (at, fallback) => (at?.path ? path.basename(at.path) : fallback);

      // Claude Code's folders → Novi's projects. Returns what changed.
      function syncCode() {
        // A container folder Novi added before this rule existed (Documents, ドキュメント) is forgotten again.
        state.added ||= {};
        for (const [name, at] of Object.entries(state.added)) {
          if (CONTAINER.test(path.basename(at)) || CONTAINER.test(name)) { rt.projects?.forget?.(name); delete state.added[name]; }
        }
        const known = rt.projects?.list?.() || [];
        // "portfolio brief" → "Portfolio brief", next to "Portfolio project".
        for (const k of known) if (k.path) rt.wikiRecase?.(`${path.basename(k.path)} brief`);
        const found = listCode();
        const added = [];
        const taken = [];
        for (const p of found) {
          if (p.about) state.about[key(p.name)] = p.about;
          if (known.some((k) => k.path && samePath(k.path, p.path))) continue;
          if (known.some((k) => key(k.name) === key(p.name))) { taken.push(p.name); continue; }
          try { known.push(rt.projects.remember(p.name, p.path)); } catch (err) { log(`[claude-link] ${p.path}: ${err.message}`); continue; }
          state.added[key(p.name)] = p.path;
          added.push(p.name);
          (state.folderNoted ||= {})[key(p.name)] = true;
          rt.wikiWrite?.({ title: `${p.name} project`, text: `Folder: ${p.path}\nLast worked on in Claude Code: ${new Date(p.lastUsed).toLocaleDateString('en-CA')} (${count(p.sessions, 'conversation', 'conversations')})${p.about ? `\nAbout: ${p.about}` : ''}` });
        }
        save();
        return { found, added, taken };
      }

      // claude.ai's projects → Novi (user, 2026-10-18: "every project I have on Claude… so I can handle them
      // with Novi from anywhere"): each one's link is kept; one with a folder on the laptop is linked to it,
      // one without is a claude.ai-only project. Each gets a note once.
      const squash = (s) => key(s).replace(/[^\p{L}\p{N}]+/gu, '');
      function syncWeb(list) {
        state.web = list.names;
        state.webProjects = list.projects || list.names.map((name) => ({ name, url: null }));
        state.webAt = now().toISOString();
        state.noted ||= {};
        const both = [];
        const only = [];
        for (const p of state.webProjects) {
          const at = rt.codingProject?.(p.name);
          if (at?.path) {
            both.push(p.name);
            if (p.url && !state.linked[key(at.name)]?.url) state.linked[key(at.name)] = { url: p.url, at: now().toISOString() };
          } else only.push(p.name);
          if (state.noted[key(p.name)]) continue;
          state.noted[key(p.name)] = true;
          // The claude.ai name ("FLEXR project"), even when its folder is called something else.
          rt.wikiWrite?.({ title: `${p.name} project`, text: `On claude.ai: ${p.url || 'claude.ai/projects'}\n${at?.path ? `Folder: ${at.path}` : 'No folder on the laptop yet.'}` });
          if (at?.path) (state.folderNoted ||= {})[key(at.name)] = true;
        }
        save();
        if (!state.webProjects.length) return "You don't have any projects on claude.ai yet.";
        const parts = [`On claude.ai you have ${count(state.webProjects.length, 'project', 'projects')}: ${list.names.join(', ')}.`];
        const tail = [];
        if (both.length) tail.push(`${both.length} ${both.length === 1 ? 'is a folder' : 'are folders'} on the laptop too (${both.join(', ')})`);
        if (only.length) tail.push(`${only.length} ${only.length === 1 ? 'is' : 'are'} only on claude.ai (${only.join(', ')})`);
        if (tail.length) parts.push(`${tail.join('; ')}.`);
        return parts.join(' ');
      }
      // Every project that has a folder gets it in its note once (a claude.ai-only project linked to a folder
      // later, like FLEXR, had "No folder…" there), so Novi Memory shows the project's files.
      function healNotes() {
        state.folderNoted ||= {};
        let wrote = 0;
        for (const k of rt.projects?.list?.() || []) {
          const id = key(k.name);
          if (!k.path || state.folderNoted[id]) continue;
          const web = (state.webProjects || []).find((p) => key(p.name) === id);
          rt.wikiWrite?.({ title: `${web?.name || path.basename(k.path)} project`, text: `Folder: ${k.path}` });
          state.folderNoted[id] = true;
          wrote += 1;
        }
        if (wrote) save();
      }

      // Names Novi should expect to hear (the speech-to-text hint).
      if (api.runtime) api.runtime.claudeProjectNames = () => (state.webProjects || []).map((p) => p.name);

      api.registerService({
        id: 'claude-link-sync',
        async start() {
          const run = async () => {
            try { const { added } = syncCode(); if (added.length) log(`[claude-link] new projects from Claude Code: ${added.join(', ')}`); } catch (err) { log(`[claude-link] sync failed: ${err.message}`); }
            try { healNotes(); } catch (err) { log(`[claude-link] notes failed: ${err.message}`); }
            // claude.ai every 3 hours (and soon after Chrome connects), in a background tab.
            if (connected() && (!state.webAt || now() - new Date(state.webAt) > webEveryMs)) {
              try { const list = await getWeb().list(); if (list.names) syncWeb(list); } catch (err) { log(`[claude-link] claude.ai sync failed: ${err.message}`); }
            }
          };
          setTimeout(run, 30_000).unref?.();
          if (syncEveryMs > 0) setInterval(run, syncEveryMs).unref?.();
        },
      });

      api.registerTool({
        name: 'claude_projects_sync',
        description: 'Connect Novi to Claude: remember every project Claude Code has worked on (folders on the laptop) and every claude.ai Project (with its link) as Novi\'s projects. "sync my Claude projects", "bring in my old projects".',
        parameters: obj({}),
        async execute() {
          const { found, added, taken } = syncCode();
          const parts = [found.length
            ? `I know ${count(found.length, 'Claude Code project', 'Claude Code projects')} now: ${added.length ? `${added.length} new (${added.join(', ')})` : 'none new'}.`
            : "I didn't find any Claude Code projects on this laptop."];
          if (taken.length) parts.push(`${taken.length} ${taken.length === 1 ? 'has' : 'have'} a name I already use (${taken.join(', ')}).`);
          if (connected()) {
            const list = await getWeb().list();
            parts.push(list.names ? syncWeb(list) : list.error);
          } else parts.push("Chrome isn't connected, so I didn't check claude.ai.");
          healNotes();
          return reply({ added, taken, web: state.web, note: parts.join(' ') });
        },
      });

      // "Open TraceBite on Claude": the project's claude.ai page on the device that asked (a tap-to-open
      // link on a phone). Any spelling that names one project ("medikiosk" = "MediKiosk AI").
      function findWeb(name) {
        const q = squash(name);
        const all = state.webProjects || [];
        const exact = all.filter((p) => squash(p.name) === q);
        const near = exact.length ? exact : all.filter((p) => q && (squash(p.name).startsWith(q) || q.startsWith(squash(p.name))));
        if (near.length === 1) return near[0];
        const at = rt.codingProject?.(name);
        const linked = at && state.linked[key(at.name)];
        return linked?.url ? { name: displayOf(at, name), url: linked.url } : null;
      }
      api.registerTool({
        name: 'claude_project_open',
        description: 'Open one of the user\'s claude.ai Projects ("open TraceBite on claude.ai", "open my FlexR Claude project") on the device that asked.',
        parameters: obj({ project: str('Project name') }, ['project']),
        async execute(_id, { project } = {}) {
          const p = findWeb(project);
          if (!p) return reply({ error: `I don't know a claude.ai project called ${project}. Say "sync my Claude projects" first.` });
          if (!p.url) return reply({ error: `I don't have the link for ${p.name} yet. Say "sync my Claude projects" with Chrome open.` });
          await rt.callTool('open_website', { url: p.url });
          return reply({ opened: p.name, note: `Opened ${p.name} on claude.ai.` });
        },
      });

      // The claude.ai project for one of Novi's projects, in the background. quiet: only say how it went
      // when it worked or needs the user (the automatic runs).
      async function make({ project, description, display }) {
        const k = key(project);
        pending.add(k);
        try {
          const list = await getWeb().list();
          if (list.names) syncWeb(list);
          if (onWeb(display) || onWeb(project)) {
            state.linked[k] ||= { url: (state.webProjects || []).find((p) => key(p.name) === key(display) || key(p.name) === k)?.url || null, at: now().toISOString() };
            save();
            rt.say?.(`${display} is already on claude.ai.`, { kind: null });
            return;
          }
          const at = rt.codingProject?.(project);
          const about = description || state.about[k] || '';
          const brief = rt.wikiRead?.(`${k} brief`);
          const instructions = [
            `This is the ${display} project. Its code is in ${at?.path || 'my projects folder'} on my laptop, and Claude Code works on it there (my assistant Novi starts it).`,
            about ? `About: ${about}` : '',
            brief ? `The latest plan:\n${brief.slice(0, 3000)}` : '',
          ].filter(Boolean).join('\n\n');
          const out = await getWeb().make({ name: display, description: about || `The ${display} project`, instructions });
          if (out.error) { rt.say?.(out.error, { kind: null }); return; }
          state.linked[k] = { url: out.url, at: now().toISOString() };
          state.web = [...state.web, display];
          state.webProjects = [...(state.webProjects || []), { name: display, url: out.url }];
          (state.noted ||= {})[key(display)] = true;
          save();
          rt.wikiWrite?.({ title: `${display} project`, text: `On claude.ai: ${out.url} (made ${now().toLocaleDateString('en-CA')})` });
          rt.say?.(`Made the ${display} project on claude.ai${out.instructionsMissed ? ", but I couldn't add its instructions — add them on the project page" : ''}.`, { kind: null });
        } finally { pending.delete(k); }
      }

      api.registerTool({
        name: 'claude_project_make',
        description: 'Make a claude.ai Project for one of the user\'s projects ("put portfolio on Claude", "make a Claude project for X"), with its folder and plan as instructions. Runs in Chrome in the background.',
        parameters: obj({ project: str('Project name'), description: str('One line about it (optional)') }, ['project']),
        async execute(_id, { project, description } = {}) {
          const at = rt.codingProject?.(project);
          if (!at) return reply({ error: `I don't know a project called ${project}. Say "sync my Claude projects" first, or tell me its folder.` });
          const k = key(at.name);
          const display = displayOf(at, project);
          const linked = state.linked[k];
          if (linked) return reply({ note: linked.url ? `${display} is already on claude.ai: ${linked.url}` : `${display} is already on claude.ai.` });
          if (!connected()) return reply({ error: NO_CHROME });
          if (pending.has(k)) return reply({ note: `I'm already making ${display} on claude.ai.` });
          track(make({ project: at.name, description, display }).catch((err) => { log(`[claude-link] ${err.message}`); rt.say?.(`Making ${display} on claude.ai failed: ${err.message}`, { kind: null }); }));
          return reply({ note: `Making the ${display} project on claude.ai in Chrome…` });
        },
      });

      api.on('before_tool_call', ({ toolName, params = {} }) => {
        if (toolName !== 'claude_project_make') return undefined;
        const title = `Make a claude.ai project for ${params.project}`;
        return { requireApproval: { title, description: 'In Chrome, on your Claude account.', prompt: title, severity: 'warning', category: 'claude' } };
      });

      // New projects, and coding on a project that isn't on claude.ai yet: make it there too (the
      // user's standing rule, so no second question). Chrome missing → nothing, the next task tries again.
      api.on('after_tool_call', ({ toolName, params = {}, result = {}, error } = {}) => {
        if (error || result?.error) return;
        const project = toolName === 'code_new_project' && result.created ? result.project || params.name
          : toolName === 'code_start_task' && result.started ? params.project : null;
        if (!project) return;
        const at = rt.codingProject?.(project);
        if (!at) return;
        const k = key(at.name);
        // Its dot in Novi Memory (the brief, README and pictures hang off it), Chrome or not.
        if (at.path && !(state.folderNoted ||= {})[k]) {
          state.folderNoted[k] = true;
          save();
          rt.wikiWrite?.({ title: `${displayOf(at, project)} project`, text: `Folder: ${at.path}${toolName === 'code_new_project' && params.description ? `\nAbout: ${params.description}` : ''}` });
        }
        if (!connected()) return;
        if (state.linked[k] || pending.has(k)) return;
        track(make({ project: at.name, description: toolName === 'code_new_project' ? params.description : '', display: displayOf(at, project) }).catch((err) => log(`[claude-link] ${err.message}`)));
      });
    },
  });
}

export default createClaudeLinkPlugin();
