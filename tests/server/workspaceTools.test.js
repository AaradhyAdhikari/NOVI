import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, readFile, search, writeFile, editFile, runCommand, resolveInProject, aliasInput, runTool } from '../../server/coder/workspaceTools.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi ws ドキュメント '));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const a = 1;\nconsole.log(a);\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'console.log(1)');
});

describe('workspace tools', () => {
  it('lists files, skipping node_modules', async () => {
    expect(await listFiles(root, {})).toBe('src/app.js');
  });

  it('reads with line numbers and paging', async () => {
    expect(await readFile(root, { path: 'src/app.js' })).toBe('1\tconst a = 1;\n2\tconsole.log(a);\n3\t');
    expect(await readFile(root, { path: 'src/app.js', offset: 2, limit: 1 })).toBe('2\tconsole.log(a);\n… (1 more lines; use offset 3)');
  });

  it('searches file contents', async () => {
    expect(await search(root, { pattern: 'console\\.log' })).toBe('src/app.js:2: console.log(a);');
    expect(await search(root, { pattern: 'nothing-here' })).toBe('No matches.');
  });

  it('writes files and edits with a unique exact match', async () => {
    await writeFile(root, { path: 'src/new/x.js', content: 'x = 1\nx = 1\n' });
    await expect(editFile(root, { path: 'src/new/x.js', old_text: 'x = 1', new_text: 'y' })).rejects.toThrow(/occurs 2 times/);
    await expect(editFile(root, { path: 'src/app.js', old_text: 'missing', new_text: 'y' })).rejects.toThrow(/not found/);
    await editFile(root, { path: 'src/app.js', old_text: 'const a = 1;', new_text: 'const a = "$1";' });
    expect(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8')).toBe('const a = "$1";\nconsole.log(a);\n');
  });

  it('refuses paths outside the project', async () => {
    expect(() => resolveInProject(root, '../evil.js')).toThrow(/outside the project/);
    const res = await runTool(root, 'write_file', { path: '../evil.js', content: 'x' });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(root, '..', 'evil.js'))).toBe(false);
  });

  it('runs commands in the project folder and reports exit codes', async () => {
    const ok = await runCommand(root, { command: 'node -e "console.log(process.cwd())"' });
    expect(ok.isError).toBe(false);
    expect(ok.output).toContain('novi ws');
    const bad = await runCommand(root, { command: 'node -e "process.exit(3)"' });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.output).toMatch(/^Exit code 3/);
  });

  it('times out long commands', async () => {
    const res = await runCommand(root, { command: 'node -e "setTimeout(()=>{},10000)"' }, { timeoutMs: 300 });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/Timed out/);
  });

  it('maps inputs to Claude-style names for permissions and narration', () => {
    expect(aliasInput(root, 'write_file', { path: 'a.js' })).toEqual({ file_path: path.join(root, 'a.js') });
    expect(aliasInput(root, 'run_command', { command: 'npm test' })).toEqual({ command: 'npm test' });
    expect(aliasInput(root, 'search', { pattern: 'x' })).toEqual({ pattern: 'x', path: root });
  });
});
