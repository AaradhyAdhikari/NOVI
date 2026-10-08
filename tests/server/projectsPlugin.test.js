import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createProjectsPlugin, matchesProject } from '../../plugins/projects/index.js';

const SOURCES = { commits: ['Add easy pairing', 'Add notifications'], head: 'h1', notes: 'Novi', openItems: ['Retrain wake word', 'Voice benchmark', 'Calendar setup', 'Browser agent'], todos: [], lastTasks: [] };

function setup({ ai = async () => 'Last time you added easy pairing. Still open: retrain the wake word.', sources = SOURCES, title = '' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-projects-'));
  const said = [];
  const prompts = [];
  let current = { ...sources };
  let day = new Date('2026-10-08T10:00:00');
  let windowTitle = title;
  const runtime = {
    dataDir,
    memory: { listProjects: () => [{ name: 'NOVI CONTEXT', path: 'C:/p/novi', lastUsed: '2026-10-08' }, { name: 'flexr', path: 'C:/p/flexr', lastUsed: '2026-10-01' }], listTasks: () => [{ project: 'NOVI CONTEXT', status: 'done' }] },
    privateComplete: async (prompt) => { prompts.push(prompt); return ai(prompt); },
    say: (t) => said.push(t),
  };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, log() {} } });
  let checkOpen;
  expect(host.register(createProjectsPlugin({ gather: async () => current, now: () => day, activeWindow: async () => windowTitle, onCheck: (fn) => { checkOpen = fn; } }))).toBe(true);
  return {
    host, said, prompts, dataDir,
    next: (p = {}) => host.get('project_next').run(p),
    setSources: (s) => { current = { ...current, ...s }; },
    setTitle: (t) => { windowTitle = t; },
    setDay: (iso) => { day = new Date(iso); },
    checkOpen: () => checkOpen(),
  };
}

describe('projects plugin: where you left off', () => {
  it('answers "what\'s next" for the last-used project, privately, and caches by git HEAD', async () => {
    const t = setup();
    const out = await t.next();
    expect(out.text).toMatch(/easy pairing/);
    expect(out.sensitive).toBe(true);
    expect(t.prompts[0]).toContain('Retrain wake word');
    await t.next({ project: 'novi' });
    expect(t.prompts).toHaveLength(1); // cached: nothing changed
    t.setSources({ head: 'h2', commits: ['Add Sarvam'] });
    await t.next();
    expect(t.prompts).toHaveLength(2); // new commit → fresh summary
  });

  it('if the private AI is down, lists the open items itself (never another provider)', async () => {
    const t = setup({ ai: async () => { throw new Error('groq busy'); } });
    const out = await t.next();
    expect(out.text).toBe('Last time: Add easy pairing. Still open: Retrain wake word; Voice benchmark; Calendar setup.');
  });

  it('a named project that Novi does not know gets a clear answer', async () => {
    const t = setup();
    await expect(t.next({ project: 'zzz' })).rejects.toThrow(/don't know a project called "zzz"/);
  });

  it('opening a project in an editor triggers "last time on…" once a day', async () => {
    const t = setup();
    t.setTitle('app.js - NOVI CONTEXT - Visual Studio Code');
    await t.checkOpen();
    await t.checkOpen();
    expect(t.said).toEqual(['Last time on NOVI CONTEXT: Last time you added easy pairing. Still open: retrain the wake word.']);
    t.setTitle('Inbox - Gmail - Google Chrome');
    await t.checkOpen();
    t.setDay('2026-10-09T09:00:00');
    t.setTitle('NOVI CONTEXT - Antigravity');
    await t.checkOpen();
    expect(t.said).toHaveLength(2);
  });

  it('matches editor window titles to project names', () => {
    expect(matchesProject('app.js - NOVI CONTEXT - Visual Studio Code', 'NOVI CONTEXT')).toBe(true);
    expect(matchesProject('flexr — Cursor', 'flexr')).toBe(true);
    expect(matchesProject('NOVI CONTEXT - File Explorer', 'NOVI CONTEXT')).toBe(false);
  });
});
