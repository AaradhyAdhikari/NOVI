import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodeEdits } from '../../server/codeEdits.js';

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-edit-'));
  fs.writeFileSync(path.join(root, 'contact.html'), ['<h1>Contact</h1>', '<form>', '<button>Send</button>', '</form>', '<footer/>'].join('\n'));
  return root;
};

// "Show me the code for the contact page" → the code in the chat with Edit / Approve; Approve saves the
// user's version into the project at once (2026-10-17).
describe('code edits from the chat', () => {
  it('saves the edited lines in place of the shown ones, nothing else', () => {
    const root = project();
    const edits = createCodeEdits();
    const id = edits.offer({ root, file: 'contact.html', start: 2, lines: ['<form>', '<button>Send</button>', '</form>'] });
    const out = edits.save(id, '<form class="big">\n<button>Send now</button>\n<input name="email">\n</form>');
    expect(out).toMatchObject({ file: 'contact.html', start: 2, end: 5, changed: true });
    expect(fs.readFileSync(path.join(root, 'contact.html'), 'utf8')).toBe(['<h1>Contact</h1>', '<form class="big">', '<button>Send now</button>', '<input name="email">', '</form>', '<footer/>'].join('\n'));
  });

  it('keeps Windows line endings; an unchanged save changes nothing', () => {
    const root = project();
    fs.writeFileSync(path.join(root, 'contact.html'), 'a\r\nb\r\nc\r\n');
    const edits = createCodeEdits();
    const id = edits.offer({ root, file: 'contact.html', start: 1, lines: ['a', 'b', 'c', ''] });
    expect(edits.save(id, 'a\nb\nc\n')).toMatchObject({ changed: false });
    const id2 = edits.offer({ root, file: 'contact.html', start: 2, lines: ['b'] });
    edits.save(id2, 'B');
    expect(fs.readFileSync(path.join(root, 'contact.html'), 'utf8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('refuses when the file changed since it was shown (Claude kept working), or the card is old or unknown', () => {
    const root = project();
    let now = 0;
    const edits = createCodeEdits({ now: () => now, ttlMs: 1000 });
    const id = edits.offer({ root, file: 'contact.html', start: 1, lines: ['<h1>Contact</h1>'] });
    fs.appendFileSync(path.join(root, 'contact.html'), '\n<p>new</p>');
    expect(() => edits.save(id, '<h1>Hi</h1>')).toThrow(/changed since/i);
    const id2 = edits.offer({ root, file: 'contact.html', start: 1, lines: ['<h1>Contact</h1>'] });
    now = 2000;
    expect(() => edits.save(id2, 'x')).toThrow(/ask for the code again/i);
    expect(() => edits.save('nope', 'x')).toThrow(/ask for the code again/i);
  });

  it('never writes outside the project folder', () => {
    const root = project();
    const edits = createCodeEdits();
    expect(() => edits.offer({ root, file: '../evil.txt', start: 1, lines: [] })).toThrow();
  });
});
