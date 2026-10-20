import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testCopyEnv, copyData, isTestCopy, TEST_SKIP_SERVICES, testDataDir } from '../../server/testCopy.js';
import { PluginHost } from '../../server/plugins/host.js';

const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-test-copy-')); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('test copy env', () => {
  it('moves every port, the data folder and the notes away from the real Novi', () => {
    const env = testCopyEnv({ PATH: 'x', NOVI_PORT: '3001' }, { dataDir: 'D:\\t\\data' });
    expect(env.PATH).toBe('x');
    expect(env.NOVI_PORT).toBe('3002');
    expect(env.NOVI_DATA_DIR).toBe('D:\\t\\data');
    expect(env.NOVI_MEMORY_DIR).toBe(path.join('D:\\t\\data', 'Novi Memory'));
    expect(env.NOVI_PLUGIN_BROWSER_PORT).toBe('3013');
    expect(env.NOVI_PLUGIN_PREVIEW_PORT).toBe('3015');
    expect(env.NOVI_ORB).toBe('off');
    expect(env.NOVI_DIST_DIR).toBe('dist-test'); // its own screen build: the real Novi's dist/ is never touched
    expect(isTestCopy(env)).toBe(true);
    expect(isTestCopy({})).toBe(false);
  });

  it('keeps the data outside OneDrive', () => {
    expect(testDataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toBe(path.join('C:\\Users\\a\\AppData\\Local', 'Novi', 'test-copy', 'data'));
  });

  it('turns off the jobs that would run twice or reach outside', () => {
    for (const id of ['reminders', 'backup', 'briefing', 'sheets-log', 'claude-link', 'projects', 'orb', 'brain']) expect(TEST_SKIP_SERVICES).toContain(id);
    expect(TEST_SKIP_SERVICES).not.toContain('browser');
  });
});

describe('copyData', () => {
  it('copies a fresh snapshot without the big or private-to-the-real-Novi folders', () => {
    const from = mkdir();
    const to = path.join(mkdir(), 'data');
    fs.writeFileSync(path.join(from, 'reminders.json'), '[1]');
    for (const skip of ['brain', 'logs', 'voice-samples', 'voice-log', 'task-logs', 'backup']) {
      fs.mkdirSync(path.join(from, skip));
      fs.writeFileSync(path.join(from, skip, 'big.bin'), 'x');
    }
    fs.mkdirSync(path.join(from, 'files'));
    fs.writeFileSync(path.join(from, 'files', 'index.json'), '{}');
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'stale.json'), 'old');

    copyData(from, to);

    expect(fs.readFileSync(path.join(to, 'reminders.json'), 'utf8')).toBe('[1]');
    expect(fs.existsSync(path.join(to, 'files', 'index.json'))).toBe(true);
    expect(fs.existsSync(path.join(to, 'stale.json'))).toBe(false);
    for (const skip of ['brain', 'logs', 'voice-samples', 'voice-log', 'task-logs', 'backup']) expect(fs.existsSync(path.join(to, skip))).toBe(false);
  });

  it('copies the notes folder into the test data when given', () => {
    const from = mkdir();
    const notes = mkdir();
    fs.writeFileSync(path.join(notes, 'Novi Memory.md'), '# hi');
    const to = path.join(mkdir(), 'data');
    copyData(from, to, { notes });
    expect(fs.readFileSync(path.join(to, 'Novi Memory', 'Novi Memory.md'), 'utf8')).toBe('# hi');
  });

  it('works when the real Novi has no data yet', () => {
    const to = path.join(mkdir(), 'data');
    copyData(path.join(mkdir(), 'missing'), to, { notes: path.join(mkdir(), 'missing') });
    expect(fs.existsSync(to)).toBe(true);
  });
});

describe('PluginHost.startServices skip', () => {
  it('starts only services of plugins not in the skip list', async () => {
    const host = new PluginHost({ logger: { warn() {}, log() {} } });
    const started = [];
    for (const id of ['reminders', 'files']) {
      host.register({ id, name: id, description: id, register(api) { api.registerService({ id, start: () => started.push(id) }); } });
    }
    await host.startServices({ skip: ['reminders'] });
    expect(started).toEqual(['files']);
  });
});
