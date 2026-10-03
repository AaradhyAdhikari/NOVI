// Mirrors OpenClaw's `definePluginEntry` (openclaw/plugin-sdk/plugin-entry) so Novi plugins port unchanged.
export function definePluginEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('definePluginEntry needs an object');
  for (const key of ['id', 'name']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) throw new Error(`definePluginEntry needs a string "${key}"`);
  }
  if (typeof entry.register !== 'function') throw new Error('definePluginEntry needs a register(api) function');
  return Object.freeze({ description: '', ...entry });
}

// OpenClaw approval severities → Novi tiers.
export const SEVERITY_TIER = Object.freeze({ info: 'low', warning: 'medium', critical: 'high' });
