import { describe, it, expect } from 'vitest';
import { startFreezeWatch, whatRan, freezeLine } from '../../server/freezeWatch.js';

describe('what ran during a freeze', () => {
  const frame = (id, functionName, url, children = []) => ({ id, callFrame: { functionName, url }, children });
  const profile = {
    nodes: [frame(1, '(root)', ''), frame(2, 'send', 'file:///C:/dev/NOVI/plugins/commit/index.js', [3]), frame(3, 'readFileSync', 'node:fs'), frame(4, '(idle)', '')],
    samples: [3, 3, 4, 2],
    timeDeltas: [2e6, 1e6, 9e6, 1e5],
  };

  it('names the function of ours, longest first, and leaves out idle time', () => {
    expect(whatRan(profile)).toEqual(['send plugins/commit/index.js 3.1s']);
  });
  it('an empty profile names nothing', () => {
    expect(whatRan(null)).toEqual([]);
  });
});

describe('the log line', () => {
  it('says what ran', () => {
    expect(freezeLine({ at: '22:10:01', ms: 12400, ran: ['send plugins/commit/index.js 3.1s'], stalledMs: 0, freeGb: '1.8' }))
      .toBe('[freeze] 22:10:01: 12.4 s. send plugins/commit/index.js 3.1s. Free memory 1.8 GB.');
  });
  it('says when the whole laptop stopped too', () => {
    expect(freezeLine({ at: '22:10:01', ms: 20000, ran: [], stalledMs: 19000, freeGb: '0.4' })).toMatch(/no JavaScript ran.*whole process or laptop stopped\. Free memory 0\.4 GB/);
  });
});

describe('catching a freeze', () => {
  it('a blocked main thread is logged with the function that blocked it', async () => {
    const lines = [];
    const watch = startFreezeWatch({ afterMs: 300, beatMs: 20, logger: { warn: (l) => lines.push(l) } });
    await new Promise((r) => setTimeout(r, 400)); // the watcher thread is up
    function holdsTheThread() { const until = Date.now() + 1200; while (Date.now() < until); }
    holdsTheThread();
    for (let i = 0; i < 40 && !lines.length; i++) await new Promise((r) => setTimeout(r, 100));
    await watch.stop();
    expect(lines[0]).toMatch(/^\[freeze\] .*: \d+\.\d s\./);
    // Caught in the act, not after it ended. V8 inlines the small function, so the file is what's certain.
    expect(lines[0]).toMatch(/freezeWatch\.test\.js \d/);
  }, 15_000);

  it('stays quiet when nothing is blocked', async () => {
    const lines = [];
    const watch = startFreezeWatch({ afterMs: 300, beatMs: 20, logger: { warn: (l) => lines.push(l) } });
    await new Promise((r) => setTimeout(r, 700));
    await watch.stop();
    expect(lines).toEqual([]);
  });
});
