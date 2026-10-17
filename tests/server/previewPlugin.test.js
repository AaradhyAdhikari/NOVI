import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createPreviewPlugin } from '../../plugins/preview/index.js';

const folder = (files = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-pv-'));
  for (const [n, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), typeof b === 'string' ? b : JSON.stringify(b)); }
  return d;
};
function setup({ project = { name: 'portfolio', path: folder({ '.novi/run.json': { command: 'npm run dev', pages: { contact: '/contact' } } }) }, homeHtml = '<a href="/about-me">About me</a>', shotFails = false, answers = async () => true } = {}) {
  const started = [];
  const shots = [];
  const shown = [];
  const links = [];
  let running = false;
  let stopped = 0;
  const sites = {
    async start(name, dir, plan) { started.push([name, plan.kind]); running = true; return { port: 4321, pages: plan.pages }; },
    running: () => running,
    stop: () => { running = false; return true; },
    stopAll: () => { stopped += 1; },
    list: () => (running ? ['portfolio'] : []),
  };
  const proxy = { start: async () => {}, stop: () => {}, link: ({ project: p, targetPort, host }) => `https://${host}:3005/?novi=tok-${p}-${targetPort}` };
  const runtime = { codingProject: (name) => (name && name !== project?.name ? null : project), showImage: (i) => shown.push(i), showLink: (l) => links.push(l), deviceHost: () => 'laptop.tail.ts.net' };
  const host = new PluginHost({ runtime, logger: { warn() {} } });
  host.register(createPreviewPlugin({
    sites, proxy,
    shot: async (url, size) => { shots.push([url, size]); if (shotFails === 'blank') throw Object.assign(new Error('The picture came out blank (the page may still be loading)'), { blank: true }); if (shotFails) throw new Error('no edge'); return { png: Buffer.from('png') }; },
    fetchHome: async () => homeHtml,
    check: answers,
  }));
  return { host, started, shots, shown, links, stoppedAll: () => stopped, show: host.get('preview_show'), stop: host.get('preview_stop'), status: host.get('preview_status') };
}

describe('preview plugin', () => {
  it('no project → asks which one', async () => {
    const s = setup({ project: null });
    expect((await s.show.run({})).error).toBe('Which project? Say "show me the homepage of portfolio".');
  });

  it('a project command asks once; plain HTML never asks', async () => {
    const s = setup();
    expect((await s.show.gate({})).approval).toMatchObject({ title: 'Start the portfolio site to preview it?', category: 'preview', grantable: true, tier: 'medium' });
    await s.show.run({});
    expect(await s.show.gate({})).toEqual({});
    const st = setup({ project: { name: 'site', path: folder({ 'index.html': 'x' }) } });
    expect(await st.show.gate({})).toEqual({});
  });

  it('nothing to run → hands it to Claude', async () => {
    const s = setup({ project: { name: 'p', path: folder({ 'notes.txt': 'x' }) } });
    expect(await s.show.run({})).toMatchObject({ error: "I don't know how to run this project yet.", askClaude: true });
  });

  it('the contact page: phone-sized picture + live link for the asking device', async () => {
    const s = setup();
    const out = await s.show.run({ page: 'contact' });
    expect(s.shots).toEqual([['http://localhost:4321/contact', { width: 390, height: 844 }]]);
    expect(s.shown[0].png).toBeInstanceOf(Buffer);
    expect(s.links).toEqual([{ url: 'https://laptop.tail.ts.net:3005/?novi=tok-portfolio-4321', label: 'Open the portfolio contact page live' }]);
    expect(out.note).toBe("Here's the contact page. Tap the link to open it live.");
  });

  it('a page found from a link on the homepage; an unknown one falls back to the homepage', async () => {
    const s = setup();
    await s.show.run({ page: 'about' });
    expect(s.shots[0][0]).toBe('http://localhost:4321/about-me');
    const out = await s.show.run({ page: 'blog' });
    expect(s.shots[1][0]).toBe('http://localhost:4321/');
    expect(out.note).toBe("I couldn't find a blog page, so here's the homepage.");
  });

  it('no picture → the link only, said so', async () => {
    const s = setup({ shotFails: true });
    const out = await s.show.run({});
    expect(s.links).toHaveLength(1);
    expect(out.note).toBe("I couldn't take a picture, but here's the live link.");
  });

  it('a blank picture is never sent; the note says why', async () => {
    const s = setup({ shotFails: 'blank' });
    const out = await s.show.run({});
    expect(s.shown).toHaveLength(0);
    expect(out.note).toBe("The picture came out blank (the page may still be loading). Tap the live link to see it.");
  });

  // Live (2026-10-17): a link was sent for a site that wasn't answering ("The site is not answering").
  it('a site that does not answer is started again once; still silent → no link, said so', async () => {
    let calls = 0;
    const once = setup({ answers: async () => (calls += 1) > 1 });
    const out = await once.show.run({});
    expect(once.started).toHaveLength(2);
    expect(once.links).toHaveLength(1);
    expect(out.note).toMatch(/Here's the homepage/);
    const never = setup({ answers: async () => false });
    const bad = await never.show.run({});
    expect(never.links).toHaveLength(0);
    expect(never.shown).toHaveLength(0);
    expect(bad.error).toBe("The portfolio site started but isn't answering. Ask Claude to check that it runs.");
  });

  it('a project name Novi doesn\'t know ("the homepage of the portfolio site") falls back to the current project', async () => {
    const s = setup();
    await s.show.run({ project: 'portfolio site' });
    expect(s.links).toHaveLength(1);
  });

  it('stop the preview; Novi stopping ends every site', async () => {
    const s = setup();
    await s.show.run({});
    expect((await s.stop.run({})).note).toBe('Stopped the portfolio preview.');
    await s.host.stopServices();
    expect(s.stoppedAll()).toBe(1);
  });

  it('says which previews are running', async () => {
    const s = setup();
    expect((await s.status.run({})).note).toBe('');
    await s.show.run({});
    expect((await s.status.run({})).note).toBe('The portfolio preview is running.');
  });
});
