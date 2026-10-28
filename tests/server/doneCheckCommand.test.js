import { describe, it, expect } from 'vitest';
import { doneCheckCommand } from '../../server/brain/doneCheckCommand.js';

describe('done-check by voice (no AI)', () => {
  it('check', () => {
    expect(doneCheckCommand('check it')).toEqual({ tool: 'donecheck_run', args: {} });
    expect(doneCheckCommand('Okay Novi, is it done?')).toEqual({ tool: 'donecheck_run', args: {} });
    expect(doneCheckCommand('run the checks on tip calculator')).toEqual({ tool: 'donecheck_run', args: { project: 'tip calculator' } });
    expect(doneCheckCommand('check my portfolio project')).toEqual({ tool: 'donecheck_run', args: { project: 'portfolio' } });
    expect(doneCheckCommand('is the tip calculator app done')).toEqual({ tool: 'donecheck_run', args: { project: 'tip calculator' } });
  });

  it('fix', () => {
    expect(doneCheckCommand('fix it')).toEqual({ tool: 'donecheck_fix', args: {} });
    expect(doneCheckCommand('fix the failed ones')).toEqual({ tool: 'donecheck_fix', args: {} });
    expect(doneCheckCommand('theek karo')).toEqual({ tool: 'donecheck_fix', args: {} });
    expect(doneCheckCommand('fix the failed checks in portfolio')).toEqual({ tool: 'donecheck_fix', args: { project: 'portfolio' } });
  });

  it('leaves everything else alone', () => {
    for (const t of ['check my email', 'check my notes about exams', 'check my ChatGPT plan', 'fix the login bug in Novi', 'is it raining', 'check the weather']) {
      expect(doneCheckCommand(t)).toBeNull();
    }
  });
});
