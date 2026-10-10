import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCode, codeSvg } from '../../server/tools/codeView.js';

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-code-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('index.html', '<!doctype html>\n<html>\n<body>\n<button class="cta">Go</button>\n</body>\n</html>\n');
  put('src/style.css', 'body { margin: 0 }\n.cta { color: red }\n');
  put('src/App.jsx', Array.from({ length: 100 }, (_, i) => (i === 70 ? 'export function Navbar() { return <nav/> }' : `// line ${i + 1}`)).join('\n'));
  put('node_modules/x/index.html', '<html>not this</html>');
  return root;
};

describe('findCode ("show me the html code", "show me the navbar code")', () => {
  it('finds a file by language', () => {
    const root = project();
    expect(findCode(root, 'show me the html code')).toMatchObject({ file: 'index.html', start: 1 });
    expect(findCode(root, 'the css')).toMatchObject({ file: path.join('src', 'style.css') });
  });

  it('finds the place a thing is defined and shows the lines around it', () => {
    const root = project();
    const found = findCode(root, 'show me the Navbar code');
    expect(found.file).toBe(path.join('src', 'App.jsx'));
    expect(found.start).toBeLessThanOrEqual(71);
    expect(found.lines[71 - found.start]).toContain('Navbar');
    expect(found.lines.length).toBeLessThanOrEqual(40);
  });

  it('prefers files the coder just wrote, and says when nothing matches', () => {
    const root = project();
    fs.writeFileSync(path.join(root, 'about.html'), '<p>about</p>\n');
    expect(findCode(root, 'html', { recent: [path.join(root, 'about.html')] }).file).toBe('about.html');
    expect(findCode(root, 'show me the rust code')).toBeNull();
  });
});

describe('codeSvg', () => {
  it('draws numbered, escaped lines as a picture', () => {
    const svg = codeSvg({ file: 'index.html', start: 3, lines: ['<b>&</b>', 'x'.repeat(300)] });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(svg).toContain('>3<');
    expect(svg).toContain('index.html');
    expect(svg).not.toContain('x'.repeat(200));
  });
});
