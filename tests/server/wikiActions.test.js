import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createWikiPlugin } from '../../plugins/wiki/index.js';
import { memoryDir, looksSecret } from '../../plugins/wiki/vault.js';

const NOW = new Date(2026, 9, 15, 14, 32);

function setup({ dir } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-wiki-'));
  const vaultDir = dir || path.join(root, 'Novi Memory');
  const host = new PluginHost({ runtime: { dataDir: path.join(root, 'data') }, env: { NOVI_MEMORY_DIR: vaultDir }, logger: { warn() {} } });
  expect(host.register(createWikiPlugin({ now: () => NOW, env: { NOVI_MEMORY_DIR: vaultDir } }))).toBe(true);
  return { host, root, vaultDir };
}
const today = (vaultDir) => fs.readFileSync(path.join(vaultDir, 'Actions', '2026-10-15.md'), 'utf8');

describe('Novi Memory: actions log', () => {
  it('writes one line per action into Actions/<day>.md and makes the home page', async () => {
    const { host, vaultDir } = setup();
    await host.afterToolCall({ toolName: 'file_new_folder', params: { name: 'test' }, result: { created: 'C:\\Users\\a\\Desktop\\test' } });
    await host.afterToolCall({ toolName: 'file_rename', params: { path: 'C:\\Users\\a\\Desktop\\test', newName: 'demo' }, result: { renamed: 'C:\\Users\\a\\Desktop\\demo' } });
    const log = today(vaultDir);
    expect(log).toContain('- 14:32 Made folder **test** — C:\\Users\\a\\Desktop\\test');
    expect(log).toContain('- 14:32 Renamed to **demo** — C:\\Users\\a\\Desktop\\demo');
    expect(fs.existsSync(path.join(vaultDir, 'Novi Memory.md'))).toBe(true);
  });

  it('ignores failed runs and tools it does not log', async () => {
    const { host, vaultDir } = setup();
    await host.afterToolCall({ toolName: 'file_new_folder', params: {}, result: { error: 'x' }, error: 'x' });
    await host.afterToolCall({ toolName: 'weather_get', params: {}, result: { temp: 30 } });
    await host.afterToolCall({ toolName: 'file_rename', params: {}, result: { note: "There's already something called B there." } });
    expect(fs.existsSync(path.join(vaultDir, 'Actions'))).toBe(false);
  });

  it('recent actions: newest first, and the last 5 go into the prompt', async () => {
    const { host } = setup();
    for (let i = 1; i <= 7; i++) await host.afterToolCall({ toolName: 'file_new_folder', params: {}, result: { created: `/x/f${i}` } });
    const out = await host.get('wiki_recent').run({ limit: 3 });
    expect(out.actions.map((a) => a.name)).toEqual(['f7', 'f6', 'f5']);
    expect(out.actions[0]).toMatchObject({ tool: 'file_new_folder', path: '/x/f7' });
    const ctx = await host.promptContext({ prompt: 'rename it', messages: [] });
    expect(ctx.context).toMatch(/Your recent actions \(newest first\)/);
    expect(ctx.context.match(/Made folder/g)).toHaveLength(5);
  });

  it('the recent actions (with paths) join only turns that point back, and keep them private', async () => {
    const { host } = setup();
    await host.afterToolCall({ toolName: 'file_new_folder', params: {}, result: { created: '/x/secret-plans' } });
    for (const prompt of ['move that to the desktop', 'put the folder you just made on the desktop', 'usko delete karo']) {
      const ctx = await host.promptContext({ prompt, messages: [] });
      expect(ctx.context, prompt).toMatch(/secret-plans/);
      expect(ctx.sensitive, prompt).toBe(true);
    }
    const plain = await host.promptContext({ prompt: "what's the weather in Pune", messages: [] });
    expect(`${plain.system || ''}${plain.context || ''}`).not.toMatch(/secret-plans/);
    expect(plain.sensitive).toBe(false);
  });

  it('nothing in the prompt before the first action', async () => {
    const { host } = setup();
    const ctx = await host.promptContext({ prompt: 'hi', messages: [] });
    expect(ctx.system || '').not.toMatch(/recent actions/);
  });

  it('a folder it cannot write still keeps the recent list', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-wiki-ro-'));
    const blocker = path.join(root, 'file');
    fs.writeFileSync(blocker, 'x');
    const { host } = setup({ dir: path.join(blocker, 'Novi Memory') });
    await host.afterToolCall({ toolName: 'file_new_folder', params: {}, result: { created: '/x/a' } });
    expect((await host.get('wiki_recent').run({})).actions[0].name).toBe('a');
  });
});

describe('vault helpers', () => {
  it('memoryDir: NOVI_MEMORY_DIR, else <Documents>\\Novi Memory (OneDrive ドキュメント first)', () => {
    expect(memoryDir({ env: { NOVI_MEMORY_DIR: '/m' }, home: '/h', exists: () => false })).toBe('/m');
    const jp = path.join('/h', 'OneDrive', 'ドキュメント');
    expect(memoryDir({ env: {}, home: '/h', exists: (p) => p === jp })).toBe(path.join(jp, 'Novi Memory'));
    expect(memoryDir({ env: {}, home: '/h', exists: () => false })).toBe(path.join('/h', 'Documents', 'Novi Memory'));
  });

  it('looksSecret', () => {
    expect(looksSecret('my password is hunter2')).toBe(true);
    expect(looksSecret('OTP 482913')).toBe(true);
    expect(looksSecret('card 4111 1111 1111 1111')).toBe(true);
    expect(looksSecret('key gsk_abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
    expect(looksSecret('DBMS exam is on 3 Nov')).toBe(false);
  });
});
