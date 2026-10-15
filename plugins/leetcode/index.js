import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';

// LeetCode's public GraphQL: today's problem and a user's solved counts. No browser, no sign-in.
// Username: the tool's param → NOVI_PLUGIN_LEETCODE_USERNAME → the last one said (data/leetcode.json).
const URL = 'https://leetcode.com/graphql';
const TODAY = 'query questionOfToday { activeDailyCodingChallengeQuestion { date link question { title titleSlug difficulty topicTags { name } } } }';
const STATS = 'query userStats($username: String!) { matchedUser(username: $username) { submitStatsGlobal { acSubmissionNum { difficulty count } } userCalendar { streak } } }';
const DOWN = "LeetCode isn't answering right now.";
const reply = (details) => ({ content: [], details });

export function createLeetcodePlugin({ fetchImpl = fetch } = {}) {
  return definePluginEntry({
    id: 'leetcode',
    name: 'LeetCode',
    description: "Today's LeetCode problem and your solved counts.",
    register(api) {
      const file = path.join(api.runtime?.dataDir || 'data', 'leetcode.json');
      const saved = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).username || null; } catch { return null; } };
      const remember = (username) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ username })); } catch { /* not fatal */ } };

      async function query(q, variables = {}) {
        const res = await fetchImpl(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com/' }, body: JSON.stringify({ query: q, variables }), signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`LeetCode ${res.status}`);
        return (await res.json()).data || {};
      }

      api.registerTool({
        name: 'leetcode_today',
        description: "Today's LeetCode daily problem (title, difficulty, topics, link).",
        parameters: { type: 'object', properties: {} },
        async execute() {
          try {
            const d = (await query(TODAY)).activeDailyCodingChallengeQuestion;
            const q = d.question;
            const tags = (q.topicTags || []).map((t) => t.name);
            return reply({ title: q.title, difficulty: q.difficulty, tags, link: `https://leetcode.com${d.link}`, note: `Today's LeetCode: ${q.title} (${q.difficulty})${tags.length ? `, topics ${tags.join(', ')}` : ''}.` });
          } catch { return reply({ note: DOWN }); }
        },
      });

      api.registerTool({
        name: 'leetcode_stats',
        description: "The user's LeetCode solved counts (easy/medium/hard) and streak. username only if the user says it.",
        parameters: { type: 'object', properties: { username: { type: 'string' } } },
        async execute(_id, { username } = {}) {
          const name = String(username || api.pluginConfig?.username || saved() || '').trim();
          if (!name) return reply({ askUsername: true, note: "What's your LeetCode username?" });
          if (username) remember(name);
          try {
            const u = (await query(STATS, { username: name })).matchedUser;
            if (!u) return reply({ note: `LeetCode has no user called ${name}.` });
            const n = Object.fromEntries((u.submitStatsGlobal?.acSubmissionNum || []).map((x) => [x.difficulty.toLowerCase(), x.count]));
            const streak = u.userCalendar?.streak;
            return reply({ username: name, solved: n.all, easy: n.easy, medium: n.medium, hard: n.hard, streak, note: `You've solved ${n.all}: ${n.easy} easy, ${n.medium} medium, ${n.hard} hard.${streak ? ` Streak: ${streak} day${streak === 1 ? '' : 's'}.` : ''}` });
          } catch { return reply({ note: DOWN }); }
        },
      });
    },
  });
}

export default createLeetcodePlugin();
