import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PluginHost } from '../../server/plugins/host.js';
import { createCodemapPlugin } from '../../plugins/codemap/index.js';

const node = (id, label, file, extra = {}) => ({ id, label, source_file: file, source_location: 'L5', file_type: 'code', community_name: 'Core', ...extra });
const GRAPH = {
  nodes: [node('app', 'app.js', 'server/app.js'), node('novi', 'createNovi()', 'server/app.js', { _callable: true }), node('aq', 'ApprovalQueue', 'server/permissions.js', { _callable: true })],
  links: [{ source: 'app', target: 'novi', relation: 'contains' }, { source: 'novi', target: 'aq', relation: 'calls' }],
};

function setup({ map = true, git = true, host = 'localhost', fail = false, known = 'Novi' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-'));
  if (git) { fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n'); }
  const write = () => {
    fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify(GRAPH));
    fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.html'), '<html></html>');
  };
  if (map) write();
  const said = [];
  const links = [];
  const opened = [];
  const runs = [];
  const jobs = [];
  const tasks = new EventEmitter();
  const runtime = {
    tasks,
    codingProject: (n) => (!n || /^(novi|calc)$/i.test(n) ? { name: known, path: dir, working: false } : null),
    say: (text, opts) => said.push([text, opts]),
    deviceHost: () => host,
    fileLink: (file, opts) => `/api/download/t?${opts?.inline ? 'inline' : ''}&f=${path.basename(file)}`,
    showLink: (l) => links.push(l),
    openUrl: async (u) => { opened.push(u); },
  };
  const run = async (folder) => { runs.push(folder); if (fail) return { ok: false, error: 'graphify crashed' }; write(); return { ok: true }; };
  const ph = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
  expect(ph.register(createCodemapPlugin({ run, track: (p) => jobs.push(p), openFile: (f) => opened.push(f) }))).toBe(true);
  const tool = async (name, args) => {
    const t = ph.get(name);
    const gate = await t.gate(args);
    const out = await t.run(args);
    await jobs.at(-1);
    return { gate, out };
  };
  return { dir, said, links, opened, runs, tasks, jobs, tool };
}

describe('code map plugin (graphify, no AI)', () => {
  it('explains a part and how two parts connect, from the map file', async () => {
    const s = setup();
    const { out } = await s.tool('codemap_ask', { project: 'novi', part: 'approval queue' });
    expect(out.note).toBe('ApprovalQueue is in server/permissions.js, line 5. It is called by createNovi().');
    expect(out.sensitive).toBe(true);
    const p = await s.tool('codemap_ask', { part: 'app.js', to: 'approval queue' });
    expect(p.out.note).toBe('app.js reaches ApprovalQueue in 2 steps: app.js contains createNovi(), and createNovi() calls ApprovalQueue.');
    const none = await s.tool('codemap_ask', { project: 'novi', part: 'zebra' });
    expect(none.out).toMatchObject({ unknown: true, error: "I couldn't find \"zebra\" in Novi's code map." });
  });

  it('no map yet → says how to make one; unknown project → unknown (the AI may answer)', async () => {
    const s = setup({ map: false });
    const { out } = await s.tool('codemap_ask', { project: 'novi', part: 'agent' });
    expect(out).toMatchObject({ unknown: true, error: 'Novi has no code map yet. Say "map the Novi code" to make one.' });
    expect((await s.tool('codemap_ask', { project: 'bluetooth', part: 'phone' })).out.unknown).toBe(true);
  });

  it('maps a project in the background (asks first only when there is no map), keeps it off GitHub', async () => {
    const s = setup({ map: false });
    const { gate, out } = await s.tool('codemap_build', { project: 'novi' });
    expect(gate.approval).toMatchObject({ title: 'Make a code map of Novi?', tier: 'medium', grantable: true, category: 'files' });
    expect(out.note).toBe("Mapping Novi's code (no AI, up to a few minutes for a big project). I'll tell you when it's done.");
    expect(s.runs).toEqual([s.dir]);
    expect(fs.readFileSync(path.join(s.dir, '.gitignore'), 'utf8')).toBe('node_modules/\ngraphify-out/\n');
    expect(s.said.at(-1)).toEqual(['Mapped Novi: 3 parts and 2 links. The most connected: createNovi(), app.js and ApprovalQueue. (I added graphify-out/ to .gitignore so the map stays off GitHub.)', { kind: null }]);
    const again = await setup().tool('codemap_build', { project: 'novi' });
    expect(again.gate.approval).toBeUndefined();
  });

  it('says a project the way the user said it when Novi only knows it in lowercase (live: "Mapping novi\'s code")', async () => {
    const s = setup({ known: 'novi' });
    expect((await s.tool('codemap_build', { project: 'Novi' })).out.note).toMatch(/^Mapping Novi's code/);
    expect(s.said.at(-1)[0]).toMatch(/^Mapped Novi:/);
    expect((await setup({ known: 'NOVI' }).tool('codemap_build', { project: 'novi' })).out.note).toMatch(/^Mapping NOVI's code/); // Novi's own capitals win
  });

  it('a failed build is said plainly', async () => {
    const s = setup({ fail: true });
    await s.tool('codemap_build', { project: 'novi' });
    expect(s.said.at(-1)[0]).toBe("I couldn't map Novi: graphify crashed");
  });

  it('refreshes a mapped project quietly after a coding task finishes there', async () => {
    const s = setup();
    s.tasks.emit('task', { active: true, project: 'Novi', path: s.dir, status: 'running' });
    s.tasks.emit('task', { active: true, project: 'Novi', path: s.dir, status: 'done' });
    s.tasks.emit('task', { active: true, project: 'Novi', path: s.dir, status: 'done' });
    await Promise.all(s.jobs);
    expect(s.runs).toEqual([s.dir]);
    expect(s.said).toEqual([]);
    const bare = setup({ map: false });
    bare.tasks.emit('task', { active: true, project: 'Novi', path: bare.dir, status: 'done' });
    expect(bare.runs).toEqual([]); // no map → none made without asking
  });

  it('shows the interactive map: a link on the phone (sandboxed page), the browser on the laptop', async () => {
    const phone = setup({ host: 'novi.tail1234.ts.net' });
    const { out } = await phone.tool('codemap_show', { project: 'novi' });
    expect(phone.links).toEqual([{ url: '/api/download/t?inline&f=graph.html', label: "Novi's code map" }]);
    expect(out.note).toBe("Here's Novi's code map. Tap the link to open it.");
    // Live (2026-10-24): a file:// link through url.dll opened nothing (the ドキュメント folder);
    // the plain path through explorer.exe opens it in the default browser.
    const laptop = setup();
    await laptop.tool('codemap_show', {});
    expect(laptop.opened).toEqual([path.join(laptop.dir, 'graphify-out', 'graph.html')]);
  });
});
