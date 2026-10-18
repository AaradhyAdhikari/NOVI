// What Novi is doing on the laptop, for the desktop orb (2026-10-18): 'listening' (after "Hey Novi"
// or a tap), 'thinking', 'speaking' (laptop speakers, or a laptop page reading a line — estimated
// from its length), 'quiet' (quiet mode, nothing else going on) or 'idle'. Fed with the messages
// Novi sends to the laptop.
export function createLaptopState({ setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout, baseMs = 1500, msPerChar = 70 } = {}) {
  let listening = false;
  let thinking = false;
  let quiet = false;
  let voices = 0; // laptop speakers talking right now
  let reading = null; // timer while a laptop page reads a line aloud
  let state = 'idle';
  const subs = new Set();
  const compute = () => (voices > 0 || reading ? 'speaking' : thinking ? 'thinking' : listening ? 'listening' : quiet ? 'quiet' : 'idle');
  const update = () => {
    const next = compute();
    if (next === state) return;
    state = next;
    for (const fn of subs) { try { fn(state); } catch { /* one bad listener must not stop the others */ } }
  };
  return {
    get: () => state,
    on(fn) { subs.add(fn); fn(state); return () => subs.delete(fn); },
    feed(msg = {}) {
      if (msg.type === 'wake') listening = true;
      else if (msg.type === 'wake_timeout') listening = false;
      else if (msg.type === 'thinking') { thinking = Boolean(msg.on); listening = false; }
      else if (msg.type === 'quiet') quiet = Boolean(msg.on);
      else if (msg.type === 'speak' && msg.text) {
        listening = false;
        cancel(reading);
        reading = later(() => { reading = null; update(); }, baseMs + msPerChar * String(msg.text).length);
      } else if (msg.type === 'stop_speaking') { cancel(reading); reading = null; }
      else return;
      update();
    },
    speaking(on) { voices = Math.max(0, voices + (on ? 1 : -1)); update(); },
  };
}
