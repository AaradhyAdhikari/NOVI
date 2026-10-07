import { definePluginEntry } from '#plugin-sdk';

// Google Calendar and Tasks on the Google account already connected for Gmail.
// Reading is private (sensitive); adding / completing asks first (grantable "calendar" / "tasks").
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (d) => `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details: { ...details, sensitive: true } });

function parseLocal(s) {
  const m = LOCAL.exec(String(s || '').trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

function describeEvent(e) {
  if (e.start?.date) return `all day: ${e.summary || '(no title)'}`;
  const start = new Date(e.start.dateTime);
  const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
  return `${hhmm(start)}${end ? `–${hhmm(end)}` : ''} ${e.summary || '(no title)'}${e.location ? ` @ ${e.location}` : ''}`;
}

export function createGooglePlugin({ now = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  return definePluginEntry({
    id: 'google',
    name: 'Google Calendar and Tasks',
    description: 'Your calendar and to-do list on the Google account connected for Gmail.',
    register(api) {
      const obj = (properties, required = []) => ({ type: 'object', properties, required });
      const str = (description) => ({ type: 'string', description });
      const ACCOUNT = str('Google account label or email; omit for the default or the only one');

      // Resolve the account and check it allowed this service; returns { account } or { stop: reply }.
      function pick(requested, scope, what) {
        const google = api.runtime.google;
        if (!google?.configured) return { stop: reply("Google isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to Novi's .env.") };
        const r = google.resolve(requested);
        if (r.error) return { stop: reply(r.error) };
        if (r.ask) return { stop: reply(`Which account: ${r.ask.map((a) => `${a.label} (${a.email})`).join(' or ')}?`, { ask: r.ask }) };
        if (r.account.status === 'expired') return { stop: reply(`Your ${r.account.label} Google connection expired: reconnect it in Settings.`) };
        if (!(r.account.scopes || []).includes(scope)) return { stop: reply(`${what} isn't allowed on ${r.account.label} yet. In Settings → Accounts, click "Connect Gmail" again with the same account and tick ${what} on Google's screen.`) };
        return { account: r.account };
      }
      const call = (account, url, init) => api.runtime.google.call(account, url, init);
      const json = (method, body) => ({ method, body: JSON.stringify(body) });

      async function eventsBetween(account, from, to) {
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
        return (await call(account, `${CAL}?${q}`)).items || [];
      }

      api.on('before_prompt_build', () => {
        const d = now();
        const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/^(\w+) /, '$1, ');
        return { prependContext: `Current date and time: ${day}, ${hhmm(d)} (${timeZone}). Give calendar and task tools local times as YYYY-MM-DDTHH:MM.` };
      });

      api.registerTool({
        name: 'calendar_events',
        description: "What's on the user's Google Calendar. date: \"today\" (default), \"tomorrow\" or YYYY-MM-DD; days: how many days from that date (1-14).",
        parameters: obj({ date: str('"today", "tomorrow" or YYYY-MM-DD'), days: { type: 'number', description: '1-14, default 1' }, account: ACCOUNT }),
        async execute(_id, { date, days, account } = {}) {
          const p = pick(account, CALENDAR_SCOPE, 'Calendar');
          if (p.stop) return p.stop;
          const base = now();
          let from = new Date(base.getFullYear(), base.getMonth(), base.getDate());
          if (date === 'tomorrow') from.setDate(from.getDate() + 1);
          else if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) { const [y, m, dd] = date.split('-').map(Number); from = new Date(y, m - 1, dd); }
          const n = Math.min(14, Math.max(1, Math.round(Number(days) || 1)));
          const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n);
          const events = await eventsBetween(p.account, from, to);
          if (!events.length) return reply(`Nothing on the calendar ${n === 1 ? `on ${localDay(from)}` : `from ${localDay(from)} for ${n} days`}.`, { events: [] });
          const lines = events.map((e) => (n > 1 ? `${(e.start.date || e.start.dateTime).slice(0, 10)} ` : '') + describeEvent(e));
          return reply(lines.join('\n'), { events: events.map((e) => ({ title: e.summary, start: e.start, end: e.end, location: e.location })) });
        },
      });

      api.registerTool({
        name: 'calendar_free',
        description: 'Is the user free at a time? start: local YYYY-MM-DDTHH:MM; minutes: how long (default 60).',
        parameters: obj({ start: str('Local start, YYYY-MM-DDTHH:MM'), minutes: { type: 'number', description: 'default 60' }, account: ACCOUNT }, ['start']),
        async execute(_id, { start, minutes, account }) {
          const from = parseLocal(start);
          if (!from) return reply('Give the time as YYYY-MM-DDTHH:MM, e.g. 2026-10-09T16:00.');
          const p = pick(account, CALENDAR_SCOPE, 'Calendar');
          if (p.stop) return p.stop;
          const to = new Date(from.getTime() + (Number(minutes) || 60) * 60_000);
          const busy = (await eventsBetween(p.account, from, to)).filter((e) => e.start?.dateTime);
          return busy.length
            ? reply(`You're busy then: ${busy.map(describeEvent).join('; ')}.`, { busy: true })
            : reply(`You're free from ${hhmm(from)} to ${hhmm(to)} on ${localDay(from)}.`, { busy: false });
        },
      });

      api.registerTool({
        name: 'calendar_add',
        description: 'Add an event to the user\'s Google Calendar. start: local YYYY-MM-DDTHH:MM; minutes: length (default 60). No guests are invited.',
        parameters: obj({ title: str('Event title'), start: str('Local start, YYYY-MM-DDTHH:MM'), minutes: { type: 'number', description: 'default 60' }, description: str('Optional notes'), account: ACCOUNT }, ['title', 'start']),
        async execute(_id, { title, start, minutes, description, account }) {
          const from = parseLocal(start);
          if (!from) return reply('Give the start as YYYY-MM-DDTHH:MM (local time), e.g. 2026-10-09T16:00.');
          const p = pick(account, CALENDAR_SCOPE, 'Calendar');
          if (p.stop) return p.stop;
          const to = new Date(from.getTime() + (Number(minutes) || 60) * 60_000);
          const body = { summary: String(title).slice(0, 200), start: { dateTime: localStamp(from), timeZone }, end: { dateTime: localStamp(to), timeZone }, ...(description ? { description: String(description).slice(0, 2000) } : {}) };
          const created = await call(p.account, CAL, json('POST', body));
          return reply(`Added "${body.summary}" on ${localDay(from)} at ${hhmm(from)}.`, { id: created.id, link: created.htmlLink });
        },
      });

      async function openTasks(account) {
        const q = new URLSearchParams({ showCompleted: 'false', maxResults: '100' });
        return (await call(account, `${TASKS}?${q}`)).items || [];
      }
      const dueText = (t) => (t.due ? ` (due ${new Date(t.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })})` : '');
      const words = (s) => String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const bestTask = (tasks, query) => {
        const q = words(query);
        const scored = tasks.map((t) => ({ t, s: q.filter((w) => words(t.title).some((x) => x.startsWith(w))).length })).filter((x) => x.s > 0);
        return scored.sort((a, b) => b.s - a.s)[0]?.t || null;
      };

      api.registerTool({
        name: 'tasks_list',
        description: "The user's open Google Tasks (to-do list).",
        parameters: obj({ account: ACCOUNT }),
        async execute(_id, { account } = {}) {
          const p = pick(account, TASKS_SCOPE, 'Tasks');
          if (p.stop) return p.stop;
          const tasks = await openTasks(p.account);
          return reply(tasks.length ? tasks.map((t) => `- ${t.title}${dueText(t)}`).join('\n') : 'Your to-do list is empty.', { tasks: tasks.map((t) => ({ id: t.id, title: t.title, due: t.due })) });
        },
      });

      api.registerTool({
        name: 'tasks_add',
        description: 'Add a task to the user\'s Google Tasks. due: optional YYYY-MM-DD.',
        parameters: obj({ title: str('The task'), due: str('Optional due date, YYYY-MM-DD'), notes: str('Optional notes'), account: ACCOUNT }, ['title']),
        async execute(_id, { title, due, notes, account }) {
          const p = pick(account, TASKS_SCOPE, 'Tasks');
          if (p.stop) return p.stop;
          const body = { title: String(title).slice(0, 300), ...(/^\d{4}-\d{2}-\d{2}$/.test(String(due || '')) ? { due: `${due}T00:00:00.000Z` } : {}), ...(notes ? { notes: String(notes).slice(0, 2000) } : {}) };
          await call(p.account, TASKS, json('POST', body));
          return reply(`Added to your tasks: ${body.title}${due ? ` (due ${due})` : ''}.`);
        },
      });

      api.registerTool({
        name: 'tasks_complete',
        description: 'Mark the open task that best matches the description as done.',
        parameters: obj({ task: str('Words from the task, e.g. "dbms assignment"'), account: ACCOUNT }, ['task']),
        async execute(_id, { task, account }) {
          const p = pick(account, TASKS_SCOPE, 'Tasks');
          if (p.stop) return p.stop;
          const t = bestTask(await openTasks(p.account), task);
          if (!t) return reply(`I couldn't find an open task like "${task}".`);
          await call(p.account, `${TASKS}/${encodeURIComponent(t.id)}`, json('PATCH', { status: 'completed' }));
          return reply(`Done: ${t.title}.`);
        },
      });

      api.on('before_tool_call', async ({ toolName, params }) => {
        if (toolName === 'calendar_add') {
          const when = parseLocal(params.start);
          return { requireApproval: { title: `Add to calendar: ${params.title}`, description: when ? `${localDay(when)} at ${hhmm(when)}, ${Number(params.minutes) || 60} min` : String(params.start || ''), severity: 'warning', category: 'calendar', grantable: true } };
        }
        if (toolName === 'tasks_add') return { requireApproval: { title: `Add task: ${params.title}`, description: params.due ? `due ${params.due}` : '', severity: 'warning', category: 'tasks', grantable: true } };
        if (toolName === 'tasks_complete') {
          const p = pick(params.account, TASKS_SCOPE, 'Tasks');
          const t = p.stop ? null : bestTask(await openTasks(p.account), params.task);
          if (!t) return undefined; // nothing to change; the tool will say so
          return { requireApproval: { title: 'Mark task done', description: t.title, severity: 'warning', category: 'tasks', grantable: true } };
        }
        return undefined;
      });
    },
  });
}

export default createGooglePlugin();
