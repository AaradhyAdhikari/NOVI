import { describe, it, expect } from 'vitest';
import { roleFor, agentWords, ROLES } from '../../plugins/agents/roles.js';
import { createRegistry } from '../../plugins/agents/registry.js';

// Multi-agent orchestrator, Phase 3 (2026-11-11). User: "don't make Novi a rule-based router, make it a
// gap-aware router… agents may change but the flow should update itself… if I told don't use ChatGPT use
// Perplexity or DeepSeek it shouldn't get confused". Tasks name a ROLE; any agent that fills the role does
// the same job from the same package; the user's named agent always wins; a missing agent is a gap, said.

describe('the role of a step (never an agent name)', () => {
  it('research, plan, review, build', () => {
    expect(roleFor('Research tip calculator apps for ideas')).toBe('research');
    expect(roleFor('Write the product spec and user flows')).toBe('plan');
    expect(roleFor('Review the security of the inputs')).toBe('review');
    expect(roleFor('Build the bill and tip inputs')).toBe('build');
    expect(roleFor('Write tests for the tip maths')).toBe('build');
    expect(ROLES).toEqual(['research', 'plan', 'build', 'review']);
  });
});

describe("the user's agent words", () => {
  const names = ['Claude', 'Codex', 'ChatGPT', 'Perplexity', 'DeepSeek', 'Gemini'];
  it('"use X" / "in X" / "with X" prefer that agent', () => {
    expect(agentWords('code it in codex', names).prefer).toEqual(['codex']);
    expect(agentWords('run the tip tasks with perplexity', names).prefer).toEqual(['perplexity']);
    expect(agentWords('use claude for this', names).prefer).toEqual(['claude']);
  });
  it('"don\'t use X, use Y" avoids X and prefers Y (or several)', () => {
    const w = agentWords("don't use chatgpt, use perplexity or deepseek", names);
    expect(w.avoid).toEqual(['chatgpt']);
    expect(w.prefer).toEqual(['perplexity', 'deepseek']);
    expect(agentWords('continue without gemini', names).avoid).toEqual(['gemini']);
    expect(agentWords('perplexity instead of chatgpt', names)).toMatchObject({ prefer: ['perplexity'], avoid: ['chatgpt'] });
  });
  it('a misheard name still counts; an unknown one is reported, not guessed', () => {
    expect(agentWords('use perplexety', names).prefer).toEqual(['perplexity']);
    expect(agentWords('use grok', names)).toMatchObject({ prefer: [], unknown: ['grok'] });
  });
  it('no agent words: nothing preferred or avoided', () => {
    expect(agentWords('run the tip calculator tasks', names)).toMatchObject({ prefer: [], avoid: [] });
  });
});

describe('the agent list picks by role, your words first, gaps said', () => {
  const agent = (id, roles, { ok = true, order = 10, why = '' } = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), roles, order, available: async () => (ok ? { ok: true } : { ok: false, why }), run: async () => ({ ok: true, output: `${id} did it` }) });
  function team() {
    const r = createRegistry();
    r.add(agent('claude', ['build'], { order: 1 }));
    r.add(agent('codex', ['build'], { order: 2, ok: false, why: 'Codex is not installed' }));
    r.add(agent('chatgpt', ['research', 'plan', 'review'], { order: 3 }));
    r.add(agent('perplexity', ['research'], { order: 4 }));
    r.add(agent('backup', ['research', 'plan', 'review'], { order: 99 }));
    return r;
  }
  it('the first available agent with the role, in order', async () => {
    expect((await team().pick('research')).agent.id).toBe('chatgpt');
    expect((await team().pick('build')).agent.id).toBe('claude');
  });
  it('a preferred agent wins; an avoided one is skipped', async () => {
    expect((await team().pick('research', { prefer: ['perplexity'] })).agent.id).toBe('perplexity');
    expect((await team().pick('research', { avoid: ['chatgpt'] })).agent.id).toBe('perplexity');
    expect((await team().pick('plan', { avoid: ['chatgpt'] })).agent.id).toBe('backup');
  });
  it('a preferred agent that cannot do the role or is not available: a gap that says why, and the next one', async () => {
    const out = await team().pick('build', { prefer: ['codex'] });
    expect(out.agent.id).toBe('claude');
    expect(out.gap).toMatch(/Codex is not installed/);
    const out2 = await team().pick('build', { prefer: ['perplexity'] });
    expect(out2.agent.id).toBe('claude');
    expect(out2.gap).toMatch(/Perplexity (can't|cannot) build/);
  });
  it('nobody can do it: no agent, the reason, and what was tried', async () => {
    const r = createRegistry();
    r.add(agent('codex', ['build'], { ok: false, why: 'Codex is not installed' }));
    const out = await r.pick('build');
    expect(out.agent).toBe(null);
    expect(out.gap).toMatch(/Codex is not installed/);
    expect(out.tried).toEqual(['codex']);
  });
  it('find by name or alias, any spelling; list says who is available', async () => {
    const r = team();
    r.add({ id: 'gemini', name: 'Gemini', aliases: ['google gemini', 'bard'], roles: ['review'], order: 5, available: async () => ({ ok: true }), run: async () => ({ ok: true }) });
    expect(r.find('bard').id).toBe('gemini');
    expect(r.find('ChatGPT').id).toBe('chatgpt');
    expect(r.find('nothing')).toBe(null);
    const list = await r.status();
    expect(list.find((a) => a.id === 'codex')).toMatchObject({ ok: false, why: 'Codex is not installed', roles: ['build'] });
  });
});

// Code review 2026-11-11.
describe('review fixes: words and roles', () => {
  const names = ['Claude', 'claude code', 'Codex', 'ChatGPT', 'Perplexity', 'the backup AI', 'backup ai', 'Gemini'];
  it('a step that starts with a building verb builds, whatever words follow', () => {
    expect(roleFor('Add security headers middleware')).toBe('build');
    expect(roleFor('Write tests for the review form')).toBe('build');
    expect(roleFor('Build the pricing plan page')).toBe('build');
    expect(roleFor('Review the security of the inputs')).toBe('review');
  });
  it('a comma ends "don\'t use"; "not in X" avoids; multi-word names count', () => {
    expect(agentWords("don't use chatgpt for research, gemini for review", names)).toMatchObject({ avoid: ['chatgpt'], prefer: ['gemini'] });
    expect(agentWords('not in claude, codex', names)).toMatchObject({ avoid: ['claude'], prefer: ['codex'] });
    expect(agentWords('use the backup ai for it', names).prefer).toEqual(['backupai']);
    expect(agentWords('run it with claude code', names).prefer).toEqual(['claudecode']);
  });
});
