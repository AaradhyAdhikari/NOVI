// Right model, right effort (2026-11-16, spec docs/superpowers/specs/2026-11-16-novi-model-ladder-design.md):
// small work on Haiku low, normal on Sonnet medium, hard on Opus high. Never the extreme efforts on its own.
const LADDER = {
  easy: { model: 'haiku', effort: 'low' },
  medium: { model: 'sonnet', effort: 'medium' },
  hard: { model: 'opus', effort: 'high' },
};
const ORDER = ['easy', 'medium', 'hard'];

export const levelSettings = (level) => ({ ...(LADDER[level] || LADDER.medium) });
export const stepUp = (level) => ORDER[Math.min(ORDER.indexOf(ORDER.includes(level) ? level : 'medium') + 1, ORDER.length - 1)];

// The cheap helper Claude hands small edits to by itself (way 2). Reads and edits files only: no shell, no web.
export const QUICK_AGENT = {
  description: 'Small, simple edits only: change text, a colour, a label, one small component or style. Not for logic, layout, motion, tests or anything that needs thinking.',
  prompt: 'You make small, simple code edits exactly as asked. Change only what is asked, keep the style of the file, and say in one line what you changed.',
  model: 'haiku',
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
};
export const QUICK_LINE = 'For small, simple edits (a text, a colour, a label, one small component) hand the work to the novi-quick agent instead of doing it yourself; keep the thinking-heavy parts.';
