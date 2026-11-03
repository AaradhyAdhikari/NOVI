import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createDiagramPlugin, repoFrom, diagramUrl } from '../../plugins/diagram/index.js';
import { diagramCommand } from '../../server/brain/diagramCommand.js';

// "Make me a diagram of X" (user, 2026-11-04): GitDiagram draws any GitHub repo; its link is the
// repo's link with "hub" changed to "diagram". Clicking a block opens that code on GitHub.
describe('GitDiagram links', () => {
  it('reads a repo out of any GitHub or GitDiagram link, or owner/name', () => {
    expect(repoFrom('https://github.com/ahmedkhaleel2004/gitdiagram')).toBe('ahmedkhaleel2004/gitdiagram');
    expect(repoFrom('github.com/a-b/c.d.git')).toBe('a-b/c.d');
    expect(repoFrom('git@github.com:AaradhyAdhikari/NOVI.git')).toBe('AaradhyAdhikari/NOVI');
    expect(repoFrom('https://github.com/a/b/tree/main/src')).toBe('a/b');
    expect(repoFrom('https://gitdiagram.com/a/b')).toBe('a/b');
    expect(repoFrom('facebook/react')).toBe('facebook/react');
    expect(repoFrom('https://gitlab.com/a/b')).toBe(null);
    expect(repoFrom('tip calculator')).toBe(null);
    expect(repoFrom('../secrets')).toBe(null);
    expect(diagramUrl('a/b')).toBe('https://gitdiagram.com/a/b');
  });
});

describe('project_diagram', () => {
  function setup({ on = 'laptop', project = null, origin = null, repo = null, status = 200 } = {}) {
    const did = [];
    const links = [];
    const runtime = {
      codingProject: (name) => (name === undefined || project?.name === name ? project : null),
      showLink: (l) => links.push(l),
      callTool: async (name, p) => {
        did.push([name, p]);
        if (name === 'github_repo') return repo ? { name: repo.split('/')[1], url: `https://github.com/${repo}` } : { error: 'no repo' };
        return { opened: p.target, on };
      },
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    const plugin = createDiagramPlugin({ gitOrigin: async () => origin, fetchImpl: async () => ({ status }) });
    expect(host.register(plugin)).toBe(true);
    return { tool: host.get('project_diagram'), did, links };
  }

  it('a link or owner/name goes straight to GitDiagram, opens, and leaves a link on the laptop', async () => {
    const s = setup();
    const out = await s.tool.run({ repo: 'https://github.com/facebook/react' });
    expect(s.did).toEqual([['open_website', { target: 'https://gitdiagram.com/facebook/react' }]]);
    expect(s.links).toEqual([{ url: 'https://gitdiagram.com/facebook/react', label: 'Open the react diagram' }]);
    expect(out.link).toBe('https://gitdiagram.com/facebook/react');
    expect(out.note).toMatch(/react/);
    expect(out.note).toMatch(/block/);
  });

  it('on a phone the tap-to-open link is already there: no second one', async () => {
    const s = setup({ on: 'phone' });
    await s.tool.run({ repo: 'facebook/react' });
    expect(s.links).toEqual([]);
  });

  it('a project: its folder\'s GitHub remote first, else the user\'s repo by name', async () => {
    const a = setup({ project: { name: 'NOVI', path: 'C:\\dev\\NOVI' }, origin: 'https://github.com/AaradhyAdhikari/NOVI.git' });
    expect((await a.tool.run({ project: 'NOVI' })).link).toBe('https://gitdiagram.com/AaradhyAdhikari/NOVI');
    expect(a.did.some(([n]) => n === 'github_repo')).toBe(false);
    const b = setup({ repo: 'AaradhyAdhikari/TraceBites' });
    expect((await b.tool.run({ project: 'tracebites' })).link).toBe('https://gitdiagram.com/AaradhyAdhikari/TraceBites');
  });

  it('no name: the current project', async () => {
    const s = setup({ project: { name: 'Tip calculator', path: 'C:\\dev\\Tip calculator' }, origin: 'git@github.com:a/tip.git' });
    expect((await s.tool.run({})).link).toBe('https://gitdiagram.com/a/tip');
  });

  it('nothing on GitHub: unknown, so the AI can take a diagram of something else', async () => {
    const s = setup();
    const out = await s.tool.run({ project: 'water cycle' });
    expect(out.unknown).toBe(true);
    expect(out.error).toMatch(/water cycle/);
    expect(s.did.some(([n]) => n === 'open_website')).toBe(false);
  });

  it('no name and no current project: says what it needs', async () => {
    expect((await setup().tool.run({})).error).toMatch(/Which project/);
  });

  it('a private repo still opens, and says GitDiagram will ask for a token', async () => {
    const out = await setup({ status: 404 }).tool.run({ repo: 'a/secret' });
    expect(out.link).toBe('https://gitdiagram.com/a/secret');
    expect(out.note).toMatch(/private/i);
  });
});

describe('diagram by voice', () => {
  it('takes the ways it is said', () => {
    const p = (project) => ({ tool: 'project_diagram', args: { project } });
    expect(diagramCommand('make me a diagram of Novi')).toEqual(p('Novi'));
    expect(diagramCommand('Hey Novi, show me the system diagram of my tip calculator project.')).toEqual(p('tip calculator'));
    expect(diagramCommand('give me the architecture diagram for tracebites')).toEqual(p('tracebites'));
    expect(diagramCommand('flexr ka diagram banao')).toEqual(p('flexr'));
    expect(diagramCommand('flexr ka diagram dikhao')).toEqual(p('flexr'));
    expect(diagramCommand('diagram of medikiosk')).toEqual(p('medikiosk'));
    expect(diagramCommand('generate a system diagram of this project')).toEqual({ tool: 'project_diagram', args: {} });
    expect(diagramCommand('make a diagram')).toEqual({ tool: 'project_diagram', args: {} });
  });
  it('a repo link or owner/name is the repo', () => {
    const r = (repo) => ({ tool: 'project_diagram', args: { repo } });
    expect(diagramCommand('make a diagram of https://github.com/facebook/react')).toEqual(r('https://github.com/facebook/react'));
    expect(diagramCommand('diagram of facebook/react')).toEqual(r('facebook/react'));
  });
  it('leaves everything else alone', () => {
    for (const t of ['what is a sequence diagram', 'explain this diagram', 'show me the Novi code map', 'open my diagram notes', 'how do I read a diagram']) {
      expect(diagramCommand(t)).toBe(null);
    }
  });
});
