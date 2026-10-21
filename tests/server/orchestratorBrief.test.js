import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gatherFacts } from '../../plugins/orchestrator/context.js';
import { planPrompt, ideasPrompt, changePrompt, projectNameFrom } from '../../plugins/orchestrator/prompts.js';
import { sections, buildBrief } from '../../plugins/orchestrator/brief.js';

describe('project facts (no AI)', () => {
  it('README, package.json, a short file list and the last commits; never .env, node_modules or data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-facts-'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# Portfolio\nMy site.');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'portfolio', description: 'my site', scripts: { dev: 'vite' }, dependencies: { react: '1' }, devDependencies: { vite: '1' } }));
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    for (const d of ['src', 'node_modules', 'data', '.git']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'src', 'App.jsx'), 'x');
    const facts = gatherFacts(dir, { note: 'Last time: hero done.', exec: () => 'Add hero\nFirst commit\n' });
    expect(facts).toMatch(/# Portfolio\nMy site\./);
    expect(facts).toMatch(/portfolio — my site/);
    expect(facts).toMatch(/Scripts: dev/);
    expect(facts).toMatch(/Uses: react, vite/);
    expect(facts).toMatch(/src\/\n {2}App\.jsx/);
    expect(facts).toMatch(/Add hero/);
    expect(facts).toMatch(/Last time: hero done\./);
    expect(facts).not.toMatch(/\.env|SECRET|node_modules|data\//);
    expect(gatherFacts(null)).toBe('New project, nothing built yet.');
  });
});

describe('prompts', () => {
  it('the plan asks ChatGPT for fixed headings, no code; Gemini for examples + security rules', () => {
    const plan = planPrompt({ project: 'portfolio', request: "let's add a blog", facts: 'FACTS' });
    expect(plan).toMatch(/let's add a blog/);
    expect(plan).toMatch(/FACTS/);
    for (const h of ['## Goal', '## Steps', '## Look & feel', '## Done when']) expect(plan).toContain(h);
    expect(plan).toMatch(/No code/);
    const ideas = ideasPrompt({ project: 'portfolio', request: "let's add a blog", facts: 'FACTS' });
    for (const h of ['## Examples', '## Security rules']) expect(ideas).toContain(h);
    expect(changePrompt('use a blue theme')).toMatch(/use a blue theme[\s\S]*Goal, Steps, Look & feel, Done when/);
    // First live run: the backup AI made up links (an App Store id 123456789, com.example.tipcalculator).
    expect(ideas).toMatch(/never make up a link/i);
  });

  // First live run: a new project without a name was briefed as "New project".
  it('a new project without a name is named from the words', () => {
    expect(projectNameFrom("let's build a tiny tip calculator app")).toBe('Tip calculator');
    expect(projectNameFrom('build me a website for my bakery')).toBe('Bakery website');
    expect(projectNameFrom('make a simple to-do list web app')).toBe('To-do list');
    expect(projectNameFrom('let us create an expense tracker')).toBe('Expense tracker');
    expect(projectNameFrom('do it')).toBe(null);
  });
});

describe('the brief (no AI)', () => {
  const plan = 'Sure! Here you go.\n\n**Goal:** A blog for the portfolio.\n\n### Steps\n1. Add posts page\n2. Add post layout\n3. Link from home\n\n## Look and feel\n- Dark, mono font\n\n## Done when\n- Posts open on phone';
  const ideas = '## Examples\n- overreacted.io — clean typography\n- leerob.com — simple list\n\n## Security Rules:\n1. Escape post HTML\n2. No secrets in the repo\n3. Keep deps updated';

  it('finds the headings however the site wrote them', () => {
    const s = sections(plan, ['Goal', 'Steps', 'Look & feel', 'Done when']);
    expect(s.Goal).toBe('A blog for the portfolio.');
    expect(s.Steps).toBe('1. Add posts page\n2. Add post layout\n3. Link from home');
    expect(s['Look & feel']).toBe('- Dark, mono font');
    expect(sections('just text', ['Goal', 'Steps'])).toEqual({ Goal: 'just text' });
  });

  it('one text in a fixed shape with sources, and a short spoken line', () => {
    const b = buildBrief({ project: 'portfolio', request: "let's add a blog", plan: { text: plan, source: 'ChatGPT' }, ideas: { text: ideas, source: 'Gemini' } });
    expect(b.text).toMatch(/^# Brief: portfolio\nWhat you asked: let's add a blog\n\n## Goal \(ChatGPT\)\nA blog for the portfolio\./);
    expect(b.text.indexOf('## Examples (Gemini)')).toBeLessThan(b.text.indexOf('## Done when (ChatGPT)'));
    expect(b.text).toMatch(/## Security rules \(Gemini\)\n1\. Escape post HTML/);
    expect(b.spoken).toBe('ChatGPT planned 3 steps and Gemini found 2 examples and 3 security rules. Send it to Claude?');
  });

  // Third live run: ChatGPT's numbered list arrives without "1." (the page draws the numbers), so the
  // card said "ChatGPT planned 0 steps". Lines without markers are counted as they are.
  it('counts steps whose numbers the page drew itself', () => {
    const page = '## Goal\nA tip calculator.\n## Steps\nSet up the app.\n\nBuild the form.\nAdd the maths.\n## Look & feel\nGreen accent.\n## Done when\nIt works.';
    expect(buildBrief({ project: 'tip', request: 'x', plan: { text: page, source: 'ChatGPT' }, ideas: { text: '## Examples\nCalculator.net — simple\nSplitwise — splitting\n## Security rules\nValidate input.', source: 'Gemini' } }).spoken)
      .toBe('ChatGPT planned 3 steps and Gemini found 2 examples and 1 security rule. Send it to Claude?');
  });

  it('a missing part says why; backups are named', () => {
    const b = buildBrief({ project: 'portfolio', request: 'x', plan: { text: plan, source: 'the backup AI', why: 'ChatGPT needs you to log in.' }, ideas: { error: "Gemini didn't answer in time." } });
    expect(b.text).toMatch(/## Goal \(the backup AI\)/);
    expect(b.text).toMatch(/## Examples\n\(missing: Gemini didn't answer in time\.\)/);
    expect(b.text).toMatch(/ChatGPT needs you to log in\. The backup AI wrote the plan\./);
    expect(b.spoken).toBe("The backup AI planned 3 steps. I couldn't get examples or security rules. Send it to Claude?");
  });
});
