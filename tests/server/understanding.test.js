import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { scoreStep, loadCommands } from '../../tools/understanding-benchmark.mjs';

describe('understanding test scoring', () => {
  it('quick replies must match exactly', () => {
    expect(scoreStep({ quick: 'approve', calls: [] }, { quick: 'approve' })).toBe('pass');
    expect(scoreStep({ quick: null, calls: [], reply: 'ok' }, { quick: 'approve' })).toBe('fail');
  });

  it('a tool command passes when one of the expected tools is called with matching arguments', () => {
    const want = { tools: ['open_project'], args: { project: 'novi', editor: 'cursor' } };
    expect(scoreStep({ quick: null, calls: [{ name: 'open_project', args: { project: 'NOVI', editor: 'Cursor' } }] }, want)).toBe('pass');
    expect(scoreStep({ quick: null, calls: [{ name: 'open_project', args: { project: 'NOVI', editor: 'code' } }] }, want)).toBe('fail');
    expect(scoreStep({ quick: null, calls: [], reply: 'Sure!' }, want)).toBe('fail');
    expect(scoreStep({ quick: null, calls: [{ name: 'github_activity', args: {} }] }, { tools: ['github_activity', 'screen_page'] })).toBe('pass');
  });

  it('commands for features that do not exist yet are counted separately', () => {
    expect(scoreStep({ quick: null, calls: [], reply: 'x' }, { notBuilt: 'LeetCode' })).toBe('not built');
  });

  it('the everyday commands file is valid: every line says something and expects something', () => {
    const commands = loadCommands();
    expect(commands.length).toBeGreaterThanOrEqual(20);
    for (const c of commands) {
      expect(typeof c.say, JSON.stringify(c)).toBe('string');
      expect(Boolean(c.expect.quick || c.expect.tools?.length || c.expect.notBuilt), c.say).toBe(true);
    }
    expect(fs.existsSync('tools/my-commands.json')).toBe(true);
  });
});
