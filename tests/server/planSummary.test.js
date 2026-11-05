import { describe, it, expect } from 'vitest';
import { planSummary, planLine } from '../../server/claude/planSummary.js';

// Live 2026-11-05: a plan with 5 real steps was said as "30 steps" (every bullet counted), and the card
// showed none of them. "How would I know what are the 30 steps"
const PLAN = `# Add Split Bill to the Tip Calculator

## Context
ChatGPT suggested three improvements.

**Outcome:** the user enters how many people are sharing, and sees \`tip\` per person.

## Behaviour
- New field below the tip buttons.
- With 1 person the app looks as it does today.

## Changes
### \`src/calc.ts\`
- Add \`MAX_PEOPLE = 100\`.

## Build order (test first)
1. Write failing tests in \`src/calc.test.ts\`, then implement \`parsePeople\`.
2. Add the styles.
3. Update the **README**.
`;

describe('the plan in short', () => {
  it('counts the numbered steps, not every bullet', () => {
    expect(planSummary(PLAN).steps).toEqual(['Write failing tests in src/calc.test.ts, then implement parsePeople.', 'Add the styles.', 'Update the README.']);
  });
  it('keeps the name and what you get', () => {
    const p = planSummary(PLAN);
    expect(p.title).toBe('Add Split Bill to the Tip Calculator');
    expect(p.summary).toBe('the user enters how many people are sharing, and sees tip per person.');
  });
  it('no numbered list: the sections are the steps', () => {
    expect(planSummary('# X\n## Context\nwhy\n## Add the form\n- a\n- b\n## Add the tests\n- c\n').steps).toEqual(['Add the form', 'Add the tests']);
  });
  it('a plain bullet list still works, without its indented lines', () => {
    expect(planSummary('- One\n  - detail\n- Two\n').steps).toEqual(['One', 'Two']);
  });
  it('a long plan keeps its first steps and says how many more', () => {
    const p = planSummary(Array.from({ length: 15 }, (_, i) => `${i + 1}. Step ${i + 1}`).join('\n'));
    expect(p.steps).toHaveLength(12);
    expect(p.more).toBe(3);
  });
  it('an empty plan is nothing', () => {
    expect(planSummary('')).toBe(null);
  });
});

describe('the line read out', () => {
  it('names the plan and the real count', () => {
    expect(planLine('Claude', 'tip calculator', planSummary(PLAN))).toBe("Claude's plan for tip calculator: Add Split Bill to the Tip Calculator. 3 steps. Go ahead?");
  });
  it('one step, and no plan text', () => {
    expect(planLine('Claude', 'x', planSummary('1. Only this'))).toBe("Claude's plan for x: 1 step. Go ahead?");
    expect(planLine('Claude', 'x', null)).toBe("Claude's plan for x is ready. Go ahead?");
  });
});
