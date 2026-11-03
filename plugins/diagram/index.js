import { execFile } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';

// "Make me a diagram of X" (user, 2026-11-04): GitDiagram (gitdiagram.com, MIT) draws any GitHub repo
// as an interactive system diagram; its address is the repo's with "hub" changed to "diagram", so
// only the repo's name leaves Novi. Opens on the device that asked: the laptop's browser plus a link
// in the chat, or a tap-to-open link on a phone. Clicking a block opens that code on GitHub.
const PART = '[\\w.-]+';
const LINK = new RegExp(`(?:github|gitdiagram)\\.com[/:](${PART})/(${PART})`, 'i');
const SHORT = new RegExp(`^(${PART})/(${PART})$`);

export function repoFrom(text) {
  const t = String(text || '').trim();
  const m = LINK.exec(t) || SHORT.exec(t);
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) return null;
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
}

export const diagramUrl = (repo) => `https://gitdiagram.com/${repo}`;

const originOf = (folder) => new Promise((resolve) => {
  execFile('git', ['-C', folder, 'remote', 'get-url', 'origin'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim()));
});

export function createDiagramPlugin({ gitOrigin = originOf, fetchImpl = fetch } = {}) {
  return definePluginEntry({
    id: 'diagram',
    name: 'System diagrams',
    description: 'Opens an interactive system diagram of any GitHub repo on GitDiagram.',
    register(api) {
      const rt = api.runtime || {};
      const reply = (details) => ({ content: [], details });

      // The folder's own GitHub remote is exact; the user's repos by name cover claude.ai-only projects.
      async function findRepo(project) {
        const known = rt.codingProject?.(project || undefined);
        const origin = known?.path ? repoFrom(await gitOrigin(known.path)) : null;
        if (origin || !(project || known?.name)) return origin;
        const found = await rt.callTool('github_repo', { name: project || known.name }).catch(() => null);
        return repoFrom(found?.url);
      }

      // GitHub says 404 for a private repo; any other trouble just skips the warning.
      const isPrivate = (repo) => fetchImpl(`https://api.github.com/repos/${repo}`, { headers: { 'User-Agent': 'Novi' } })
        .then((res) => res.status === 404, () => false);

      api.registerTool({
        name: 'project_diagram',
        description: 'Open an interactive system / architecture diagram of a GitHub repo or one of the user\'s projects, with a link that works on laptop and phone. For "make me a diagram of X". Not for diagrams of things that aren\'t code.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: "One of the user's projects, any spelling. Leave out for the current project." },
            repo: { type: 'string', description: 'A GitHub link or owner/name, if the user gave one' },
            phone: { type: 'boolean', description: 'True when the user asked for it on their phone' },
          },
        },
        async execute(_id, { project, repo, phone } = {}) {
          const slug = repoFrom(repo) || repoFrom(project) || await findRepo(project);
          if (!slug) {
            return reply(project
              ? { unknown: true, error: `I couldn't find ${project} on GitHub. Give me its GitHub link and I'll draw it.` }
              : { unknown: true, error: 'Which project should I draw? Say its name or give me its GitHub link.' });
          }
          const url = diagramUrl(slug);
          const name = slug.split('/')[1];
          if (phone) {
            if (!rt.linkToPhone?.({ url, label: `Open the ${name} diagram` })) return reply({ link: url, error: `Your phone isn't connected to Novi. Open the Novi app on it. The link is ${url}` });
            return reply({ link: url, note: `Sent the ${name} diagram to your phone. It's in Novi's chat there.` });
          }
          const opened = await rt.callTool('open_website', { target: url });
          if (opened?.on !== 'phone') rt.showLink?.({ url, label: `Open the ${name} diagram` });
          const secret = await isPrivate(slug);
          return reply({
            opened: name,
            link: url,
            note: `Here's the ${name} system diagram. The first time for a repo can take a minute. Click any block to see its code.`
              + (secret ? ' It looks private, so GitDiagram will ask for a GitHub token under Private Repos.' : ''),
          });
        },
      });
    },
  });
}

export default createDiagramPlugin();
