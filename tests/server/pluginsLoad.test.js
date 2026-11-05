import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Live 2026-11-05: a duplicate import stopped plugins/wiki loading in real Novi while every test passed,
// because the test runner compiles files more forgivingly than Node. This loads them the way Novi does.
describe('every plugin', () => {
  it('loads in plain Node', () => {
    const names = fs.readdirSync('plugins', { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join('plugins', e.name, 'index.js'))).map((e) => e.name);
    const code = `const bad=[];for(const n of ${JSON.stringify(names)}){try{await import('./plugins/'+n+'/index.js')}catch(e){bad.push(n+': '+e.message)}}console.log(JSON.stringify(bad));process.exit(0)`;
    const out = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 });
    expect(JSON.parse(out.stdout.trim().split('\n').at(-1))).toEqual([]);
  }, 70_000);
});
