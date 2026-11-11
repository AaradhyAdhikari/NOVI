import { describe, it, expect } from 'vitest';
import { catalogLines, parsePick, needsPick } from '../../server/brain/intentPick.js';
import { createGaps } from '../../server/brain/gaps.js';
import { Agent } from '../../server/brain/agent.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { ToolRegistry } from '../../server/tools/registry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Smart routing (user, 2026-11-10: "is Novi becoming rule based … it doesn't even think on its own when a new
// question or problem arises"). The keyword picker gave the AI only 5 basic tools when no word matched, so a
// request said a new way couldn't be acted on. Now a quick AI step reads one line per ability and picks.
const schema = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });

describe('the list of abilities', () => {
  it('one short line per tool: name and the first sentence of what it does', () => {
    const lines = catalogLines([schema('pantry_check', 'Look up what food is at home. Uses the pantry sheet. More words here.'), schema('clock_now', 'The time.')]);
    expect(lines).toBe('pantry_check: Look up what food is at home.\nclock_now: The time.');
  });
  it('long first sentences are cut', () => {
    expect(catalogLines([schema('x_y', 'a'.repeat(300))]).length).toBeLessThan(120);
  });
});

describe('reading the pick', () => {
  const known = new Set(['pantry_check', 'weather_get', 'screen_click']);
  it('takes known tool names from JSON, even inside a code fence', () => {
    expect(parsePick('{"tools":["pantry_check"]}', known)).toEqual({ tools: ['pantry_check'], ask: null });
    expect(parsePick('```json\n{"tools":["weather_get","screen_click"],"ask":null}\n```', known)).toEqual({ tools: ['weather_get', 'screen_click'], ask: null });
  });
  it('drops names that do not exist, keeps at most 4, keeps a question', () => {
    expect(parsePick('{"tools":["made_up","pantry_check"]}', known).tools).toEqual(['pantry_check']);
    expect(parsePick('{"tools":["pantry_check","weather_get","screen_click","pantry_check","weather_get"]}', known).tools).toHaveLength(3);
    expect(parsePick('{"tools":[],"ask":"Which project?"}', known)).toEqual({ tools: [], ask: 'Which project?' });
  });
  it('anything unreadable picks nothing', () => {
    expect(parsePick('I think pantry', known)).toEqual({ tools: [], ask: null });
    expect(parsePick('', known)).toEqual({ tools: [], ask: null });
  });
});

describe('when to pick', () => {
  const basics = [schema('open_app', ''), schema('clock_now', '')];
  it('only when the keywords found nothing beyond the basics, and the words say something', () => {
    expect(needsPick(basics, 'do we have milk at home')).toBe(true);
    expect(needsPick([...basics, schema('weather_get', '')], 'weather today')).toBe(false);
    expect(needsPick(basics, 'hi')).toBe(false);
  });
});

describe('the gap log', () => {
  it('keeps what no rule caught and what the AI picked, and sums it up', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-')), 'gaps.jsonl');
    const gaps = createGaps({ file, now: () => Date.parse('2026-11-11T10:00:00Z') });
    gaps.record({ heard: 'do we have milk', picked: ['pantry_check'] });
    gaps.record({ heard: 'is there milk', picked: ['pantry_check'] });
    gaps.record({ heard: 'sing me something', picked: [] });
    const s = gaps.summary(7);
    expect(s).toMatch(/3 requests/);
    expect(s).toMatch(/pantry_check \(2\)/);
    expect(s).toMatch(/sing me something/);
  });
});

describe('the agent picks abilities when no keyword fits', () => {
  it('asks the quick AI first, then the main AI gets the picked tool', async () => {
    const calls = [];
    const router = {
      chat: async (req) => {
        calls.push(req);
        if (calls.length === 1) return { message: { role: 'assistant', content: '{"tools":["pantry_check"]}' }, provider: 'groq', model: 'm' };
        return { message: { role: 'assistant', content: 'You have milk.' }, provider: 'groq', model: 'm' };
      },
    };
    const tools = new ToolRegistry().add({ name: 'pantry_check', description: 'Look up what food is at home.', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'pantry', run: async () => ({ note: 'milk: yes' }) });
    const gapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-')), 'g.jsonl');
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    agent.gaps = createGaps({ file: gapFile });
    agent.smartPick = true;
    expect(await agent.handle('do we have any milk left at home')).toBe('You have milk.');
    expect(calls[0].purpose).toBe('quick');
    expect(calls[1].tools.map((t) => t.function.name)).toContain('pantry_check');
    expect(fs.readFileSync(gapFile, 'utf8')).toMatch(/pantry_check/);
  });
});

describe('asking about the gaps', () => {
  it('"what didn\'t you understand this week" reads the gap log, no AI', async () => {
    const router = { chat: async () => { throw new Error('no AI'); } };
    const agent = new Agent({ router, tools: new ToolRegistry(), approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    agent.gaps = { summary: () => '2 requests had no ready rule.', record() {} };
    expect(await agent.handle("what didn't you understand this week")).toBe('2 requests had no ready rule.');
    expect(await agent.handle('what did you not get today')).toBe('2 requests had no ready rule.');
  });
});

// User, 2026-11-10: in the remote view the AI should read the screen and plan the steps, not answer
// "I didn't get that as a step".
describe('the remote view thinks instead of asking back', () => {
  it('a phrase no rule takes goes to the AI with the screen and laptop tools and a note about the live view', async () => {
    const calls = [];
    const router = { chat: async (req) => { calls.push(req); return { message: { role: 'assistant', content: 'Clicked the blue button.' }, provider: 'groq', model: 'm' }; } };
    const tool = (name) => ({ name, description: `${name} tool.`, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async () => ({ note: 'ok' }) });
    const tools = new ToolRegistry().add(tool('screen_items')).add(tool('screen_click')).add(tool('laptop_window')).add(tool('weather_get'));
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    agent.liveViewing = (from) => from?.deviceId === 'p1';
    expect(await agent.handle('press the big blue thingy at the top', { from: { deviceId: 'p1' } })).toBe('Clicked the blue button.');
    const main = calls.at(-1);
    const names = main.tools.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['screen_items', 'screen_click', 'laptop_window']));
    expect(names).not.toContain('weather_get');
    expect(main.messages[0].content).toMatch(/watching the laptop screen live/);
  });
});
