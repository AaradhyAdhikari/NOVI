import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLearning, isCorrection, learningCommand } from '../../server/brain/learning.js';
import { createShortcuts } from '../../server/brain/shortcuts.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-learning-'));

function setup() {
  let t = new Date(2026, 9, 18, 10, 0).getTime();
  const now = () => new Date(t);
  const dir = tmp();
  const shortcuts = createShortcuts({ file: path.join(dir, 'shortcuts.json'), now });
  const learning = createLearning({ file: path.join(dir, 'learning.json'), shortcuts, now });
  const turn = (heard, reply, { runs = [], tools, route = 'AI (groq)' } = {}) => {
    learning.observe({ heard, reply, route, tools: tools || runs.map((r) => ({ name: r.tool, ok: !r.output?.error, error: r.output?.error })), runs });
    t += 30_000;
  };
  return { learning, shortcuts, turn, later: (ms) => { t += ms; }, dir };
}

describe('learning loop: Novi notices her mistakes', () => {
  it('a correction marks the turn before it as a miss', () => {
    const s = setup();
    s.turn('link the flexr context file to my flexr project', "I don't have a FlexR project saved yet. Could you tell me the full folder path?");
    s.turn('yes I gave you the path too', 'I need the exact folder path.');
    const [m] = s.learning.misses();
    expect(m).toMatchObject({ heard: 'link the flexr context file to my flexr project', why: 'correction', said: 'yes I gave you the path too' });
  });

  it('asking again with almost the same words after an unhelpful answer is a miss', () => {
    const s = setup();
    s.turn('open my dbms notes folder', "Sorry, I couldn't find that.");
    s.turn('open the dbms notes folder', 'Opened DBMS notes.', { runs: [{ tool: 'file_open', args: { query: 'dbms notes' }, output: { opened: 'DBMS notes' } }] });
    expect(s.learning.misses()[0]).toMatchObject({ heard: 'open my dbms notes folder', why: 'repeat' });
  });

  it('a tool that failed is a miss by itself', () => {
    const s = setup();
    s.turn('send isha the notes on whatsapp', 'timeout', { tools: [{ name: 'whatsapp_prepare', ok: false, error: 'timeout' }] });
    expect(s.learning.misses()[0]).toMatchObject({ why: 'error', error: 'whatsapp_prepare: timeout' });
  });

  it('a good answer, a different request or a late repeat is not a miss', () => {
    const s = setup();
    s.turn('what time is it', "It's 10:00.");
    s.turn('open youtube', 'Opened YouTube. What should I play?');
    s.later(10 * 60_000);
    s.turn('open youtube', 'Opened YouTube.');
    expect(s.learning.misses()).toEqual([]);
  });

  it('a bare "no" is an answer, not a correction', () => {
    expect(isCorrection('no')).toBe(false);
    expect(isCorrection('nahi')).toBe(false);
    expect(isCorrection("no, that's wrong")).toBe(true);
    expect(isCorrection('I meant the FLEXR folder')).toBe(true);
    expect(isCorrection('galat hai yaar')).toBe(true);
    expect(isCorrection('maine bola tha portfolio')).toBe(true);
    expect(isCorrection('you did not open it')).toBe(true);
  });
});

describe('learning loop: the first way you said it works next time', () => {
  it('after a miss, the request that worked (one quiet tool, shared words) becomes a shortcut for the first words', () => {
    const s = setup();
    s.turn('open the flexr context thing on my laptop', "Sorry, I couldn't find that.");
    s.turn('no I meant open the FLEXR context folder', 'Opened FLEXR context.', { runs: [{ tool: 'file_open', args: { query: 'FLEXR context folder' }, output: { opened: 'FLEXR context' } }] });
    expect(s.shortcuts.find('open the flexr context thing on my laptop')).toMatchObject({ tool: 'file_open', args: { query: 'FLEXR context folder' } });
    expect(s.learning.misses()[0]).toMatchObject({ fixedBy: 'file_open', learned: true });
  });

  it('never from an unrelated request, an asked approval, a send or two tools', () => {
    const s = setup();
    s.turn('open the flexr context thing', "Sorry, I couldn't find that.");
    s.turn('what is the weather', 'Sunny, 31°.', { runs: [{ tool: 'weather_get', args: {}, output: { text: 'Sunny' } }] });
    expect(s.shortcuts.find('open the flexr context thing')).toBeNull();
    s.turn('message isha saying hi', "Sorry, I couldn't do that.");
    s.turn('I said message isha saying hi', 'Sent to Isha.', { runs: [{ tool: 'whatsapp_send', args: { to: 'Isha' }, output: { note: 'Sent' } }] });
    expect(s.shortcuts.find('message isha saying hi')).toBeNull();
    expect(s.learning.misses().find((m) => m.heard === 'message isha saying hi')).toMatchObject({ fixedBy: 'whatsapp_send', learned: false });
  });

  it('remembers across restarts, at most 300 misses', () => {
    const s = setup();
    s.turn('open the flexr thing', "Sorry, I couldn't find that.");
    s.turn("that's wrong", 'Okay.');
    const again = createLearning({ file: path.join(s.dir, 'learning.json'), shortcuts: s.shortcuts });
    expect(again.misses()).toHaveLength(1);
  });
});

describe('learning loop: telling you about it', () => {
  it('a summary of the week: how many, how many learned, what is still wrong', () => {
    const s = setup();
    s.turn('open the flexr context thing', "Sorry, I couldn't find that.");
    s.turn('no I meant open the FLEXR context folder', 'Opened FLEXR context.', { runs: [{ tool: 'file_open', args: { query: 'FLEXR context folder' }, output: { opened: 'FLEXR context' } }] });
    s.turn('play the robotics lecture', 'timeout', { tools: [{ name: 'play_youtube', ok: false, error: 'timeout' }] });
    expect(s.learning.summary()).toBe('This week I got 2 things wrong and learned from 1 of them. Still wrong: "play the robotics lecture" (play_youtube: timeout).');
    expect(createLearning({ file: path.join(tmp(), 'x.json') }).summary()).toBe("I haven't noticed any mistakes this week.");
  });

  it('the weekly note lists every miss with what fixed it', () => {
    const s = setup();
    s.turn('open the flexr context thing', "Sorry, I couldn't find that.");
    s.turn("that's not what I asked", 'Okay.');
    expect(s.learning.weekNote()).toMatch(/^## Week of 2026-10-1\d\n- "open the flexr context thing" → Sorry, I couldn't find that\. \(you corrected me: "that's not what I asked"\)$/);
  });

  it.each(['what did you get wrong this week', 'what mistakes did you make today', 'your mistakes', 'kya galtiyan ki'])('"%s" → the summary', (text) => {
    expect(learningCommand(text)).toBe(true);
  });
  it.each(['what went wrong', 'what is wrong with my code', 'mistakes in my essay'])('not this: "%s"', (text) => {
    expect(learningCommand(text)).toBe(false);
  });
});
