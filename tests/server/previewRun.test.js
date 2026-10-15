import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { howToRun, findPort } from '../../plugins/preview/run.js';
import { claudeArgs } from '../../server/claude/session.js';

const dir = (files = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-run-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return d;
};

describe('preview: how to run a project (no AI)', () => {
  it('Claude\'s .novi/run.json wins', () => {
    const d = dir({ '.novi/run.json': { command: 'npm run dev', port: 5173, pages: { home: '/', contact: '/contact' } }, 'package.json': { scripts: { start: 'node x' } } });
    expect(howToRun(d)).toEqual({ kind: 'command', command: 'npm run dev', port: 5173, pages: { home: '/', contact: '/contact' } });
  });
  it('package.json dev, else start', () => {
    expect(howToRun(dir({ 'package.json': { scripts: { dev: 'vite', start: 'node s' } } }))).toEqual({ kind: 'command', command: 'npm run dev', port: null, pages: {} });
    expect(howToRun(dir({ 'package.json': { scripts: { start: 'node s' } } }))).toEqual({ kind: 'command', command: 'npm start', port: null, pages: {} });
  });
  it('plain HTML: the folder with index.html (root, public, dist)', () => {
    const a = dir({ 'index.html': '<h1>hi</h1>' });
    expect(howToRun(a)).toEqual({ kind: 'static', root: a, pages: {} });
    const b = dir({ 'public/index.html': 'x' });
    expect(howToRun(b)).toEqual({ kind: 'static', root: path.join(b, 'public'), pages: {} });
    const c = dir({ 'dist/index.html': 'x', 'package.json': { scripts: { build: 'vite build' } } });
    expect(howToRun(c)).toEqual({ kind: 'static', root: path.join(c, 'dist'), pages: {} });
  });
  it('nothing to run → null; a broken run.json is ignored', () => {
    expect(howToRun(dir({ 'notes.txt': 'x' }))).toBe(null);
    expect(howToRun(dir({ '.novi/run.json': '{oops', 'index.html': 'x' })).kind).toBe('static');
  });
  it('reads the port a dev server prints', () => {
    expect(findPort('  ➜  Local:   http://localhost:5174/')).toBe(5174);
    expect(findPort('Server running at http://127.0.0.1:3000')).toBe(3000);
    expect(findPort('ready - started server on 0.0.0.0:3001, url: http://localhost:3001')).toBe(3001);
    expect(findPort('compiling...')).toBe(null);
  });
  it('Claude is asked to write .novi/run.json', () => {
    expect(claudeArgs().join(' ')).toContain('.novi/run.json');
  });
});
