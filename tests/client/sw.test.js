import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// public/sw.js in a fake service worker (user, 2026-10-28: every card pops up on the phone with
// buttons that answer it; a card that needs the PIN opens Novi on it).
function load({ windows = [], answer = { done: true }, token = 'tok123' } = {}) {
  const handlers = {};
  const shown = [];
  const fetched = [];
  const opened = [];
  const ctx = {
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      registration: { showNotification: async (title, opts) => { shown.push({ title, ...opts }); } },
      clients: { matchAll: async () => windows, openWindow: async (url) => { opened.push(url); } },
    },
    caches: { open: async () => ({ match: async () => (token ? { text: async () => token } : undefined) }) },
    fetch: async (url, init) => { fetched.push({ url, init }); return { json: async () => answer }; },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), ctx);
  const fire = async (type, event) => {
    let done;
    handlers[type]({ ...event, waitUntil: (p) => { done = p; } });
    await done;
  };
  return { fire, shown, fetched, opened };
}
const card = { type: 'card', id: 'a1', title: 'Claude wants to run: npm test', body: 'Tap to open Novi.', tag: 'card-a1', url: '/?card=a1', actions: [{ action: 'approve', title: 'Approve' }, { action: 'deny', title: 'Deny' }] };
const push = (data) => ({ data: { json: () => data } });

describe('phone notifications (service worker)', () => {
  it('a card shows with its buttons and stays until answered', async () => {
    const s = load();
    await s.fire('push', push(card));
    expect(s.shown[0]).toMatchObject({ title: 'Claude wants to run: npm test', body: 'Tap to open Novi.', tag: 'card-a1', requireInteraction: true, actions: card.actions, data: { url: '/?card=a1', cardId: 'a1' } });
  });

  it('not shown while Novi is on screen (the card is already there)', async () => {
    const s = load({ windows: [{ visibilityState: 'visible', focused: true }] });
    await s.fire('push', push(card));
    expect(s.shown).toEqual([]);
  });

  it('a button answers the card with the phone\'s own token; done = nothing opens', async () => {
    const s = load();
    await s.fire('notificationclick', { action: 'approve', notification: { close() {}, data: { url: '/?card=a1', cardId: 'a1' } } });
    expect(s.fetched).toHaveLength(1);
    expect(s.fetched[0].url).toBe('/api/card-answer');
    expect(JSON.parse(s.fetched[0].init.body)).toEqual({ id: 'a1', action: 'approve' });
    expect(s.fetched[0].init.headers.Authorization).toBe('Bearer tok123');
    expect(s.opened).toEqual([]);
  });

  it('a card that needs the PIN, or a tap on the notification itself, opens Novi on the card', async () => {
    const pin = load({ answer: { done: false, need: 'pin' } });
    await pin.fire('notificationclick', { action: 'approve', notification: { close() {}, data: { url: '/?card=a1', cardId: 'a1' } } });
    expect(pin.opened).toEqual(['/?card=a1']);
    const tap = load();
    await tap.fire('notificationclick', { action: '', notification: { close() {}, data: { url: '/?card=a1', cardId: 'a1' } } });
    expect(tap.fetched).toEqual([]);
    expect(tap.opened).toEqual(['/?card=a1']);
  });
});

describe('the test popup', () => {
  it('shows even while Novi is on screen', async () => {
    const s = load({ windows: [{ visibilityState: 'visible', focused: true }] });
    await s.fire('push', push({ ...card, id: 'test-1', tag: 'card-test-1', title: 'Novi test popup', actions: [], always: true }));
    expect(s.shown[0]).toMatchObject({ title: 'Novi test popup' });
  });
});
