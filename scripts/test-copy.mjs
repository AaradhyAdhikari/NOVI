// Test Novi.cmd: starts a second Novi on https://localhost:3002 next to the real one (3001).
// Each start copies data/ and Novi Memory fresh into %LOCALAPPDATA%\Novi\test-copy, so nothing
// the test copy does touches the real Novi's data. Close the window (or Ctrl+C) to stop it.
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCopyEnv, copyData, testDataDir, TEST_PORT, TEST_DIST } from '../server/testCopy.js';
import { uiIsStale } from '../server/supervisor.js';
import { memoryDir } from '../plugins/wiki/vault.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const url = `https://localhost:${TEST_PORT}`;
const openPage = () => { try { execSync(`start "" ${url}`, { stdio: 'ignore', windowsHide: true }); } catch { /* not on Windows */ } };

const inUse = await new Promise((resolve) => {
  const s = net.connect(TEST_PORT, '127.0.0.1', () => { s.destroy(); resolve(true); }).on('error', () => resolve(false));
});
if (inUse) {
  console.log(`The test copy is already running. Opening ${url}…`);
  openPage();
  process.exit(0);
}

// Its own build folder: building into dist/ would change the real Novi's page too.
if (uiIsStale(root, TEST_DIST)) {
  console.log('Building the screen for the test copy…');
  execSync(`npx.cmd vite build --outDir ${TEST_DIST} --emptyOutDir`, { stdio: 'inherit' });
}

const dataDir = testDataDir();
console.log(`Copying your data into ${dataDir}…`);
copyData(path.join(root, 'data'), dataDir, { notes: memoryDir({ home: os.homedir() }) });

const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'], {
  cwd: root,
  env: testCopyEnv(process.env, { dataDir }),
  stdio: ['ignore', 'pipe', 'inherit'],
});
let opened = false;
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (!opened && String(chunk).includes('TEST COPY of Novi is running')) { opened = true; openPage(); }
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
