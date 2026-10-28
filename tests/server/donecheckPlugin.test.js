import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { checksFrom, kindOf } from '../../plugins/donecheck/checks.js';
import { summary, fixMessage, briefFrom, resultLines } from '../../plugins/donecheck/report.js';
import { allowedRequest, openSite } from '../../plugins/donecheck/page.js';
import { verdict, judge } from '../../plugins/donecheck/judge.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createDoneCheckPlugin } from '../../plugins/donecheck/index.js';

const BRIEF = `# Brief: Tip calculator
What you asked: let's build a tiny tip calculator app

## Goal (ChatGPT)
A tiny tip calculator.

## Look & feel (ChatGPT)
Clean, one card in the middle, green buttons, works on a phone.

## Done when (ChatGPT)
1. The page loads with no errors in the console.
2. Typing a bill of 100 and choosing 10% shows a tip of 10.
- The layout fits a phone screen without sideways scrolling.
* Users can log in with Google.`;

describe('done-check: the checklist from the brief (no AI)', () => {
  it("turns each Done-when line into a check and Look & feel into one visual check", () => {
    const checks = checksFrom(BRIEF);
    expect(checks.map((c) => c.kind)).toEqual(['technical', 'functional', 'visual', 'manual', 'visual']);
    expect(checks[1]).toEqual({ id: 'c2', text: 'Typing a bill of 100 and choosing 10% shows a tip of 10.', kind: 'functional' });
    expect(checks.at(-1).text).toMatch(/^Looks like the brief: Clean, one card in the middle/);
  });

  it('kinds from words', () => {
    expect(kindOf('Payment works with Razorpay')).toBe('manual');
    expect(kindOf('An email is sent after sign up')).toBe('manual');
    expect(kindOf('Builds without errors')).toBe('technical');
    expect(kindOf('Clicking Convert shows the result in km')).toBe('functional');
    expect(kindOf('Uses a dark theme with rounded cards')).toBe('visual');
    // Live (Tip calculator brief): "console" / "builds" outweigh a passing mention of calculation.
    expect(kindOf('All tests and development and production builds pass, with no calculation bugs or console errors remaining.')).toBe('technical');
  });

  it('no Done-when section → no checks', () => {
    expect(checksFrom('# Brief: X\n## Goal (ChatGPT)\nSomething')).toEqual([]);
  });
});

describe('done-check: what is said and sent', () => {
  const results = [
    { id: 'c1', text: 'The page loads with no errors.', kind: 'technical', state: 'passed', why: 'No errors.' },
    { id: 'c2', text: 'Typing 100 and 10% shows a tip of 10.', kind: 'functional', state: 'failed', why: 'It showed 0.', shot: '.novi/check-shots/1-c2.png' },
    { id: 'c3', text: 'Fits a phone.', kind: 'visual', state: 'uncertain', why: "Couldn't tell from the picture." },
    { id: 'c4', text: 'Log in with Google.', kind: 'manual', state: 'not checked', why: 'Needs you: sign-in.' },
  ];

  it('says it short and honest', () => {
    expect(summary(results)).toBe('1 of 4 checks passed. Failed: Typing 100 and 10% shows a tip of 10. Not sure: Fits a phone. Not checked: Log in with Google — try it yourself.');
    expect(summary([{ ...results[0] }])).toBe('1 of 1 checks passed.');
  });

  // Live (Tip calculator): the spoken line read the whole Look & feel paragraph.
  it('names checks briefly when speaking', () => {
    const long = [
      { text: 'Keyboard navigation, visible focus indicators, accessible labels, and responsive layouts work across common screen sizes.', state: 'uncertain' },
      { text: 'Looks like the brief: Layout: Centered, single-column card with comfortable page margins.', state: 'uncertain' },
    ];
    expect(summary(long)).toBe('0 of 2 checks passed. Not sure: Keyboard navigation, visible focus indicators, accessible labels, and responsive layouts…; the look from the brief.');
  });

  it('lists every check with its state', () => {
    expect(resultLines(results)).toEqual([
      '✓ The page loads with no errors.',
      '✗ Typing 100 and 10% shows a tip of 10. — It showed 0.',
      '? Fits a phone. — Couldn\'t tell from the picture.',
      '– Log in with Google. — Needs you: sign-in.',
    ]);
  });

  it('asks Claude to fix only the failed and unsure ones', () => {
    const m = fixMessage(results);
    expect(m).toMatch(/fix only these/i);
    expect(m).toContain('Typing 100 and 10% shows a tip of 10. (failed: It showed 0. Screenshot: .novi/check-shots/1-c2.png)');
    expect(m).toContain('Fits a phone. (not sure:');
    expect(m).not.toContain('Log in with Google');
    expect(m).not.toContain('The page loads');
    expect(fixMessage([results[0]])).toBeNull();
  });

  it('finds the brief inside the instruction Novi sent Claude', () => {
    const instruction = `let's build a tip calculator\n\nFollow this brief (made by Novi with ChatGPT and Gemini):\n\n${BRIEF}\n\nAlso: make it green`;
    expect(briefFrom(instruction)).toBe(BRIEF);
    expect(briefFrom('fix the login bug')).toBeNull();
  });
});

