import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';

// Morning briefing: one short spoken summary of the day, built from other plugins' read-only tools
// (weather, calendar, tasks, Gmail, GitHub, reminders, memory) via api.runtime.callTool.
// On request ("good morning", "what's my day like?") or every day at a time set by voice.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_FIRST = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'i');
const MONTH_FIRST = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Birthdays remembered as facts like "Mom's birthday is 7 October" or "Rohan's birthday: October 8th".
export function birthdaysOn(factTexts, date) {
  const tomorrow = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  const out = { today: [], tomorrow: [] };
  for (const text of factTexts) {
    if (!/birthday/i.test(text)) continue;
    const m = DAY_FIRST.exec(text) || MONTH_FIRST.exec(text);
    if (!m) continue;
    const [day, month] = DAY_FIRST.test(text) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    const monthIndex = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
    const who = text.split(/\s*birthday/i)[0].trim() || 'Someone';
    if (monthIndex === date.getMonth() && day === date.getDate()) out.today.push(who);
    else if (monthIndex === tomorrow.getMonth() && day === tomorrow.getDate()) out.tomorrow.push(who);
  }
  return out;
}

function parseTime(value) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(String(value || ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

export function createBriefingPlugin({ now = () => new Date(), tickMs = 30_000 } = {}) {
  return definePluginEntry({
    id: 'briefing',
    name: 'Morning briefing',
    description: 'A short spoken summary of your day: weather, calendar, tasks, mail, GitHub, reminders, birthdays.',
    register(api) {
      const file = path.join(api.runtime.dataDir || path.resolve('data'), 'briefing.json');
      const readCfg = () => { try { return { time: null, lastDay: null, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { time: null, lastDay: null }; } };
      const writeCfg = (cfg) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); };

      const SOURCES = [
        ['weather', 'weather_get', {}],
        ['calendar', 'calendar_events', {}],
        ['tasks', 'tasks_list', {}],
        ['mail', 'gmail_search', { query: 'is:unread newer_than:1d category:primary', max: 5 }],
        ['github', 'github_notifications', {}],
        ['reminders', 'reminder_list', {}],
        ['memory', 'memory_list', {}],
      ];

      async function compose() {
        const d = now();
        const got = {};
        const missing = [];
        await Promise.all(SOURCES.map(async ([key, tool, params]) => {
          try { got[key] = await api.runtime.callTool(tool, params); } catch (err) { missing.push(`${key}: not available (${err.message})`); }
        }));
        const spoken = [`Good ${d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening'}!`];
        const lines = [`${d.toDateString()}`];

        const w = got.weather;
        if (w?.current && w.days?.[0]) {
          const today = w.days[0];
          spoken.push(`It's ${Math.round(w.current.temperature)} degrees and ${w.current.summary} in ${String(w.place).split(',')[0]}, up to ${Math.round(today.max)}${today.rainChance >= 40 ? `, ${today.rainChance}% chance of rain` : ''}.`);
          lines.push(`Weather: ${w.text || `${Math.round(w.current.temperature)}°C, ${w.current.summary}`}`);
        }
        const events = got.calendar?.events;
        if (Array.isArray(events)) {
          const timeOf = (e) => (e.start?.dateTime ? new Date(e.start.dateTime) : null);
          const next = events.find((e) => (timeOf(e) || d) >= d) || events[0];
          if (events.length) spoken.push(`You have ${plural(events.length, 'thing')} on your calendar, first ${next.title}${timeOf(next) ? ` at ${hhmm(timeOf(next))}` : ' (all day)'}.`);
          else spoken.push('Your calendar is clear.');
          lines.push(`Calendar: ${events.map((e) => `${timeOf(e) ? hhmm(timeOf(e)) : 'all day'} ${e.title}`).join('; ') || 'nothing'}`);
        }
        const tasks = got.tasks?.tasks;
        if (Array.isArray(tasks)) {
          const due = tasks.filter((t) => t.due && t.due.slice(0, 10) <= localDay(d));
          if (due.length) spoken.push(`${plural(due.length, 'task')} due, including ${due[0].title}.`);
          lines.push(`Tasks: ${tasks.map((t) => t.title).join('; ') || 'none'}`);
        }
        const mail = got.mail?.messages;
        if (Array.isArray(mail)) {
          const who = (m) => String(m.from || '').replace(/\s*<[^>]*>/, '').replace(/"/g, '').trim();
          if (mail.length) spoken.push(`${plural(mail.length, 'unread email')}, including ${who(mail[0])}: ${mail[0].subject}.`);
          lines.push(`Mail: ${mail.map((m) => `${who(m)}: ${m.subject}`).join('; ') || 'no new mail'}`);
        }
        const gh = got.github?.notifications;
        if (Array.isArray(gh)) {
          if (gh.length) spoken.push(`${plural(gh.length, 'GitHub notification')}.`);
          lines.push(`GitHub: ${gh.map((n) => `${n.repo}: ${n.title}`).join('; ') || 'nothing new'}`);
        }
        const reminders = (got.reminders?.items || []).filter((r) => /^today\b/i.test(r.when || ''));
        if (reminders.length) {
          spoken.push(`Reminder today: ${reminders.map((r) => r.text).join(', ')}.`);
          lines.push(`Reminders: ${reminders.map((r) => `${r.when}: ${r.text}`).join('; ')}`);
        }
        const bdays = birthdaysOn((got.memory?.facts || []).map((f) => f.text), d);
        if (bdays.today.length) spoken.push(`Today is ${bdays.today.join(' and ')} birthday.`);
        if (bdays.tomorrow.length) spoken.push(`Tomorrow is ${bdays.tomorrow.join(' and ')} birthday.`);

        return { spoken: spoken.join(' '), text: [...lines, ...missing].join('\n') };
      }

      api.registerTool({
        name: 'briefing_get',
        description: 'The daily briefing: weather, calendar, tasks due, unread mail, GitHub, reminders and birthdays. Use for "good morning", "brief me", "what\'s my day like". Say the spoken summary as is.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          const { spoken, text } = await compose();
          return { content: [{ type: 'text', text: `Say this: ${spoken}\n\nDetails:\n${text}` }], details: { spoken, sensitive: true } };
        },
      });

      api.registerTool({
        name: 'briefing_schedule',
        description: 'Give the briefing automatically every day at a time (e.g. "07:30" or "7:30 am"), or "off" to stop.',
        parameters: { type: 'object', properties: { time: { type: 'string', description: 'HH:MM (24h), "7:30 am", or "off"' } }, required: ['time'] },
        async execute(_id, { time }) {
          const cfg = readCfg();
          if (/^\s*(off|stop|none|no)\s*$/i.test(String(time))) {
            writeCfg({ ...cfg, time: null });
            return { content: [{ type: 'text', text: 'Okay, the daily briefing is off.' }], details: { time: null } };
          }
          const t = parseTime(time);
          if (!t) return { content: [{ type: 'text', text: 'Tell me the time as HH:MM, for example 07:30.' }], details: {} };
          writeCfg({ ...cfg, time: t, lastDay: t <= hhmm(now()) ? localDay(now()) : cfg.lastDay });
          return { content: [{ type: 'text', text: `Okay, I'll brief you every day at ${t}.` }], details: { time: t } };
        },
      });

      let timer = null;
      async function tick() {
        const cfg = readCfg();
        if (!cfg.time) return;
        const d = now();
        const [h, m] = cfg.time.split(':').map(Number);
        const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
        if (cfg.lastDay === localDay(d) || d < due || d - due > 60 * 60_000) return; // once a day, within an hour of the time
        writeCfg({ ...cfg, lastDay: localDay(d) });
        try {
          api.runtime.say((await compose()).spoken, { kind: 'briefing' });
        } catch (err) {
          api.logger?.warn?.(`[briefing] failed: ${err.message}`);
        }
      }
      api.registerService({
        start: () => { timer = setInterval(() => { tick().catch(() => {}); }, tickMs); timer.unref?.(); },
        stop: () => clearInterval(timer),
      });
    },
  });
}

export default createBriefingPlugin();
