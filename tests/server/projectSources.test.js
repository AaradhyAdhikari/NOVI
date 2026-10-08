import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gatherSources } from '../../plugins/projects/sources.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-proj-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\n## State\nRemote access done.\n');
  fs.writeFileSync(path.join(dir, 'app.js'), '// TODO: add dark mode\nconsole.log(1);\n');
  git('add', '-A');
  git('commit', '-qm', 'Add remote access');
  fs.mkdirSync(path.join(dir, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'superpowers', 'plans', '2026-10-08-x.md'), '- [x] done thing\n- [ ] Task 5: project memory\n- [ ] Task 6: briefing\n');
  git('add', '-A');
  git('commit', '-qm', 'Plan automations');
  return dir;
}

describe('gatherSources (where you left off)', () => {
  it('reads recent commits, notes, open plan items, TODOs and last tasks', async () => {
    const dir = repo();
    const s = await gatherSources({ dir, tasks: [{ instruction: 'add easy pairing', status: 'done' }] });
    expect(s.commits).toEqual(['Plan automations', 'Add remote access']);
    expect(s.head).toMatch(/^[0-9a-f]{40}$/);
    expect(s.notes).toContain('Remote access done.');
    expect(s.openItems).toEqual(['Task 5: project memory', 'Task 6: briefing']);
    expect(s.todos.join(' ')).toContain('TODO: add dark mode');
    expect(s.lastTasks).toEqual(['add easy pairing (done)']);
  });

  it('a folder without git or notes gives empty parts instead of failing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-plain-'));
    const s = await gatherSources({ dir, tasks: [] });
    expect(s).toEqual({ commits: [], head: null, notes: '', openItems: [], todos: [], lastTasks: [] });
  });
});