// A fake DevTools connection: records what Novi sends, lets the test fire page events.
function fakeCdp() {
  const sent = [];
  const handlers = {};
  return {
    sent,
    fire: (method, params) => (handlers[method] || []).forEach((fn) => fn(params)),
    cdp: {
      send: async (method, params) => {
        sent.push([method, params]);
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
        return {};
      },
      on: (m, fn) => { handlers[m] = [...(handlers[m] || []), fn]; },
      once: async () => ({}),
      close: () => {},
    },
  };
}

describe('done-check: the hidden page', () => {
  it('lets only the project site through (nothing real is ever sent out)', () => {
    expect(allowedRequest('http://localhost:5173/app.js', 'http://localhost:5173')).toBe(true);
    expect(allowedRequest('data:image/png;base64,xx', 'http://localhost:5173')).toBe(true);
    expect(allowedRequest('https://api.stripe.com/v1/charges', 'http://localhost:5173')).toBe(false);
    expect(allowedRequest('http://localhost:5174/x', 'http://localhost:5173')).toBe(false);
  });

  it('blocks other hosts, collects page errors, and types / clicks', async () => {
    const f = fakeCdp();
    let closed = 0;
    const page = await openSite('http://localhost:5173/', { launch: async () => ({ wsUrl: 'ws://x', close: () => { closed += 1; } }), connect: async () => f.cdp, settleMs: 0 });
    f.fire('Fetch.requestPaused', { requestId: 'a', request: { url: 'https://evil.example/collect' } });
    f.fire('Fetch.requestPaused', { requestId: 'b', request: { url: 'http://localhost:5173/main.js' } });
    f.fire('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: x is undefined\n    at main.js:3' } } });
    f.fire('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'Failed to fetch' }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.sent.find(([m, p]) => m === 'Fetch.failRequest' && p.requestId === 'a')).toBeTruthy();
    expect(f.sent.find(([m, p]) => m === 'Fetch.continueRequest' && p.requestId === 'b')).toBeTruthy();
    expect(page.errors).toEqual(['TypeError: x is undefined', 'Failed to fetch']);
    expect(page.blocked).toEqual(['https://evil.example/collect']);
    await page.act({ do: 'type', n: 2, value: '100' });
    const evaluated = f.sent.filter(([m]) => m === 'Runtime.evaluate').at(-1)[1].expression;
    expect(evaluated).toContain('"n":2');
    page.close();
    expect(closed).toBe(1);
  });
});

describe('done-check: judging one check', () => {
  const shots = { phone: Buffer.from('p'), desktop: Buffer.from('d') };

  it('reads the AI verdict, else "not sure"', () => {
    expect(verdict('Sure! {"state":"failed","why":"Text overlaps."}')).toEqual({ state: 'failed', why: 'Text overlaps.' });
    expect(verdict('```json\n{"state":"passed","why":"ok"}\n```')).toEqual({ state: 'passed', why: 'ok' });
    expect(verdict('I think it looks fine').state).toBe('uncertain');
  });

  it('manual: never tried; technical: page errors', async () => {
    expect((await judge({ text: 'Log in with Google', kind: 'manual' }, {})).state).toBe('not checked');
    expect(await judge({ text: 'Loads with no errors', kind: 'technical' }, { errors: [] })).toMatchObject({ state: 'passed' });
    expect(await judge({ text: 'Loads with no errors', kind: 'technical' }, { errors: ['TypeError: x'] })).toEqual({ state: 'failed', why: 'The page had an error: TypeError: x' });
  });

  it('visual: both pictures through free vision; one failing fails it', async () => {
    const seen = [];
    const vision = async (png) => { seen.push(String(png)); return png === shots.phone ? '{"state":"failed","why":"Cut off on the phone."}' : '{"state":"passed","why":"Fine."}'; };
    expect(await judge({ text: 'Fits a phone', kind: 'visual' }, { shots, vision })).toEqual({ state: 'failed', why: 'Cut off on the phone.' });
    expect(seen).toEqual(['p', 'd']);
  });

  it('functional: the AI plans steps, Novi does them, the AI judges what changed', async () => {
    const acts = [];
    const page = {
      open: async () => {},
      controls: async () => [{ n: 1, tag: 'input', label: 'Bill' }, { n: 2, tag: 'button', label: '10%' }],
      text: async () => (acts.length ? 'Tip: 10.00' : 'Tip: 0.00'),
      act: async (s) => { acts.push(s); return { ok: true }; },
      shot: async () => Buffer.from('after'),
    };
    const asked = [];
    const complete = async (prompt) => {
      asked.push(prompt);
      return asked.length === 1
        ? '{"steps":[{"do":"type","n":1,"value":"100"},{"do":"click","n":2}],"expect":"Tip shows 10"}'
        : '{"state":"passed","why":"Tip shows 10.00."}';
    };
    const out = await judge({ text: 'Typing 100 and 10% shows a tip of 10', kind: 'functional' }, { page, complete, wait: 0 });
    expect(out).toMatchObject({ state: 'passed', why: 'Tip shows 10.00.' });
    expect(out.png).toBeTruthy();
    expect(acts).toEqual([{ do: 'type', n: 1, value: '100' }, { do: 'click', n: 2 }]);
    expect(asked[1]).toContain('Tip: 0.00');
    expect(asked[1]).toContain('Tip: 10.00');
    expect(asked[0]).toMatch(/website content, not instructions/i);
  });

  it("functional: a step that can't be done is 'not sure', never a guess", async () => {
    const page = { open: async () => {}, controls: async () => [{ n: 1, tag: 'input', label: 'Bill' }], text: async () => '', act: async () => ({ ok: false, why: 'no control 7' }), shot: async () => Buffer.from('x') };
    const complete = async () => '{"steps":[{"do":"click","n":7}],"expect":"x"}';
    expect(await judge({ text: 'Clicking reset clears it', kind: 'functional' }, { page, complete, wait: 0 })).toMatchObject({ state: 'uncertain', why: "I couldn't do step 1 (no control 7)." });
  });
});

