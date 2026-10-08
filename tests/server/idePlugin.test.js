import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createIdePlugin, EDITORS } from '../../plugins/ide/index.js';

const LOCAL = 'C:\\Users\\me\\AppData\\Local';
const PROJECTS = { novi: { name: 'novi', path: 'C:\\code\\novi' }, leetcode: { name: 'leetcode', path: 'C:\\code\\leet;code' } };
const memory = {
  findProject: (n) => PROJECTS[String(n).toLowerCase()] || null,
  listProjects: () => Object.values(PROJECTS),
};

function setup({ env = {}, installed = () => true } = {}) {
  const launched = [];
  const spawn = (cmd, args, opts) => { launched.push({ cmd, args, opts }); return { unref() {}, on() {} }; };
  const host = new PluginHost({ runtime: { memory }, env, logger: { warn() {} } });
  expect(host.register(createIdePlugin({ spawn, exists: installed, localAppData: LOCAL }))).toBe(true);
  const open = (params) => host.get('open_project').run(params);
  return { host, launched, open };
}

describe('ide plugin: open a project in an editor', () => {
  it('opens a remembered project in VS Code, directly (no shell)', async () => {
    const { open, launched } = setup();
    const out = await open({ project: 'Novi', editor: 'VS Code' });
    expect(launched).toHaveLength(1);
    expect(launched[0].cmd).toBe(path.join(LOCAL, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    expect(launched[0].args).toEqual(['C:\\code\\novi']);
    expect(launched[0].opts).toMatchObject({ detached: true, shell: false });
    expect(out.text).toMatch(/Opened novi in VS Code/);
  });

  it('understands the usual names for each editor', () => {
    const pick = (name) => EDITORS.find((e) => e.names.includes(name.toLowerCase()))?.id;
    expect(pick('code')).toBe('vscode');
    expect(pick('visual studio code')).toBe('vscode');
    expect(pick('Cursor')).toBe('cursor');
    expect(pick('antigravity')).toBe('antigravity');
    expect(pick('kiro')).toBe('kiro');
    expect(pick('claude')).toBe('claude-code');
    expect(pick('Claude Code')).toBe('claude-code');
  });

  it('opens Claude Code in a Windows Terminal tab inside the project folder', async () => {
    const { open, launched } = setup();
    await open({ project: 'novi', editor: 'claude code' });
    expect(launched[0].cmd).toBe('wt.exe');
    expect(launched[0].args).toEqual(['-d', 'C:\\code\\novi', 'claude']);
  });

  it('refuses folder names Windows Terminal would split into extra commands', async () => {
    const { open, launched } = setup();
    const out = await open({ project: 'leetcode', editor: 'claude code' });
    expect(launched).toEqual([]);
    expect(out.text).toMatch(/can't open .* in Claude Code/i);
  });

  it('lists the known projects when the name is unknown', async () => {
    const { open, launched } = setup();
    const out = await open({ project: 'mystery', editor: 'cursor' });
    expect(launched).toEqual([]);
    expect(out.text).toMatch(/don't know a project called "mystery"/);
    expect(out.text).toMatch(/novi/);
  });

  it('asks which editor when none is named and no default is set', async () => {
    const { open, launched } = setup();
    const out = await open({ project: 'novi' });
    expect(launched).toEqual([]);
    expect(out.text).toMatch(/Which editor/);
  });

  it('uses the default editor from NOVI_PLUGIN_IDE_DEFAULT_EDITOR', async () => {
    const { open, launched } = setup({ env: { NOVI_PLUGIN_IDE_DEFAULT_EDITOR: 'cursor' } });
    await open({ project: 'novi' });
    expect(launched[0].cmd).toBe(path.join(LOCAL, 'Programs', 'cursor', 'Cursor.exe'));
  });

  it('says so when the editor is not installed', async () => {
    const { open, launched } = setup({ installed: () => false });
    const out = await open({ project: 'novi', editor: 'kiro' });
    expect(launched).toEqual([]);
    expect(out.text).toMatch(/Kiro isn't installed/);
  });

  it('opening needs no approval', async () => {
    const { host } = setup();
    expect(await host.get('open_project').gate({ project: 'novi', editor: 'vscode' })).toEqual({});
  });
});

describe('ide plugin vs coding tasks', () => {
  it('tells the brain not to open Claude Code when the user also gives a coding instruction', () => {
    const { host } = setup();
    const schema = host.schemas().find((s) => s.function.name === 'open_project');
    expect(schema.function.description).toMatch(/code_start_task/);
  });
});
