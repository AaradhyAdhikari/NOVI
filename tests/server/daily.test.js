import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { everyDayAt } from '../../server/daily.js';

const setup = (startIso) => {
  let t = new Date(startIso);
  const runs = [];
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-daily-')), 'job.json');
  const job = everyDayAt({ time: '23:50', run: async (day) => { runs.push(day); }, stateFile, now: () => t });
  return { job, runs, stateFile, at: (iso) => { t = new Date(iso); } };
};

describe('everyDayAt', () => {
  it('runs once at the time, for that day', async () => {
    const { job, runs, at } = setup('2026-10-08T23:40:00');
    await job.tick();
    expect(runs).toEqual([]);
    at('2026-10-08T23:51:00');
    await job.tick();
    await job.tick();
    expect(runs).toEqual(['2026-10-08']);
  });

  it('after a missed night, runs once for yesterday (catch-up) and then today at its time', async () => {
    const { job, runs, at, stateFile } = setup('2026-10-08T23:51:00');
    await job.tick(); // ran for the 8th
    at('2026-10-10T09:00:00'); // laptop slept through the 9th's run
    await job.tick();
    await job.tick();
    expect(runs).toEqual(['2026-10-08', '2026-10-09']);
    at('2026-10-10T23:55:00');
    await job.tick();
    expect(runs).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastDay).toBe('2026-10-10');
  });

  it('first ever start before the time does nothing; a failed run is retried on the next tick', async () => {
    let fail = true;
    const runs = [];
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-daily-')), 'job.json');
    let t = new Date('2026-10-08T23:51:00');
    const job = everyDayAt({ time: '23:50', run: async (day) => { if (fail) throw new Error('offline'); runs.push(day); }, stateFile, now: () => t, logger: { warn() {} } });
    await job.tick();
    fail = false;
    await job.tick();
    expect(runs).toEqual(['2026-10-08']);
  });
});
