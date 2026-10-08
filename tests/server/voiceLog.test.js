import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVoiceLog, suggestFix } from '../../server/voice/voiceLog.js';

const dirs = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-vlog-'));
  return { dir: path.join(root, 'voice-log'), realDir: path.join(root, 'voice-samples', 'real') };
};
const audio = (n) => Buffer.from([1, 2, 3, n]);

describe('misunderstanding log', () => {
  it('logs what was heard, what it became, and the reply; newest first', () => {
    const log = createVoiceLog(dirs());
    const a = log.add({ heard: 'open claw', text: 'OpenClaw', audio: audio(1), mimeType: 'audio/wav', source: 'wake' });
    log.add({ heard: 'what time is it', text: 'what time is it', audio: audio(2), mimeType: 'audio/webm', source: 'talk' });
    log.setReply(a, 'Opening OpenClaw.');
    const recent = log.recent();
    expect(recent.map((e) => e.heard)).toEqual(['what time is it', 'open claw']);
    expect(recent[1]).toMatchObject({ id: a, text: 'OpenClaw', reply: 'Opening OpenClaw.', source: 'wake', hasAudio: true, wrong: false });
  });

  it('keeps only the last 50 recordings and the last 200 entries', () => {
    const d = dirs();
    const log = createVoiceLog(d);
    for (let i = 0; i < 205; i++) log.add({ heard: `n${i}`, text: `n${i}`, audio: audio(i % 250), mimeType: 'audio/wav', source: 'talk' });
    expect(fs.readdirSync(path.join(d.dir, 'audio'))).toHaveLength(50);
    const all = log.recent(500);
    expect(all).toHaveLength(200);
    expect(all.filter((e) => e.hasAudio)).toHaveLength(50);
    expect(createVoiceLog(d).recent(1)[0].heard).toBe('n204'); // survives a restart
  });

  it('"Wrong": saves the recording + what you said to the personal test set and suggests a fix', () => {
    const d = dirs();
    const log = createVoiceLog(d);
    const id = log.add({ heard: 'open claw project', text: 'open claw project', audio: audio(7), mimeType: 'audio/wav', source: 'wake' });
    const result = log.markWrong(id, 'OpenClaw project');
    expect(result.suggestion).toEqual({ from: 'open claw', to: 'OpenClaw' });
    expect(result.saved).toBe(true);
    const expected = JSON.parse(fs.readFileSync(path.join(d.realDir, 'expected.json'), 'utf8'));
    expect(expected).toEqual([{ file: `${id}.wav`, said: 'OpenClaw project', heard: 'open claw project' }]);
    expect(fs.readFileSync(path.join(d.realDir, `${id}.wav`))).toEqual(audio(7));
    expect(log.recent()[0]).toMatchObject({ wrong: true, said: 'OpenClaw project' });
  });

  it('"Wrong" without a recording still records what you said', () => {
    const log = createVoiceLog(dirs());
    const id = log.add({ heard: 'x', text: 'x', source: 'talk' });
    expect(log.markWrong(id, 'y').saved).toBe(false);
    expect(() => log.markWrong('nope', 'y')).toThrow('That command is no longer in the log.');
    expect(() => log.markWrong(id, '  ')).toThrow('Type what you actually said.');
  });
});

describe('suggestFix', () => {
  it('finds the one part that differs', () => {
    expect(suggestFix('hey novee what time', 'hey Novi what time')).toEqual({ from: 'novee', to: 'Novi' });
    expect(suggestFix('open claw project', 'OpenClaw project')).toEqual({ from: 'open claw', to: 'OpenClaw' });
  });

  it('suggests nothing when everything differs or nothing does', () => {
    expect(suggestFix('the weather', 'the weather')).toBeNull();
    expect(suggestFix('aaa bbb ccc ddd eee', 'vvv www xxx yyy zzz')).toBeNull();
  });
});