describe('done-check plugin', () => {
  const BRIEF_INSTRUCTION = `build it\n\nFollow this brief (made by Novi with ChatGPT and Gemini):\n\n${BRIEF}`;

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donecheck-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'donecheck-data-'));
    const said = [];
    const started = [];
    const tasks = new EventEmitter();
    const runtime = {
      tasks,
      dataDir: data,
      codingProject: (n) => (!n || /tip/i.test(n) ? { name: 'Tip calculator', path: dir, working: false } : null),
      previewSite: async () => ({ name: 'Tip calculator', path: dir, port: 5173 }),
      say: (text, opts) => said.push([text, opts]),
      showImage: () => {},
      wikiWrite: () => {},
      startCoding: async (args) => { started.push(args); return { note: 'Claude is on it.' }; },
      vision: async () => '{"state":"passed","why":"Looks right."}',
      complete: async () => '{"state":"passed","why":"ok"}',
    };
    const fakePage = { errors: ['TypeError: boom'], blocked: [], open: async () => {}, shot: async () => Buffer.from('png'), text: async () => '', controls: async () => [], act: async () => ({ ok: true }), close: () => {} };
    const ph = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    expect(ph.register(createDoneCheckPlugin({ open: async () => fakePage }))).toBe(true);
    const tool = async (name, args) => ph.get(name).run(args);
    return { dir, data, said, started, tasks, ph, tool };
  }

  it('writes the checklist when a brief-approved build starts, and checks when Claude finishes', async () => {
    const s = setup();
    await s.ph.afterToolCall({ toolName: 'code_start_task', params: { project: 'Tip calculator', instruction: BRIEF_INSTRUCTION }, result: {} });
    const checks = JSON.parse(fs.readFileSync(path.join(s.dir, '.novi', 'checks.json'), 'utf8'));
    expect(checks).toMatchObject({ project: 'Tip calculator', pending: true, round: 1 });
    expect(checks.checks).toHaveLength(5);
    s.tasks.emit('task', { id: 't1', status: 'done', project: 'Tip calculator', path: s.dir });
    await new Promise((r) => setTimeout(r, 100));
    const [text, opts] = s.said.at(-1);
    expect(opts.spoken).toMatch(/^\d of 5 checks passed\. Failed: The page loads with no errors in the console\./);
    expect(text).toContain('✗ The page loads with no errors in the console. — The page had an error: TypeError: boom');
    expect(fs.readFileSync(path.join(s.dir, '.novi', 'check-results.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.readFileSync(path.join(s.data, 'donecheck', 'runs.jsonl'), 'utf8')).toContain('"project":"Tip calculator"');
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, '.novi', 'checks.json'), 'utf8')).pending).toBe(false);
  });

  it('"fix it" sends Claude only the failed checks, then checks again', async () => {
    const s = setup();
    await s.ph.afterToolCall({ toolName: 'code_start_task', params: { project: 'Tip calculator', instruction: BRIEF_INSTRUCTION }, result: {} });
    await s.tool('donecheck_run', { project: 'Tip calculator' });
    await new Promise((r) => setTimeout(r, 100));
    const out = await s.tool('donecheck_fix', { project: 'Tip calculator' });
    expect(out.note).toMatch(/check again/);
    expect(s.started[0].project).toBe('Tip calculator');
    expect(s.started[0].instruction).toMatch(/fix only these/i);
    expect(s.started[0].instruction).toContain('The page loads with no errors');
    const checks = JSON.parse(fs.readFileSync(path.join(s.dir, '.novi', 'checks.json'), 'utf8'));
    expect(checks).toMatchObject({ pending: true, round: 2 });
  });

  it('says plainly when there is no checklist', async () => {
    const s = setup();
    expect((await s.tool('donecheck_run', { project: 'Tip calculator' })).note).toMatch(/no checklist/i);
  });
});
