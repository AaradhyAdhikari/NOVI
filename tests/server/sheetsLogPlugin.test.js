import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createSheetsLogPlugin } from '../../plugins/sheets-log/index.js';

const DRIVE = 'https://www.googleapis.com/auth/drive.file';

function fakeGoogle({ connected = true } = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    resolve: () => (connected ? { account: { id: 'g1', label: 'me', scopes: [DRIVE] } } : { error: 'No Gmail account is connected yet' }),
    async call(acc, url, init = {}) {
      calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets') return { spreadsheetId: 'S1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/S1' };
      if (url.includes(':append')) return { updates: {} };
      throw new Error(`unexpected ${url}`);
    },
  };
}

function setup({ google = fakeGoogle(), commits = [{ repo: 'octo/NOVI', count: 3 }], tasks = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-sheets-'));
  const conv = path.join(dataDir, 'long-term-memory', 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, '2026-10-08.jsonl'), ['{"user":"secret plans","novi":"ok"}', '{"user":"what time","novi":"9"}'].join('\n') + '\n');
  const runtime = {
    dataDir,
    google,
    callTool: async (name, params) => { if (name !== 'github_activity') throw new Error(name); return { date: params.date, commits }; },
    memory: { listTasks: () => tasks },
  };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, log() {} } });
  const jobs = {};
  expect(host.register(createSheetsLogPlugin({ now: () => new Date('2026-10-08T23:51:00'), onJobs: (j) => Object.assign(jobs, j) }))).toBe(true);
  return { host, google, dataDir, jobs };
}

const appends = (google, tab) => google.calls.filter((c) => c.url.includes(`/values/${tab}!A1:append`)).map((c) => c.body.values);

describe('sheets log plugin', () => {
  it('creates the "Novi log" sheet once (3 tabs with headers) and logs study time by voice', async () => {
    const { host, google } = setup();
    const out = await host.get('study_log').run({ topic: 'DSA', minutes: 45 });
    await host.get('study_log').run({ topic: 'OS', hours: 2, date: '2026-10-07' });
    const created = google.calls.filter((c) => c.url === 'https://sheets.googleapis.com/v4/spreadsheets');
    expect(created).toHaveLength(1);
    expect(created[0].body.properties.title).toBe('Novi log');
    expect(created[0].body.sheets.map((s) => s.properties.title)).toEqual(['GitHub', 'Study', 'Novi']);
    expect(appends(google, 'Study')).toEqual([[['Date', 'Topic', 'Hours']], [['2026-10-08', 'DSA', 0.75]], [['2026-10-07', 'OS', 2]]]);
    expect(out.text).toMatch(/0\.75 hours of DSA/);
  });

  it('nightly: GitHub commits per repo, or "none"', async () => {
    const { google, jobs } = setup();
    await jobs.github('2026-10-08');
    expect(appends(google, 'GitHub').at(-1)).toEqual([['2026-10-08', 'octo/NOVI', 3]]);
    const empty = setup({ commits: [] });
    await empty.jobs.github('2026-10-08');
    expect(appends(empty.google, 'GitHub').at(-1)).toEqual([['2026-10-08', 'none', 0]]);
  });

  it('nightly: Novi counts only — never what was said', async () => {
    const tasks = [
      { status: 'done', startedAt: '2026-10-08T10:00:00' },
      { status: 'failed', startedAt: '2026-10-08T11:00:00' },
      { status: 'done', startedAt: '2026-10-07T11:00:00' },
    ];
    const { google, jobs } = setup({ tasks });
    await jobs.novi('2026-10-08');
    expect(appends(google, 'Novi').at(-1)).toEqual([['2026-10-08', 2, 1, 1]]);
    expect(JSON.stringify(google.calls)).not.toContain('secret plans');
  });

  it('gives the sheet link, and explains when Google is not connected', async () => {
    const { host } = setup();
    await host.get('study_log').run({ topic: 'DSA', hours: 1 });
    expect((await host.get('sheets_log_link').run({})).text).toContain('https://docs.google.com/spreadsheets/d/S1');
    const off = setup({ google: fakeGoogle({ connected: false }) });
    await expect(off.host.get('study_log').run({ topic: 'DSA', hours: 1 })).rejects.toThrow(/connect/i);
  });
});
