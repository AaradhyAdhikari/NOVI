import { describe, it, expect } from 'vitest';
import { selectTools } from '../../server/brain/toolSelect.js';

const tool = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });
const ALL = [
  tool('weather_get', 'Get the current weather and the forecast for a city.'),
  tool('gmail_search', 'Search Gmail messages.'),
  tool('gmail_read', 'Read one Gmail message.'),
  tool('gmail_send', 'Send an email from Gmail.'),
  tool('open_project', 'Open a remembered project in VS Code, Cursor, Antigravity, Kiro or Claude Code.'),
  tool('open_app', 'Open an installed app on the laptop by name.'),
  tool('open_website', 'Open a website on the laptop.'),
  tool('play_youtube', 'Play a YouTube video on the laptop.'),
  tool('youtube_search', 'Search YouTube.'),
  tool('reminder_add', 'Set a reminder or timer.'),
  tool('github_notifications', 'List unread GitHub notifications.'),
  tool('github_create_issue', 'Create a GitHub issue.'),
  tool('memory_remember', 'Save one lasting fact about the user.'),
  tool('memory_recall', 'Search what the user told Novi before.'),
  tool('code_start_task', 'Start a coding task on a project.'),
  tool('code_status', 'Status of the coding task.'),
  tool('backup_now', 'Back up Novi data now.'),
];
const names = (text, opts) => selectTools(ALL, { text, ...opts }).map((t) => t.function.name);

describe('selectTools: send the model only the tools a request needs', () => {
  it('weather question gets the weather tool, not mail or GitHub', () => {
    const n = names("What's the weather in Pune tomorrow?");
    expect(n).toContain('weather_get');
    expect(n).not.toContain('gmail_send');
    expect(n).not.toContain('github_create_issue');
  });

  it('always offers the basics: memory and opening apps/websites', () => {
    const n = names('hello');
    expect(n).toEqual(expect.arrayContaining(['memory_remember', 'memory_recall', 'open_app', 'open_website']));
  });

  it('understands everyday words: email → Gmail tools (the whole group)', () => {
    expect(names('check my email from Rohan')).toEqual(expect.arrayContaining(['gmail_search', 'gmail_read', 'gmail_send']));
    expect(names('any new mails?')).toContain('gmail_search');
  });

  it('matches editors and projects', () => {
    expect(names('open Novi in Cursor')).toContain('open_project');
  });

  it('matches songs/music to YouTube, alarms/timers to reminders', () => {
    expect(names('play some lofi music')).toEqual(expect.arrayContaining(['play_youtube', 'youtube_search']));
    expect(names('wake me up at 7 with an alarm')).toContain('reminder_add');
  });

  it('keeps the tools of the last turn for follow-ups like "yes, send it"', () => {
    const history = [{ role: 'user', content: 'write an email to Rohan saying hi' }, { role: 'assistant', content: 'Here is the draft. Send it?' }];
    expect(names('yes send it', { history })).toContain('gmail_send');
  });

  it('includes coding tools while a coding task is running', () => {
    expect(names('how is it going?', { taskActive: true })).toEqual(expect.arrayContaining(['code_status']));
  });

  it('sends far fewer tools than all of them for a typical request', () => {
    expect(names("What's the weather in Pune?").length).toBeLessThanOrEqual(10);
  });
});

describe('selectTools: screen control words', () => {
  const t = (name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } });
  const tools = [t('screen_look'), t('screen_click'), t('screen_type'), t('screen_key'), t('weather_get')];
  it('offers the screen tools for "click", "type", "what is on my screen"', () => {
    for (const text of ['click the send button in whatsapp', 'type hello in notepad', "what's on my screen?"]) {
      expect(selectTools(tools, { text }).map((x) => x.function.name), text).toEqual(expect.arrayContaining(['screen_look', 'screen_click', 'screen_type', 'screen_key']));
    }
  });
});
