import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { levelSettings, stepUp, QUICK_AGENT } from '../../server/claude/modelLadder.js';
import { ClaudeSession, claudeArgs } from '../../server/claude/session.js';

// Right model, right effort, even mid-task (2026-11-16, user: "a small box requires Haiku or Sonnet low effort,
// it should use that rather than Opus high effort"). Checked on the installed Claude Code: --model, --effort,
// --agents at start; set_model + apply_flag_settings {effortLevel} while running.
describe('the ladder', () => {
  it('easy = Haiku low, medium = Sonnet medium, hard = Opus high; unknown = medium', () => {
    expect(levelSettings('easy')).toEqual({ model: 'haiku', effort: 'low' });
    expect(levelSettings('medium')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(levelSettings('hard')).toEqual({ model: 'opus', effort: 'high' });
    expect(levelSettings('???')).toEqual({ model: 'sonnet', effort: 'medium' });
  });
  it('a redo goes one step up, never past hard', () => {
    expect(stepUp('easy')).toBe('medium');
    expect(stepUp('medium')).toBe('hard');
    expect(stepUp('hard')).toBe('hard');
  });
});

describe('starting a Claude run', () => {
  it('starts on the given model + effort and always brings the cheap helper', () => {
    const args = claudeArgs({ model: 'haiku', effort: 'low' });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'haiku']);
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'low']);
    const agents = JSON.parse(args[args.indexOf('--agents') + 1]);
    expect(agents['novi-quick']).toMatchObject({ model: 'haiku' });
    expect(agents['novi-quick'].tools).toEqual(QUICK_AGENT.tools);
    expect(agents['novi-quick'].tools).not.toContain('Bash'); // the helper only reads and edits
    expect(args[args.indexOf('--append-system-prompt') + 1]).toMatch(/novi-quick/);
  });
  it('no model given: no --model / --effort (Claude Code\'s own choice), helper still there', () => {
    const args = claudeArgs({});
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args).toContain('--agents');
  });
});

describe('switching inside a running session', () => {
  function fakeSession() {
    const written = [];
    const proc = new EventEmitter();
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: (s) => written.push(JSON.parse(s)), end() {} });
    proc.pid = 1;
    const session = new ClaudeSession({ command: 'claude', cwd: '.', onPermission: async () => ({ allow: true }), spawnImpl: () => proc });
    return { session, written };
  }
  it('sends set_model and the effort setting, and only what changed', () => {
    const { session, written } = fakeSession();
    session.setModel('opus', 'high');
    session.setModel('opus', 'high'); // nothing changed: nothing sent
    session.setModel('haiku', 'low');
    const asks = written.filter((w) => w.type === 'control_request' && w.request.subtype !== 'initialize').map((w) => w.request);
    expect(asks).toEqual([
      { subtype: 'set_model', model: 'opus' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
      { subtype: 'set_model', model: 'haiku' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } },
    ]);
  });
});
