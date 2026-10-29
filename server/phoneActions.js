// One step for the phone (plugins/phone-control → the Novi app's Accessibility service): send
// { type: 'phone_action', id, … } to the phone's connection and wait for its
// { type: 'phone_action_result', id, ok, note }.
import crypto from 'node:crypto';

export function createPhoneActions({ send, timeoutMs = 15000 }) {
  const waiting = new Map();
  return {
    request(deviceId, action) {
      const id = crypto.randomUUID();
      return new Promise((resolve) => {
        const reached = send(deviceId, { type: 'phone_action', id, ...action });
        if (!reached) return resolve({ ok: false, note: "Your phone isn't connected to Novi. Open the Novi app on it." });
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve({ ok: false, note: "The phone didn't answer. Is Novi's typing switched on in the phone's Accessibility settings?" });
        }, timeoutMs);
        waiting.set(id, (out) => { clearTimeout(timer); waiting.delete(id); resolve(out); });
      });
    },
    settle(msg) {
      const done = waiting.get(msg?.id);
      if (done) done({ ok: Boolean(msg.ok), note: String(msg.note || '') });
      return Boolean(done);
    },
  };
}
