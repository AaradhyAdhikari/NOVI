import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createLeetcodePlugin } from '../../plugins/leetcode/index.js';

const TODAY = { data: { activeDailyCodingChallengeQuestion: { date: '2026-10-15', link: '/problems/two-sum/', question: { title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy', topicTags: [{ name: 'Array' }, { name: 'Hash Table' }] } } } };
const STATS = { data: { matchedUser: { submitStatsGlobal: { acSubmissionNum: [{ difficulty: 'All', count: 212 }, { difficulty: 'Easy', count: 120 }, { difficulty: 'Medium', count: 80 }, { difficulty: 'Hard', count: 12 }] }, userCalendar: { streak: 5 } } } };

function setup({ env = {}, reply } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (reply) return reply(calls.at(-1));
    return Response.json(/activeDaily/.test(opts.body) ? TODAY : STATS);
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-lc-'));
  const host = new PluginHost({ runtime: { dataDir }, env, logger: { warn() {} } });
  expect(host.register(createLeetcodePlugin({ fetchImpl }))).toBe(true);
  return { host, calls, dataDir };
}

describe('LeetCode (public data, no browser)', () => {
  it("today's problem: title, difficulty, topics and link", async () => {
    const { host, calls } = setup();
    const out = await host.get('leetcode_today').run({});
    expect(calls[0].url).toBe('https://leetcode.com/graphql');
    expect(out.note).toBe("Today's LeetCode: Two Sum (Easy), topics Array, Hash Table.");
    expect(out.link).toBe('https://leetcode.com/problems/two-sum/');
  });

  it('stats for the username from .env, or one said once (remembered)', async () => {
    const env = setup({ env: { NOVI_PLUGIN_LEETCODE_USERNAME: 'aaradhy' } });
    const out = await env.host.get('leetcode_stats').run({});
    expect(env.calls[0].body.variables).toEqual({ username: 'aaradhy' });
    expect(out.note).toBe("You've solved 212: 120 easy, 80 medium, 12 hard. Streak: 5 days.");
    const none = setup();
    expect(await none.host.get('leetcode_stats').run({})).toMatchObject({ askUsername: true, note: "What's your LeetCode username?" });
    await none.host.get('leetcode_stats').run({ username: 'coder1' });
    await none.host.get('leetcode_stats').run({});
    expect(none.calls.at(-1).body.variables).toEqual({ username: 'coder1' });
  });

  it('unknown user and LeetCode down say so', async () => {
    const unknown = setup({ reply: () => Response.json({ data: { matchedUser: null } }) });
    expect((await unknown.host.get('leetcode_stats').run({ username: 'nobody' })).note).toBe('LeetCode has no user called nobody.');
    const down = setup({ reply: () => new Response('', { status: 503 }) });
    expect((await down.host.get('leetcode_today').run({})).note).toBe("LeetCode isn't answering right now.");
    const broken = setup({ reply: () => { throw new Error('ECONNRESET'); } });
    expect((await broken.host.get('leetcode_stats').run({ username: 'x' })).note).toBe("LeetCode isn't answering right now.");
  });
});
