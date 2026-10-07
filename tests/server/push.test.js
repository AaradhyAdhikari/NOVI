import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPush } from '../../server/push.js';

const sub = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/abc${n}`, keys: { p256dh: 'pk', auth: 'au' } });

function fakeLib({ status = 201 } = {}) {
  const sent = [];
  let generated = 0;
  return {
    sent,
    generated: () => generated,
    generateVAPIDKeys: () => { generated += 1; return { publicKey: `PUB${generated}`, privateKey: `PRIV${generated}` }; },
    sendNotification: async (s, payload, opts) => {
      sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), opts });
      if (status >= 400) throw Object.assign(new Error('gone'), { statusCode: status });
    },
  };
}

const make = (lib = fakeLib()) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-push-'));
  return { dir, lib, push: createPush({ dir, lib, logger: { warn() {} } }) };
};

describe('push', () => {
  it('creates its keys once and keeps them', () => {
    const { dir, lib, push } = make();
    expect(push.publicKey).toBe('PUB1');
    expect(createPush({ dir, lib, logger: { warn() {} } }).publicKey).toBe('PUB1');
    expect(lib.generated()).toBe(1);
  });

  it('only accepts real https push subscriptions', () => {
    const { push } = make();
    expect(() => push.subscribe('d1', { endpoint: 'http://evil.example/x', keys: { p256dh: 'a', auth: 'b' } })).toThrow();
    expect(() => push.subscribe('d1', { endpoint: 'https://fcm.googleapis.com/x' })).toThrow();
    expect(push.subscribe('d1', sub())).toBe(true);
  });

  it('sends a fixed, private-free notification for each kind', async () => {
    const { push, lib } = make();
    push.subscribe('d1', sub());
    await push.send('d1', { kind: 'reminder', text: 'Call mom about the bank PIN' });
    expect(lib.sent).toHaveLength(1);
    expect(lib.sent[0].payload).toEqual({ title: 'Novi', body: 'Reminder', tag: 'reminder', url: '/' });
    expect(lib.sent[0].opts.vapidDetails).toMatchObject({ publicKey: 'PUB1', privateKey: 'PRIV1' });
    await push.send('d1', { kind: 'task_done' });
    expect(lib.sent[1].payload.body).toBe('Task finished');
  });

  it('ignores unknown kinds and devices without a subscription', async () => {
    const { push, lib } = make();
    push.subscribe('d1', sub());
    await push.send('d1', { kind: 'gossip' });
    await push.send('d2', { kind: 'task_done' });
    expect(lib.sent).toEqual([]);
  });

  it('forgets a subscription the push service says is gone', async () => {
    const lib = fakeLib({ status: 410 });
    const { push } = make(lib);
    push.subscribe('d1', sub());
    await push.send('d1', { kind: 'approval' });
    await push.send('d1', { kind: 'approval' });
    expect(lib.sent).toHaveLength(1);
  });

  it('removing a device removes its subscriptions', async () => {
    const { push, lib } = make();
    push.subscribe('d1', sub(1));
    push.subscribe('d1', sub(2));
    push.removeDevice('d1');
    await push.send('d1', { kind: 'approval' });
    expect(lib.sent).toEqual([]);
  });
});
