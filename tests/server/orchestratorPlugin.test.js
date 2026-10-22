import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createOrchestratorPlugin } from '../../plugins/orchestrator/index.js';

const PLAN = '## Goal\nA blog.\n## Steps\n1. Posts page\n2. Post layout\n## Look & feel\n- Dark\n## Done when\n- Opens on phone';
const PLAN2 = '## Goal\nA blue blog.\n## Steps\n1. Posts page\n## Look & feel\n- Blue\n## Done when\n- Opens';
const IDEAS = '## Examples\n- overreacted.io — type\n## Security rules\n1. Escape HTML\n2. No secrets';

function setup({ sites = {}, decisions = [{ allow: true }], connected = true, known = true, complete = async () => PLAN } = {}) {
  const asked = [];
  const cards = [];
  const said = [];
  const started = [];
  const notes = [];
  const backups = [];
  const jobs = [];
  const answers = { chatgpt: { text: PLAN }, gemini: { text: IDEAS }, ...sites };
  const driver = {
    ask: async (key, prompt) => { asked.push(['ask', key, prompt]); return answers[key]; },
    followUp: async (key, text) => { asked.push(['followUp', key, text]); return { text: PLAN2 }; },
  };
  const runtime = {
    browserStatus: () => ({ connected }),
    codingProject: (n) => (known && n === 'portfolio' ? { name: 'portfolio', path: null, working: false } : null),
    wikiRead: () => 'Last time: hero.',
    wikiWrite: (n) => { notes.push(n); return { title: n.title }; },
    ask: async (card) => { cards.push(card); return decisions.shift() || { allow: false }; },
    startCoding: async (a) => { started.push(['start', a]); return { started: true }; },
    newProject: async (a) => { started.push(['new', a]); return { created: true }; },
    complete: async (text, opts) => { backups.push([text, opts]); return complete(text, opts); },
    say: (text, opts) => said.push([text, opts]),
  };
  const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
  expect(host.register(createOrchestratorPlugin({ driver, track: (p) => jobs.push(p), now: () => new Date(2026, 9, 18, 10, 0) }))).toBe(true);
  const run = async (args) => { const out = await host.get('project_brief').run(args); await jobs.at(-1); return out; };
  return { run, asked, cards, said, started, notes, backups };
}

describe('orchestrator: a brief before Claude codes', () => {
  it('answers at once, asks ChatGPT and Gemini, saves the brief, shows the card; yes starts Claude on the brief', async () => {
    const s = setup({ decisions: [{ allow: true, addition: 'add an RSS feed' }] });
    const out = await s.run({ project: 'portfolio', request: "let's add a blog to portfolio" });
    expect(out.note).toBe("Thinking it through with ChatGPT and Gemini… I'll show you the brief in about a minute.");
    expect(s.asked.map(([w, k]) => `${w}:${k}`).sort()).toEqual(['ask:chatgpt', 'ask:gemini']);
    expect(s.asked.find(([, k]) => k === 'chatgpt')[2]).toMatch(/Last time: hero\./);
    expect(s.notes[0]).toMatchObject({ title: 'portfolio brief' });
    expect(s.notes[0].text).toMatch(/^## 2026-10-18 10:00\nWhat you asked: let's add a blog to portfolio/);
    expect(s.cards[0]).toMatchObject({ title: 'Send this brief to Claude?', changeable: true, addable: true, source: 'orchestrator', prompt: 'ChatGPT planned 2 steps and Gemini found 1 example and 2 security rules. Send it to Claude?' });
    expect(s.cards[0].detail).toMatch(/## Security rules \(Gemini\)\n1\. Escape HTML/);
    expect(s.cards[0].detail).toMatch(/"change …" to change the plan, or "no"\.$/);
    expect(s.notes[0].text).not.toMatch(/change …/);
    const [[kind, job]] = s.started;
    expect(kind).toBe('start');
    expect(job.project).toBe('portfolio');
    expect(job.instruction).toMatch(/^let's add a blog to portfolio\n\nFollow this brief \(made by Novi with ChatGPT and Gemini\):\n\n# Brief: portfolio/);
    expect(job.instruction).toMatch(/\n\nAlso: add an RSS feed$/);
    expect(s.said.at(-1)).toEqual(['Claude is on it.', { kind: null }]);
  });

  it('"change X" goes back to the same ChatGPT chat, a new card follows; no → nothing starts', async () => {
    const s = setup({ decisions: [{ allow: false, change: 'make it blue' }, { allow: false }] });
    await s.run({ project: 'portfolio', request: 'blog' });
    expect(s.asked.find(([w]) => w === 'followUp')).toEqual(['followUp', 'chatgpt', expect.stringMatching(/^Change the plan: make it blue/)]);
    expect(s.cards).toHaveLength(2);
    expect(s.cards[1].detail).toMatch(/A blue blog\./);
    expect(s.cards[1].detail).toMatch(/\nYour changes: make it blue\n/); // which change the new card has
    expect(s.cards[0].speaksOnDeny).toBe(true);
    expect(s.notes).toHaveLength(2);
    expect(s.started).toEqual([]);
    expect(s.said.at(-1)[0]).toBe("Okay, I won't send the brief.");
  });


  it('a site that fails → the free API for that part, and the card says so; a new project is made on yes', async () => {
    const s = setup({ known: false, sites: { chatgpt: { error: 'ChatGPT needs you to log in. Log in to ChatGPT in Chrome, then ask for the brief again.', login: true } } });
    await s.run({ name: 'Recipe Box', request: 'make a new project called recipe box for saving recipes', isNew: true });
    expect(s.backups[0][1]).toEqual({ prefer: 'githubmodels' });
    expect(s.cards[0].detail).toMatch(/ChatGPT needs you to log in\. .* The backup AI wrote the plan\./);
    expect(s.cards[0].prompt).toMatch(/^The backup AI planned 2 steps and Gemini found/);
    expect(s.started[0]).toEqual(['new', expect.objectContaining({ name: 'Recipe Box', description: 'make a new project called recipe box for saving recipes' })]);
  });

  it('Chrome not connected → both parts from the free APIs; nothing at all → says how to go on without a brief', async () => {
    const s = setup({ connected: false });
    await s.run({ project: 'portfolio', request: 'blog' });
    expect(s.asked).toEqual([]);
    expect(s.backups.map(([, o]) => o.prefer)).toEqual(['githubmodels', 'gemini']);
    const none = setup({ connected: false, complete: async () => { throw new Error('busy'); } });
    await none.run({ project: 'portfolio', request: 'blog' });
    expect(none.cards).toEqual([]);
    expect(none.said.at(-1)[0]).toBe('I couldn\'t reach ChatGPT or Gemini (Chrome isn\'t connected). Say "tell Claude to …" to start without a brief.');
  });
});
