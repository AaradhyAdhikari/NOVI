import { describe, it, expect } from 'vitest';
import { browserCommand, isDoneWord } from '../../server/brain/browserCommand.js';

describe('browserCommand: LeetCode and WhatsApp without the AI', () => {
  it('LeetCode today / stats', () => {
    for (const t of ["leetcode today's problem", "What's today's LeetCode problem?", 'aaj ka leetcode', 'leetcode daily question']) expect(browserCommand(t), t).toEqual({ tool: 'leetcode_today', args: {} });
    for (const t of ['my leetcode stats', 'Show my LeetCode progress', 'leetcode stats']) expect(browserCommand(t), t).toEqual({ tool: 'leetcode_stats', args: {} });
  });

  it('send a file or folder on WhatsApp (English + Hinglish, app or web)', () => {
    expect(browserCommand('send my DBMS notes folder to Rahul on WhatsApp')).toEqual({ tool: 'whatsapp_prepare', find: 'DBMS notes', kind: 'folder', args: { to: 'Rahul' } });
    expect(browserCommand('Rahul ko DBMS notes bhej do whatsapp pe')).toEqual({ tool: 'whatsapp_prepare', find: 'DBMS notes', kind: 'file', args: { to: 'Rahul' } });
    expect(browserCommand('send the resume pdf to Mom on the WhatsApp app')).toEqual({ tool: 'whatsapp_prepare', find: 'resume', kind: 'pdf', args: { to: 'Mom', via: 'app' } });
    expect(browserCommand('send my project report to Rahul Sharma on whatsapp web')).toEqual({ tool: 'whatsapp_prepare', find: 'project report', kind: 'file', args: { to: 'Rahul Sharma', via: 'web' } });
  });

  it('a text message on WhatsApp', () => {
    expect(browserCommand("tell Mom on WhatsApp that I'll be late")).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Mom', text: "I'll be late" } });
    expect(browserCommand('WhatsApp Rahul: reached home')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Rahul', text: 'reached home' } });
    expect(browserCommand('message Rahul on whatsapp see you at 5')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Rahul', text: 'see you at 5' } });
    expect(browserCommand('send hello to Rahul on WhatsApp')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Rahul', text: 'hello' } });
  });

  it('leaves other requests alone; knows "done"', () => {
    for (const t of ['open whatsapp', 'send an email to Rahul', 'open leetcode in chrome', 'Rahul ko bolo']) expect(browserCommand(t), t).toBe(null);
    for (const t of ['done', 'Done.', 'ho gaya', 'I typed it']) expect(isDoneWord(t), t).toBe(true);
    expect(isDoneWord('done with the report?')).toBe(false);
  });
});

describe('LeetCode as actually said (live 2026-10-15: one phrasing went to the AI and played a video)', () => {
  // Live (2026-10-17): "Show me today's LeetCode problem on my laptop" only answered in words.
  it('"… on my laptop" opens the problem on the laptop; "open …" opens it where it was asked', () => {
    expect(browserCommand("Show me today's LeetCode problem on my laptop.")).toEqual({ tool: 'leetcode_today', args: {}, open: 'laptop' });
    expect(browserCommand('open the leetcode question of the day')).toEqual({ tool: 'leetcode_today', args: {}, open: 'here' });
    expect(browserCommand('aaj ka leetcode problem laptop pe kholo')).toEqual({ tool: 'leetcode_today', args: {}, open: 'laptop' });
  });
  it('any LeetCode problem-of-the-day phrasing goes straight to leetcode_today', () => {
    for (const t of ["show me today's leetcode problem", 'what is the leetcode problem today', 'leetcode ka aaj ka question', "tell me today's leetcode challenge", 'leetcode potd'])
      expect(browserCommand(t), t).toEqual({ tool: 'leetcode_today', args: {} });
  });
  it('streak / solved / profile go to leetcode_stats', () => {
    for (const t of ['what is my leetcode streak', 'how many problems have I solved on leetcode', 'show me my leetcode profile'])
      expect(browserCommand(t), t).toEqual({ tool: 'leetcode_stats', args: {} });
  });
  it('other LeetCode requests stay with the AI', () => {
    for (const t of ['open leetcode in chrome', 'open the leetcode login page']) expect(browserCommand(t), t).toBe(null);
  });
});

describe('WhatsApp as actually said (live 2026-10-15: "send a message to her saying that you are short" went to the slow AI)', () => {
  it('message / text someone without saying WhatsApp', () => {
    expect(browserCommand('Send a message to Isha saying that you are short.')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Isha', text: 'you are short' } });
    expect(browserCommand('message Rahul that I will be late')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Rahul', text: 'I will be late' } });
    expect(browserCommand('text mom saying good night')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'mom', text: 'good night' } });
    expect(browserCommand('send Isha a message saying hi')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Isha', text: 'hi' } });
    expect(browserCommand('Isha ko message karo ki main late hu')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Isha', text: 'main late hu' } });
  });
  it('her / him / them = the last person messaged; nobody yet → the AI', () => {
    expect(browserCommand('Send a message to her saying that you are short.', { lastTo: 'Isha' })).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Isha', text: 'you are short' } });
    expect(browserCommand('tell him on whatsapp that hi', { lastTo: 'Rahul' })).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Rahul', text: 'hi' } });
    expect(browserCommand('Send a message to her saying hi')).toBe(null);
  });
  it('email stays out', () => {
    for (const t of ['send an email to Rahul saying hi', 'message Rahul on email that hi', 'send a mail to Isha saying hi']) expect(browserCommand(t), t).toBe(null);
  });
});

describe('"on my WhatsApp" (live 2026-10-17: searched "bhar", Bhargav M was there, but Novi wanted "Bhargav on my WhatsApp")', () => {
  it('the name never keeps "on my / the WhatsApp"', () => {
    expect(browserCommand('Message Bhargav on my WhatsApp that you are late.')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Bhargav', text: 'you are late' } });
    expect(browserCommand('tell Isha on my whatsapp that I am coming')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Isha', text: 'I am coming' } });
    expect(browserCommand('send a message to Rahul on my WhatsApp saying hi')).toEqual({ tool: 'whatsapp_prepare', args: { to: 'Rahul', text: 'hi' } });
    expect(browserCommand('send my notes folder to Rahul on my WhatsApp')).toMatchObject({ tool: 'whatsapp_prepare', args: { to: 'Rahul' } });
  });
});
