// Remembers the latest warnings and errors (shown in Settings → System) while still printing them.
import { format } from 'node:util';

export function createLogBuffer({ limit = 50 } = {}) {
  const entries = [];
  return {
    capture(target = console) {
      for (const level of ['warn', 'error']) {
        const original = target[level].bind(target);
        target[level] = (...args) => {
          entries.push({ at: new Date().toISOString(), level, text: format(...args).slice(0, 2000) });
          if (entries.length > limit) entries.splice(0, entries.length - limit);
          original(...args);
        };
      }
    },
    recent: () => entries.slice(),
  };
}
