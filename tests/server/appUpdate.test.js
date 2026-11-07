import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { latestApp, updateCard } from '../../server/appUpdate.js';
import { createNovi } from '../../server/app.js';

// User, 2026-11-07: "give me an update when i need to update the app by saying something like update required
// with the link … in the novi itself so that i can directly update the app from my phone".
describe('which app is newest', () => {
  it('reads the last build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-'));
    const file = path.join(dir, 'output-metadata.json');
    fs.writeFileSync(file, JSON.stringify({ elements: [{ versionCode: 21, versionName: '2.4.6' }] }));
    expect(latestApp(file)).toEqual({ code: 21, name: '2.4.6' });
  });
  it('no build on this laptop: nothing to offer', () => {
    expect(latestApp('C:/nope/output-metadata.json')).toBe(null);
  });
});

describe('the update card', () => {
  const latest = { code: 21, name: '2.4.6' };
  it('an older app gets one, with the link', () => {
    expect(updateCard(20, latest)).toEqual({ key: 'app-update', title: 'Update required', body: 'Novi 2.4.6 is ready. Tap Update to install it.', link: '/Novi.apk' });
  });
  it('the newest app, a newer one, or unknown versions get none', () => {
    expect(updateCard(21, latest)).toBe(null);
    expect(updateCard(22, latest)).toBe(null);
    expect(updateCard(undefined, latest)).toBe(null);
    expect(updateCard(20, null)).toBe(null);
  });
});

describe('Novi checks the app that connects', () => {
  const start = (latest) => {
    const tasks = Object.assign(new EventEmitter(), { status: () => ({ active: false }), stop: async () => false, setAllowEdits: () => {}, shutdown: async () => {} });
    return createNovi({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'novi-au-')), providers: [], order: { fast: [], long: [] }, claudeCommand: 'claude', coder: 'free' }, {
      tasks, agent: { handle: async () => '' }, router: { status: () => [] }, transcribe: async () => '', lanUrls: [],
      cipher: { protect: async (v) => v, unprotect: async (v) => v }, latestApp: () => latest,
    });
  };
  it('an old app gets the card once, however often it reconnects', () => {
    const novi = start({ code: 21, name: '2.4.6' });
    novi.checkAppVersion(20);
    novi.checkAppVersion(20);
    const cards = novi.snapshot().notices.filter((n) => n.key === 'app-update');
    expect(cards).toHaveLength(1);
    expect(cards[0].link).toBe('/Novi.apk');
  });
  it('once updated, the card goes by itself', () => {
    const novi = start({ code: 21, name: '2.4.6' });
    novi.checkAppVersion(20);
    novi.checkAppVersion(21);
    expect(novi.snapshot().notices.filter((n) => n.key === 'app-update')).toEqual([]);
  });
});
