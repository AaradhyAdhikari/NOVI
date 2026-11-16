import { describe, it, expect } from 'vitest';
import { validate, planRoutine, planPrompt } from '../../plugins/routines/plan.js';

// Routines: the AI turns your words into a fixed plan once; Novi checks it before you ever see a card.
const good = { name: 'Morning GitHub', when: { every: 'daily', at: '07:00' }, steps: [{ tool: 'github_activity', params: { days: 1 }, label: 'Your GitHub activity' }], report: 'what changed on GitHub', onlyChanges: true };

describe('checking a plan', () => {
  it('a good plan passes as it is', () => {
    const r = validate(good);
    expect(r.routine).toMatchObject({ name: 'Morning GitHub', steps: [{ tool: 'github_activity', label: 'Your GitHub activity' }], onlyChanges: true });
  });
  it('a tool that sends, changes or runs code is refused, nothing saved', () => {
    expect(validate({ ...good, steps: [{ tool: 'whatsapp_send', params: {}, label: 'x' }] })).toEqual({ error: "I can only look things up in a routine; whatsapp_send isn't one of those." });
    expect(validate({ ...good, steps: [{ tool: 'code_tests', params: {}, label: 'x' }] }).error).toMatch(/code_tests isn't one of those/);
  });
  it('1 to 6 steps', () => {
    expect(validate({ ...good, steps: [] })).toEqual({ error: 'A routine has 1 to 6 steps.' });
    expect(validate({ ...good, steps: Array(7).fill(good.steps[0]) })).toEqual({ error: 'A routine has 1 to 6 steps.' });
  });
  it('a when it can\'t follow', () => {
    const err = 'I couldn\'t tell when it should run. Say a time like "every day at 7:00" or "when a coding task finishes".';
    expect(validate({ ...good, when: { every: 'hourly:0' } })).toEqual({ error: err });
    expect(validate({ ...good, when: { every: 'daily', at: '7pm' } })).toEqual({ error: err });
    expect(validate({ ...good, when: { on: 'whenever' } })).toEqual({ error: err });
  });
  it('{project} only in an event routine; params are plain values', () => {
    const again = 'Those steps look wrong; say it again a bit differently.';
    const withProject = { ...good, steps: [{ tool: 'project_board', params: { project: '{project}' }, label: 'Board' }] };
    expect(validate(withProject)).toEqual({ error: again });
    expect(validate({ ...withProject, when: { on: 'coding_done' } }).routine).toBeTruthy();
    expect(validate({ ...good, steps: [{ tool: 'weather_get', params: { place: { x: 1 } }, label: 'W' }] })).toEqual({ error: again });
  });
});

describe('planning from words', () => {
  it('reads the JSON inside the AI\'s reply', async () => {
    const complete = async () => `Sure! Here it is:\n${JSON.stringify(good)}\nHope that helps.`;
    const r = await planRoutine('every morning check my github and tell me what changed', { complete, catalog: ['github_activity: your GitHub activity'] });
    expect(r.routine.name).toBe('Morning GitHub');
  });
  it('a reply with no plan → asks to say it again', async () => {
    const r = await planRoutine('do the thing', { complete: async () => 'sorry, I cannot', catalog: [] });
    expect(r).toEqual({ error: 'Those steps look wrong; say it again a bit differently.' });
  });
  it('the prompt carries the words and the look tools only', () => {
    const p = planPrompt('every morning check my github', ['github_activity: your GitHub activity']);
    expect(p).toMatch(/every morning check my github/);
    expect(p).toMatch(/github_activity/);
  });
});
