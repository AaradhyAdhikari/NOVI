import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_PHRASES, createSampleStore } from '../../server/voice/samples.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-samples-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('test phrases', () => {
  it('cover English, Hindi, Marathi and Hinglish with unique ids', () => {
    const ids = TEST_PHRASES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lang of ['en', 'hi', 'mr', 'hinglish']) expect(TEST_PHRASES.filter((p) => p.lang === lang).length, lang).toBeGreaterThanOrEqual(4);
    for (const p of TEST_PHRASES) expect(p.text.trim().length, p.id).toBeGreaterThan(3);
  });

  it('write Hindi and Marathi in Devanagari', () => {
    for (const p of TEST_PHRASES.filter((x) => x.lang === 'hi' || x.lang === 'mr')) expect(p.text, p.id).toMatch(/[ऀ-ॿ]/);
  });
});

describe('sample store', () => {
  it('saves a recording with its expected text and lists progress', () => {
    const store = createSampleStore({ dir });
    const phrase = TEST_PHRASES[0];
    const saved = store.save({ phraseId: phrase.id, audio: Buffer.from('RIFFdata'), mimeType: 'audio/wav' });
    expect(saved.file).toMatch(new RegExp(`^${phrase.id}-\\d+\\.wav$`));
    expect(fs.readFileSync(path.join(dir, saved.file), 'utf8')).toBe('RIFFdata');
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ file: saved.file, phraseId: phrase.id, lang: phrase.lang, expected: phrase.text });
    expect(store.recordedIds()).toEqual([phrase.id]);
  });

  it('uses .webm for browser recordings without voice detection', () => {
    const saved = createSampleStore({ dir }).save({ phraseId: TEST_PHRASES[1].id, audio: Buffer.from('x'), mimeType: 'audio/webm' });
    expect(saved.file).toMatch(/\.webm$/);
  });

  it('rejects unknown phrases and empty audio', () => {
    const store = createSampleStore({ dir });
    expect(() => store.save({ phraseId: '../../evil', audio: Buffer.from('x') })).toThrow(/Unknown phrase/);
    expect(() => store.save({ phraseId: TEST_PHRASES[0].id, audio: Buffer.alloc(0) })).toThrow(/No audio/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('starts empty', () => {
    expect(createSampleStore({ dir: path.join(dir, 'missing') }).list()).toEqual([]);
  });
});
