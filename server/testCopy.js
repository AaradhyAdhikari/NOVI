// A second Novi for trying changes next to the real one (Test Novi.cmd): its own port (3002),
// a fresh copy of data/ outside OneDrive, its own notes copy, and none of the background jobs
// that would run twice (reminders, backups, briefing…) or fight over the mic, orb or Chrome link.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_PORT = 3002;
export const TEST_DIST = 'dist-test';
// Plugin services the test copy never starts.
export const TEST_SKIP_SERVICES = ['reminders', 'backup', 'briefing', 'sheets-log', 'claude-link', 'projects', 'orb', 'brain', 'chatgpt-plan'];
// Big or only-useful-to-the-real-Novi folders left out of the copy.
const SKIP_DATA = new Set(['brain', 'logs', 'voice-samples', 'voice-log', 'task-logs', 'backup']);

export const isTestCopy = (env = process.env) => env.NOVI_TEST_COPY === '1';

export function testDataDir(env = process.env) {
  return path.join(env.LOCALAPPDATA || os.tmpdir(), 'Novi', 'test-copy', 'data');
}

export function testCopyEnv(env, { dataDir }) {
  return {
    ...env,
    NOVI_TEST_COPY: '1',
    NOVI_PORT: String(TEST_PORT),
    NOVI_DATA_DIR: dataDir,
    NOVI_MEMORY_DIR: path.join(dataDir, 'Novi Memory'),
    NOVI_PLUGIN_BROWSER_PORT: '3013', // the real Novi's Chrome link keeps 3003
    NOVI_PLUGIN_PREVIEW_PORT: '3015', // and its preview port 3005
    NOVI_ORB: 'off',
    NOVI_PLUGIN_CHATGPT_PLAN_DIR: path.join(dataDir, 'chatgpt'), // the real chatgpt/ copy stays the real Novi's
    NOVI_DIST_DIR: TEST_DIST, // its own screen build, so the real Novi's page never changes under it
  };
}

// Fresh snapshot each start: whatever the test copy changed last time is thrown away.
export function copyData(from, to, { notes } = {}) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  if (fs.existsSync(from)) {
    for (const name of fs.readdirSync(from)) {
      if (SKIP_DATA.has(name)) continue;
      fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true });
    }
  }
  if (notes && fs.existsSync(notes)) fs.cpSync(notes, path.join(to, 'Novi Memory'), { recursive: true });
}
