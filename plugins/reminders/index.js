import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { parseWhen, describeTime, parseRepeat, alignToRepeat, describeRepeat } from './parse.js';
import { ReminderStore } from './store.js';
import { ReminderScheduler } from './scheduler.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const text = (t, details = {}) => ({ content: [{ type: 'text', text: t }], details });

export function createRemindersPlugin() {
  return definePluginEntry({
    id: 'reminders',
    name: 'Reminders & timers',
    description: 'Spoken reminders and timers that survive restarts.',
    register(api) {
      const store = new ReminderStore(path.join(api.runtime.dataDir || 'data', 'reminders.json'));
      const say = (t) => api.runtime.say?.(t);
      const scheduler = new ReminderScheduler({
        store,
        onFire: (r, { missed }) => {
          // A rule with a look-up action ("every morning at 8 tell me the weather"): run it and say
          // the answer. runtime.callTool refuses anything that needs approval.
          if (r.action?.tool && !missed) {
            Promise.resolve()
              .then(() => api.runtime.callTool(r.action.tool, r.action.params || {}))
              .then((out) => say(String(out?.text || out?.content?.[0]?.text || '').slice(0, 300) || `Done: ${r.text}.`))
              .catch((err) => say(`I couldn't run ${r.action.tool}: ${err.message}`));
            return;
          }
          const what = r.kind === 'timer' ? `Timer done: ${r.text}.` : `Reminder: ${r.text}`;
          say(missed ? `Missed ${r.kind === 'timer' ? 'timer' : 'reminder'}: ${r.text} (it was due ${describeTime(new Date(r.at), new Date())}).` : what);
        },
      });
      api.registerService({ start: () => scheduler.start(), stop: () => scheduler.stop() });

      const upcoming = () => store.list().map((r) => ({ id: r.id, text: r.text, when: describeTime(new Date(r.at), new Date()), repeat: r.repeat || null, kind: r.kind || 'reminder' }));
      const matching = (query) => {
        const q = String(query || '').trim().toLowerCase();
        return store.list().filter((r) => r.id === query || (q && r.text.toLowerCase().includes(q)));
      };

      api.registerTool({
        name: 'reminder_add',
        description: 'Set a reminder. Pass the time exactly as the user said it (e.g. "in 10 minutes", "at 6 pm", "tomorrow at 9", "Monday at 5"); do not convert it to a date yourself.',
        parameters: obj({
          text: str('What to remind the user about'),
          when: str("The user's own words for the time (for \"every 2 hours\" rules, the start, e.g. \"now\" or \"at 9 am\")"),
          repeat: str('How often, in the user\'s words: "every day", "every weekday", "every Monday and Thursday", "every 2 hours"; omit for one-off'),
          action_tool: str('Optional: a look-up tool to run and speak each time, e.g. "weather_get" for "tell me the weather"'),
          action_params: { type: 'object', description: 'Optional parameters for action_tool' },
        }, ['text', 'when']),
        async execute(_id, { text: what, when, repeat, action_tool: actionTool, action_params: actionParams }) {
          const now = new Date();
          const rep = parseRepeat(repeat);
          let parsed = parseWhen(when, now);
          // "every 2 hours" with no clear start: the first one is n hours from now.
          if (!parsed && rep?.startsWith('hourly:')) parsed = { at: new Date(now.getTime() + Number(rep.split(':')[1]) * 3_600_000), rolled: false };
          if (!parsed) throw new Error(`I couldn't understand the time "${when}". Try "in 10 minutes", "at 6 pm" or "tomorrow at 9".`);
          if (rep) parsed = { ...parsed, at: alignToRepeat(parsed.at, rep) };
          const action = actionTool ? { tool: String(actionTool), params: actionParams && typeof actionParams === 'object' ? actionParams : {} } : null;
          const reminder = store.add({ text: what, at: parsed.at, repeat: rep, action });
          scheduler.add(reminder);
          const every = rep ? `, ${describeRepeat(rep)}` : '';
          const note = parsed.rolled ? ' (That time had already passed today, so I set the next one.)' : '';
          return text(`Okay, ${describeTime(parsed.at, now)}${every}: ${what}.${note}`, { id: reminder.id, at: reminder.at, repeat: rep });
        },
      });

      api.registerTool({
        name: 'timer_set',
        description: 'Start a countdown timer for a number of minutes, optionally with a label.',
        parameters: obj({ minutes: { type: 'number', description: 'Length in minutes (up to 1440)' }, label: str('Optional name, e.g. "study"') }, ['minutes']),
        async execute(_id, { minutes, label }) {
          const m = Number(minutes);
          if (!(m > 0 && m <= 1440)) throw new Error('Timers can be from a few seconds up to 24 hours.');
          const name = String(label || '').trim() || plural(m, 'minute');
          const reminder = store.add({ text: name, at: new Date(Date.now() + m * 60_000) });
          store.update(reminder.id, { kind: 'timer' });
          scheduler.add(reminder);
          return text(`Timer set for ${plural(m, 'minute')}${label ? `: ${name}` : ''}.`, { id: reminder.id, at: reminder.at });
        },
      });

      api.registerTool({
        name: 'reminder_list',
        description: 'List upcoming reminders and timers, soonest first.',
        parameters: obj(),
        async execute() {
          const items = upcoming();
          const summary = items.length
            ? `You have ${plural(items.length, 'reminder')}: ${items.map((i) => `${i.when}: ${i.text}${i.repeat ? ` (${describeRepeat(i.repeat)})` : ''}`).join('; ')}.`
            : 'You have no reminders.';
          return text(summary, { items });
        },
      });

      api.registerTool({
        name: 'reminder_cancel',
        description: 'Cancel a reminder or timer by a word from it (e.g. "oven"), or all of them with all=true.',
        parameters: obj({ match: str('A word or phrase from the reminder, or its id'), all: { type: 'boolean', description: 'Cancel every reminder and timer' } }),
        async execute(_id, { match, all }) {
          if (all) {
            const n = store.list().length;
            for (const r of store.list()) {
              scheduler.cancel(r.id);
              store.remove(r.id);
            }
            return text(`Cancelled ${plural(n, 'reminder')}.`, { cancelled: n });
          }
          const found = matching(match);
          if (!found.length) throw new Error(`There's no reminder matching "${match}".`);
          if (found.length > 1) {
            return text(`Which one: ${found.map((r) => r.text).join(' or ')}?`, { ask: found.map((r) => ({ id: r.id, text: r.text, when: describeTime(new Date(r.at), new Date()) })) });
          }
          scheduler.cancel(found[0].id);
          store.remove(found[0].id);
          return text(`Cancelled: ${found[0].text}.`, { cancelled: found[0].id });
        },
      });

      // Only wiping everything needs a yes.
      api.on('before_tool_call', ({ toolName, params }) => {
        if (toolName !== 'reminder_cancel' || !params.all) return undefined;
        return { requireApproval: { title: 'Cancel all reminders', description: plural(store.list().length, 'reminder'), severity: 'warning' } };
      });
    },
  });
}

export default createRemindersPlugin();
