import { describe, it, expect } from 'vitest';
import { parseApproval } from '../../server/brain/approvalIntent.js';

// One parser for every card (user's plan, 2026-10-28): what was said → what it means for the card.
const card = { title: 'Claude wants to write hosts', addable: true, changeable: true };
const choice = { title: 'Who should build it?', choices: [{ id: 'novi-coder', label: 'Novi Coder' }, { id: 'claude', label: 'Claude Code' }, { id: 'later', label: 'Do it later' }] };
const question = { question: { text: 'Which theme?', options: [{ label: 'Light mode' }, { label: 'Dark mode' }, { label: 'Dark blue' }] } };

describe('parseApproval', () => {
  it('options by number, ordinal, Hindi word or label', () => {
    expect(parseApproval('option 2', choice)).toMatchObject({ intent: 'option', optionIndex: 1, optionLabel: 'Claude Code' });
    expect(parseApproval('the second one', choice)).toMatchObject({ intent: 'option', optionIndex: 1 });
    expect(parseApproval('two', choice)).toMatchObject({ intent: 'option', optionIndex: 1 });
    expect(parseApproval('doosra wala', choice)).toMatchObject({ intent: 'option', optionIndex: 1 });
    expect(parseApproval('claude code', choice)).toMatchObject({ intent: 'option', optionIndex: 1 });
    expect(parseApproval('Dark mode.', question)).toMatchObject({ intent: 'option', optionIndex: 1, optionLabel: 'Dark mode' });
    expect(parseApproval('light', question)).toMatchObject({ intent: 'option', optionIndex: 0 });
  });

  it('a word that fits two options asks which one', () => {
    expect(parseApproval('dark', question)).toEqual({ intent: 'ambiguous', candidates: [{ optionIndex: 1, optionLabel: 'Dark mode' }, { optionIndex: 2, optionLabel: 'Dark blue' }] });
  });

  it('approve, deny, always', () => {
    expect(parseApproval('approve', card)).toEqual({ intent: 'approve' });
    expect(parseApproval('haan kar do', card)).toEqual({ intent: 'approve' });
    expect(parseApproval('deny', card)).toEqual({ intent: 'deny' });
    expect(parseApproval('cancel', card)).toEqual({ intent: 'deny' });
    expect(parseApproval('yes, always', card)).toEqual({ intent: 'approve', always: true });
  });

  it('approve with a note, an addition, a change', () => {
    expect(parseApproval("approve but don't delete the old files", card)).toEqual({ intent: 'approve_with_note', note: "don't delete the old files" });
    expect(parseApproval('Yes, but use Tailwind.', card)).toEqual({ intent: 'approve_with_note', note: 'use Tailwind' });
    expect(parseApproval('haan lekin jaldi', card)).toEqual({ intent: 'approve_with_note', note: 'jaldi' });
    expect(parseApproval('also add dark mode', card)).toEqual({ intent: 'addition', note: 'add dark mode' });
    expect(parseApproval('and also add a footer', card)).toEqual({ intent: 'addition', note: 'add a footer' });
    expect(parseApproval('change the button to blue', card)).toEqual({ intent: 'change', change: 'the button to blue' });
    expect(parseApproval('actually make it dark', card)).toEqual({ intent: 'change', change: 'make it dark' });
    expect(parseApproval('instead do it in the project folder', card)).toEqual({ intent: 'change', change: 'do it in the project folder' });
  });

  it("Claude's questions: never a plain yes; skip; anything else is the user's own answer", () => {
    expect(parseApproval('yes', question)).toEqual({ intent: 'unknown' });
    expect(parseApproval('skip', question)).toEqual({ intent: 'skip' });
    expect(parseApproval('no', question)).toEqual({ intent: 'skip' });
    expect(parseApproval('make it purple', question)).toEqual({ intent: 'answer', text: 'make it purple' });
    expect(parseApproval('change it to purple', question)).toEqual({ intent: 'change', change: 'purple' });
  });

  it('anything else on an ordinary card is unknown (it goes on as a normal request)', () => {
    expect(parseApproval("what's the weather", card)).toEqual({ intent: 'unknown' });
  });
});
