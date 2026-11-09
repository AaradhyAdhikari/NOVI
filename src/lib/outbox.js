// Messages typed while Novi isn't connected (a restart, a bad signal): they wait on the device and go out
// by themselves when Novi is back (live 2026-11-10: one vanished without a word). At most 10, each for 10 min.
const MAX = 10;
const MAX_AGE = 10 * 60_000;
export const queue = (box, msg, now = Date.now()) => [...box, { msg, at: now }].slice(-MAX);
export const due = (box, now = Date.now()) => box.filter((x) => now - x.at < MAX_AGE).map((x) => x.msg);
