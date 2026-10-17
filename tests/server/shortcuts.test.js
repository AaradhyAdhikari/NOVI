import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShortcuts, phraseKey, replyFrom } from '../../server/brain/shortcuts.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-sc-')), 'shortcuts.json');
const at = (d) => () => new Date(d);

// The user's idea (2026-10-17): what the AI worked out once, Novi does straight away next time.
describe('learned shortcuts', () => {
  it('the same words (any case, filler, full stops) → the same tool at once, kept after a restart', () => {
    const f = file();
    const s = createShortcuts({ file: f });
    expect(s.learn('Open Spotify.', { tool: 'open_app', args: { name: 'Spotify' }, output: { opened: 'Spotify' } })).toBe(true);
    expect(s.find('okay, open spotify please')).toMatchObject({ tool: 'open_app', args: { name: 'Spotify' } });
    expect(createShortcuts({ file: f }).find('open spotify')).toMatchObject({ tool: 'open_app' });
    expect(s.find('open spotify playlist')).toBe(null);
    expect(phraseKey('Hey Novi, can you open Spotify for me?')).toBe('open spotify');
  });

  it('"yesterday" / "today" stay relative: the date is worked out again each time', () => {
    const s = createShortcuts({ file: file(), now: at('2026-10-17T10:00:00') });
    s.learn('show my gidhub contribution yesterday', { tool: 'github_graph', args: { date: '2026-10-16' }, output: { contributions: 4, instructions: 'Sent the graph picture.' } });
    const later = createShortcuts({ file: s.file, now: at('2026-10-20T10:00:00') });
    expect(later.find('show my gidhub contribution yesterday').args).toEqual({ date: '2026-10-19' });
  });

  it('never learns anything that asked, changed something, failed, pointed back ("it") or needs the AI to read the result', () => {
    const s = createShortcuts({ file: file() });
    const ok = { output: { note: 'Done.' } };
    expect(s.learn('delete the test folder', { tool: 'file_delete', args: { name: 'test' }, ...ok })).toBe(false);
    expect(s.learn('message isha hi', { tool: 'whatsapp_send', args: {}, ...ok })).toBe(false);
    expect(s.learn('turn the volume to 50', { tool: 'laptop_volume', args: { level: 50 }, ...ok, asked: true })).toBe(false);
    expect(s.learn('open the zoom app', { tool: 'open_app', args: { name: 'Zoom' }, output: { error: 'Not installed' } })).toBe(false);
    expect(s.learn('open it again', { tool: 'open_app', args: { name: 'Zoom' }, ...ok })).toBe(false);
    expect(s.learn('what are my emails', { tool: 'gmail_list', args: {}, output: { messages: [{ subject: 'x' }] } })).toBe(false);
    expect(s.learn('remind me at 5:30', { tool: 'timer_set', args: { at: '17:30' }, ...ok })).toBe(false);
    expect(s.learn('weather', { tool: 'weather_get', args: {}, ...ok })).toBe(false); // one word: too easy to mix up
    expect(s.list()).toEqual([]);
  });

  it('can be listed and removed; uses are counted', () => {
    const s = createShortcuts({ file: file() });
    s.learn('open spotify', { tool: 'open_app', args: { name: 'Spotify' }, output: { opened: 'Spotify' } });
    s.used('open spotify');
    expect(s.list()).toEqual([expect.objectContaining({ key: 'open spotify', said: 'open spotify', tool: 'open_app', uses: 1 })]);
    expect(s.forget('open spotify')).toBe(true);
    expect(s.find('open spotify')).toBe(null);
  });

  it('the reply comes from the tool itself', () => {
    expect(replyFrom({ note: 'Opened Spotify.' })).toBe('Opened Spotify.');
    expect(replyFrom({ opened: 'Spotify' })).toBe('Opened Spotify.');
    expect(replyFrom({ instructions: 'Sent the graph picture.' })).toBe('');
  });
});
