import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createFilesPlugin } from '../../plugins/files/index.js';

async function setup({ google } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-fp-'));
  const put = (rel, text = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  put('Documents/College/DBMS Notes.md', '# DBMS\nNormalization: 1NF, 2NF, 3NF.');
  put('Downloads/dbms unit 1.pdf');
  put('Desktop/DBMS assignment.pdf');
  put('Downloads/os notes.pdf');
  const opened = [];
  const said = [];
  const jobs = [];
  const host = new PluginHost({
    logger: { warn() {} },
    env: {},
    runtime: {
      dataDir: path.join(root, 'data'),
      privateComplete: async (prompt) => `Summary of: ${prompt.match(/File: (.*)/)[1]}. It covers normalization.`,
      say: (text, opts) => said.push([text, opts]),
      google,
    },
  });
  const plugin = createFilesPlugin({ roots: [root], home: root, docsDir: path.join(root, 'Documents'), openPath: async (p) => opened.push(p), onJob: (p) => jobs.push(p), refreshMs: 0 });
  expect(host.register(plugin)).toBe(true);
  await host.startServices?.();
  await plugin.ready;
  return { host, root, opened, said, jobs };
}

describe('files plugin', () => {
  it('declares its tools in the manifest', async () => {
    const { host } = await setup();
    const manifest = JSON.parse(fs.readFileSync(path.resolve('plugins/files/openclaw.plugin.json'), 'utf8'));
    expect(host.plugins.find((p) => p.id === 'files').tools.sort()).toEqual([...manifest.contracts.tools].sort());
  });

  it('file_find lists the best matches (private: file names stay on Groq)', async () => {
    const { host } = await setup();
    const out = await host.get('file_find').run({ query: 'DBMS notes' });
    expect(out.files[0]).toMatchObject({ name: 'DBMS Notes.md' });
    expect(out.sensitive).toBe(true);
  });

  it('file_open opens the best match on the laptop', async () => {
    const { host, opened } = await setup();
    const out = await host.get('file_open').run({ query: 'dbms assignment' });
    expect(path.basename(opened[0])).toBe('DBMS assignment.pdf');
    expect(out.opened).toBe('DBMS assignment.pdf');
  });

  it('file_summary answers at once and summarizes in the background, then says it', async () => {
    const { host, said, jobs } = await setup();
    const out = await host.get('file_summary').run({ query: 'DBMS notes' });
    expect(out.note).toMatch(/Reading DBMS Notes.md.*tell you/);
    await Promise.all(jobs);
    expect(said[0][0]).toBe('Summary of: DBMS Notes.md. It covers normalization.');
    expect(said[0][1]).toMatchObject({ kind: null });
  });

  it('file_gather moves all PDFs about a topic into a new folder after one OK, and undo puts them back', async () => {
    const { host, root } = await setup();
    const gate = await host.get('file_gather').gate({ topic: 'DBMS', kind: 'pdf', folder: 'DBMS PDFs' });
    expect(gate.approval.prompt).toBe('Move 2 PDFs about DBMS into DBMS PDFs. OK?');
    expect(gate.approval.detail).toMatch(/dbms unit 1\.pdf[\s\S]*DBMS assignment\.pdf|DBMS assignment\.pdf[\s\S]*dbms unit 1\.pdf/);
    const out = await host.get('file_gather').run({ topic: 'DBMS', kind: 'pdf', folder: 'DBMS PDFs' });
    expect(out.moved).toBe(2);
    expect(fs.readdirSync(path.join(root, 'Documents', 'DBMS PDFs')).sort()).toEqual(['DBMS assignment.pdf', 'dbms unit 1.pdf']);
    expect(fs.existsSync(path.join(root, 'Downloads', 'os notes.pdf'))).toBe(true);
    expect((await host.get('file_undo_move').gate({})).approval.prompt).toBe('Put 2 files back where they were. OK?');
    await host.get('file_undo_move').run({});
    expect(fs.existsSync(path.join(root, 'Downloads', 'dbms unit 1.pdf'))).toBe(true);
  });

  it('Google Sheets: finds the sheet by name and summarizes its rows', async () => {
    const calls = [];
    const google = {
      configured: true,
      resolve: () => ({ account: { id: 'g1' } }),
      call: async (acc, url) => {
        calls.push(url);
        if (url.includes('/drive/v3/files')) return { files: [{ id: 'S1', name: 'Sales Analysis', modifiedTime: '2026-10-01' }] };
        if (url.includes('values:batchGet')) return { valueRanges: [{ range: "'Q1'!A1:B2", values: [['Month', 'Sales'], ['Jan', '1200']] }] };
        return { sheets: [{ properties: { title: 'Q1' } }] };
      },
    };
    const { host, said, jobs } = await setup({ google });
    await host.get('file_summary').run({ query: 'sales analysis', where: 'google' });
    await Promise.all(jobs);
    expect(said[0][0]).toBe('Summary of: Sales Analysis (Google Sheet). It covers normalization.');
    expect(decodeURIComponent(calls[0])).toContain("name contains 'sales' and name contains 'analysis'");
  });
});

describe('files plugin during the first scan', () => {
  it('says it is still listing the files instead of "not found"', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-fp-'));
    const host = new PluginHost({ logger: { warn() {} }, env: {}, runtime: { dataDir: path.join(root, 'data') } });
    const plugin = createFilesPlugin({ roots: [root], home: root, openPath: async () => {}, refreshMs: 0, readyWaitMs: 10 });
    host.register(plugin);
    // services not started yet = the first scan hasn't finished
    await expect(host.get('file_open').run({ query: 'dbms notes' })).rejects.toThrow(/still listing your files/);
    expect((await host.get('file_find').run({ query: 'dbms notes' })).note).toMatch(/still listing your files/);
  });
});
