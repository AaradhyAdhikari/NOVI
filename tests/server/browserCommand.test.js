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
