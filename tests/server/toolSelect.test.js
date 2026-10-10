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
  tool('code_take_over', 'Continue the coding task yourself in Claude Code.'),
  tool('backup_now', 'Back up Novi data now.'),
  tool('screen_show', 'Send a screenshot of the laptop screen.'),
  tool('screen_page', 'Send a screenshot of a web page.'),
  tool('study_log', 'Log study time to the Novi log sheet.'),
  tool('sheets_log_link', 'Link to the Novi log sheet.'),
  tool('project_next', 'Where the user left off on a project.'),
  tool('open_project', 'Open a project in an editor.'),
];
const names = (text, opts) => selectTools(ALL, { text, ...opts }).map((t) => t.function.name);

describe('selectTools: send the model only the tools a request needs', () => {
  it('weather question gets the weather tool, not mail or GitHub', () => {
    const n = names("What's the weather in Pune tomorrow?");
    expect(n).toContain('weather_get');
    expect(n).not.toContain('gmail_send');
    expect(n).not.toContain('github_create_issue');
  });

  it('screenshot / SS / picture requests get the screenshot tools', () => {
    for (const text of ['Show me a screenshot of my GitHub contributions', 'send me an ss of the laptop', 'take a picture of the screen']) {
      expect(names(text)).toEqual(expect.arrayContaining(['screen_show', 'screen_page']));
    }
    expect(names('Show me a screenshot of my GitHub contributions')).toContain('github_notifications');
  });

  it('automations: study log, where you left off, Drive backup', () => {
    for (const text of ['log 2 hours of DSA', 'I studied OS for 45 minutes', 'send me my study sheet']) expect(names(text)).toContain('study_log');
    for (const text of ["what's next on NOVI", 'where did I leave off', 'how far did I get on flexr']) expect(names(text)).toContain('project_next');
    expect(names('back up to google drive')).toContain('backup_now');
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

describe('selectTools: calendar and tasks words', () => {
  const t = (name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } });
  const tools = [t('calendar_events'), t('calendar_free'), t('calendar_add'), t('tasks_list'), t('tasks_add'), t('tasks_complete'), t('weather_get')];
  const names = (text) => selectTools(tools, { text }).map((x) => x.function.name);
  it('offers calendar tools for meetings and free time, tasks tools for to-dos', () => {
    expect(names("what's on my calendar tomorrow")).toEqual(expect.arrayContaining(['calendar_events', 'calendar_add']));
    expect(names('am I free at 5')).toContain('calendar_free');
    expect(names('add submit assignment to my to-do list')).toContain('tasks_add');
    expect(names('mark the dbms task done')).toContain('tasks_complete');
  });
});

describe('isQuickTurn', () => {
  it('counts words by spaces (13 words is not quick, even without the letter s)', async () => {
    const { isQuickTurn } = await import('../../server/brain/toolSelect.js');
    expect(isQuickTurn('tell me a long joke about a cat and a dog and a cow', [])).toBe(false);
    expect(isQuickTurn('tell me a joke', [])).toBe(true);
  });
});

describe('selectTools: Claude by voice', () => {
  it('"open X in Claude and do Y" offers both opening the project and starting the coding task', () => {
    for (const text of ['open Novi in Claude and add dark mode', 'Novi project Claude se dark mode add karwa']) {
      expect(names(text), text).toEqual(expect.arrayContaining(['open_project', 'code_start_task']));
    }
  });

  it('"I\'m back, I\'ll take over" offers the take-over tool', () => {
    for (const text of ["I'm back, I'll take over", 'main sambhal leta hun', 'takeover']) expect(names(text), text).toContain('code_take_over');
  });
});

describe('selectTools: Hinglish reminders', () => {
  it('"utha dena", "yaad dila", "jaga dena" offer the reminder tools', () => {
    for (const text of ['kal subah 7 baje utha dena', 'mujhe 5 baje yaad dila dena', 'subah jaga dena']) expect(names(text), text).toContain('reminder_add');
  });
});

describe('selectTools: Hindi / Marathi weather', () => {
  it('हवामान, मौसम, पाऊस, mausam offer the weather tool', () => {
    for (const text of ['उद्याचे हवामान सांग', 'आज मौसम कैसा है', 'पाऊस पडेल का', 'kal ka mausam batao', 'barish hogi kya']) expect(names(text), text).toContain('weather_get');
  });
});

describe('selectTools: Hinglish coding requests reach the coder', () => {
  it('"add kar", "bana de", "karwa", "change kar" offer code_start_task', () => {
    for (const text of ['Novi project mein dark mode add kar', 'Novi mein login page bana de', 'Novi ka button change kar', 'dark mode karwa do Novi mein']) {
      expect(names(text), text).toContain('code_start_task');
    }
  });
});
