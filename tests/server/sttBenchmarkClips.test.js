import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadClips } from '../../tools/stt-benchmark.mjs';

describe('speech benchmark clips', () => {
  it('uses the latest voice-test recording per phrase plus your real commands marked "Wrong"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-bench-'));
    fs.writeFileSync(path.join(dir, 'a1.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'a2.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'index.jsonl'), [
      { phraseId: 'p1', lang: 'en', expected: 'old take', file: 'a1.wav' },
      { phraseId: 'p1', lang: 'en', expected: 'new take', file: 'a2.wav' },
      { phraseId: 'p2', lang: 'hi', expected: 'missing file', file: 'gone.wav' },
    ].map((l) => JSON.stringify(l)).join('\n'));
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'r1.webm'), 'x');
    fs.writeFileSync(path.join(dir, 'real', 'expected.json'), JSON.stringify([{ file: 'r1.webm', said: 'open OpenClaw', heard: 'open open claw' }, { file: 'gone.wav', said: 'x', heard: 'y' }]));
    const clips = loadClips(dir);
    expect(clips.map((c) => [c.phraseId, c.lang, c.expected, c.mimeType])).toEqual([
      ['p1', 'en', 'new take', 'audio/wav'],
      ['real:r1.webm', 'real', 'open OpenClaw', 'audio/webm'],
    ]);
  });

  it('works before anything is recorded', () => {
    expect(loadClips(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-bench-')))).toEqual([]);
  });
});
