import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (f) => fs.readFileSync(new URL(`../../extension/${f}`, import.meta.url), 'utf8');

describe('Novi Chrome extension (static checks; it runs only in Chrome)', () => {
  it('manifest: MV3 with only the permissions it needs', () => {
    const m = JSON.parse(read('manifest.json'));
    expect(m.manifest_version).toBe(3);
    expect([...m.permissions].sort()).toEqual(['alarms', 'scripting', 'storage', 'tabs']);
    expect(m.host_permissions).toEqual(['<all_urls>']);
    expect(m.background.service_worker).toBe('background.js');
    expect(m.action.default_popup).toBe('popup.html');
  });

  it('scripts are valid JavaScript', () => {
    for (const f of ['background.js', 'page.js', 'popup.js']) {
      expect(() => execFileSync(process.execPath, ['--check', new URL(`../../extension/${f}`, import.meta.url).pathname]), f).not.toThrow();
    }
  });

  it('connects only to Novi on this laptop, with the code first', () => {
    const bg = read('background.js');
    expect(bg).toMatch(/new WebSocket\(`ws:\/\/127\.0\.0\.1:\$\{port\}`\)/);
    expect(bg).not.toMatch(/wss?:\/\/(?!127\.0\.0\.1)/);
    expect(bg).toMatch(/type: 'hello', code/);
  });

  it('password fields: only "empty or not" leaves the page, and Novi never types into them', () => {
    const page = read('page.js');
    const pwLine = page.split('\n').find((l) => l.includes("type === 'password'") && l.includes('empty'));
    expect(pwLine).toBeTruthy();
    expect(pwLine).not.toMatch(/value:/);
    expect(page).toMatch(/I don't type passwords/);
  });
});
