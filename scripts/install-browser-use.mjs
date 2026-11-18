// Installs browser-use (pinned, see plugins/agents/browseruse.js for why 0.13) into Novi's own Python at
// data/agents/browser-use/venv. Run by hand, once:  node scripts/install-browser-use.mjs
// About 55 MB to download, about 250 MB on disk. Nothing else on the laptop changes; delete that folder to
// remove it. Uses uv when it is installed (faster), else Python's own venv + pip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_USE_VERSION } from '../plugins/agents/browseruse.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(root, 'data', 'agents', 'browser-use', 'venv');
const win = process.platform === 'win32';
const py = path.join(venv, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
const has = (cmd) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const run = (cmd, args) => { console.log(`> ${cmd} ${args.join(' ')}`); execFileSync(cmd, args, { stdio: 'inherit' }); };

fs.mkdirSync(path.dirname(venv), { recursive: true });
const pkg = `browser-use==${BROWSER_USE_VERSION}`;
if (has('uv')) {
  if (!fs.existsSync(py)) run('uv', ['venv', '--python', '3.13', venv]);
  run('uv', ['pip', 'install', '--python', py, pkg]);
} else {
  if (!fs.existsSync(py)) run(win ? 'py' : 'python3', [...(win ? ['-3.13'] : []), '-m', 'venv', venv]);
  run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', pkg]);
}
run(py, ['-I', '-c', 'import browser_use, importlib.metadata as m; print("browser-use", m.version("browser-use"), "ready")']);
