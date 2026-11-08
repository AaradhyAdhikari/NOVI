import os from 'node:os';

// The Windows logon task starts Novi at below-normal priority (Task Scheduler's default), and every Edge
// it starts inherits that: the remote-control video took 16 s inside Novi, 3 s from a plain script
// (2026-11-08). A voice companion shouldn't wait behind everything else, so it goes up to normal.
// Never higher, never an error: the worst case leaves it as it was.
export function normalPriority(pid = 0, { get = os.getPriority, set = os.setPriority } = {}) {
  try {
    if (get(pid) <= 0) return 'normal'; // already normal or higher (lower number = higher priority)
    set(pid, 0);
    return 'raised';
  } catch {
    return 'left';
  }
}
