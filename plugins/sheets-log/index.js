import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { everyDayAt } from '../../server/daily.js';

// One Google Sheet, "Novi log", that fills itself: GitHub commits per day (nightly), study hours
// the user logs by voice, and Novi's daily counts (nightly, numbers only — never what was said).
// Uses the drive.file permission: Novi only touches the sheet it created.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const TABS = { GitHub: ['Date', 'Repository', 'Commits'], Study: ['Date', 'Topic', 'Hours'], Novi: ['Date', 'Questions', 'Coding tasks done', 'Coding tasks failed'] };
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// onJobs(jobs): hands the nightly jobs out (tests run them directly).
export function createSheetsLogPlugin({ now = () => new Date(), onJobs = () => {} } = {}) {
  return definePluginEntry({
    id: 'sheets-log',
    name: 'Novi log (Google Sheets)',
    description: 'A "Novi log" Google Sheet: GitHub commits, study hours, Novi stats.',
    register(api) {
      const dataDir = api.runtime.dataDir || path.resolve('data');
      const stateFile = path.join(dataDir, 'sheets-log.json');
      const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
      const write = (s) => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); };

      function account() {
        const google = api.runtime.google;
        if (!google?.configured) throw new Error("Google isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to Novi's .env.");
        const r = google.resolve();
        if (r.error) throw new Error(`${r.error} (connect Google in Settings for the Novi log).`);
        if (!r.account) throw new Error('Choose a default Google account in Settings for the Novi log.');
        if (!(r.account.scopes || []).includes(DRIVE_SCOPE)) throw new Error('The Novi log needs the Drive files permission: reconnect Google in Settings and tick it.');
        return r.account;
      }

      // The sheet, created once (with a header row per tab).
      async function sheet() {
        const acc = account();
        const known = read();
        if (known.id) return { acc, ...known };
        const created = await api.runtime.google.call(acc, SHEETS, {
          method: 'POST',
          body: JSON.stringify({ properties: { title: 'Novi log' }, sheets: Object.keys(TABS).map((title) => ({ properties: { title } })) }),
        });
        const info = { id: created.spreadsheetId, url: created.spreadsheetUrl };
        write(info);
        for (const [tab, header] of Object.entries(TABS)) await append(acc, info.id, tab, [header]);
        return { acc, ...info };
      }

      const append = (acc, id, tab, rows) => api.runtime.google.call(acc, `${SHEETS}/${id}/values/${tab}!A1:append?valueInputOption=USER_ENTERED`, { method: 'POST', body: JSON.stringify({ values: rows }) });
      async function addRows(tab, rows) {
        const { acc, id } = await sheet();
        await append(acc, id, tab, rows);
      }

      // Nightly rows. day = 'YYYY-MM-DD' (a missed night writes that night's date).
      const jobs = {
        async github(day) {
          const { commits = [] } = await api.runtime.callTool('github_activity', { date: day });
          await addRows('GitHub', commits.length ? commits.map((c) => [day, c.repo, c.count]) : [[day, 'none', 0]]);
        },
        async novi(day) {
          let questions = 0;
          try {
            questions = fs.readFileSync(path.join(dataDir, 'long-term-memory', 'conversations', `${day}.jsonl`), 'utf8').split('\n').filter((l) => l.trim()).length;
          } catch { /* no conversations that day */ }
          const tasks = (api.runtime.memory?.listTasks?.() || []).filter((t) => String(t.startedAt || '').startsWith(day));
          await addRows('Novi', [[day, questions, tasks.filter((t) => t.status === 'done').length, tasks.filter((t) => t.status === 'failed').length]]);
        },
      };
      onJobs(jobs);

      const nightly = [
        everyDayAt({ time: '23:50', run: jobs.github, now, stateFile: path.join(dataDir, 'sheets-log', 'github-daily.json'), logger: api.logger || console }),
        everyDayAt({ time: '23:55', run: jobs.novi, now, stateFile: path.join(dataDir, 'sheets-log', 'novi-daily.json'), logger: api.logger || console }),
      ];
      api.registerService({ start: () => nightly.forEach((j) => j.start()), stop: () => nightly.forEach((j) => j.stop()) });

      api.registerTool({
        name: 'study_log',
        description: 'Log study or work time to the "Novi log" Google Sheet, e.g. "log 2 hours of DSA", "I studied OS for 45 minutes".',
        parameters: { type: 'object', properties: { topic: { type: 'string' }, hours: { type: 'number' }, minutes: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD, default today' } }, required: ['topic'] },
        async execute(_id, { topic, hours, minutes, date }) {
          const h = Math.round(((Number(hours) || 0) + (Number(minutes) || 0) / 60) * 100) / 100;
          if (!(h > 0 && h <= 24)) throw new Error('How long? Say it in hours or minutes, e.g. "2 hours" or "45 minutes".');
          const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : dayOf(now());
          await addRows('Study', [[day, String(topic).trim().slice(0, 80), h]]);
          return reply(`Logged ${h} hours of ${topic} for ${day}.`, { day, hours: h });
        },
      });

      api.registerTool({
        name: 'sheets_log_link',
        description: 'The link to the "Novi log" Google Sheet (shown on screen).',
        parameters: { type: 'object', properties: {} },
        async execute() {
          const { url } = await sheet();
          return reply(`Your Novi log: ${url}`, { url });
        },
      });
    },
  });
}

export default createSheetsLogPlugin();
