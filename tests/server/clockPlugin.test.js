import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';

describe('clock example plugin', () => {
  it('loads from plugins/ with both tools', async () => {
    const spoken = [];
    const h = new PluginHost({ runtime: { speak: (t) => spoken.push(t) }, logger: { warn() {} } });
    await h.loadDirectory(path.resolve('plugins'));
    expect(h.warnings).toEqual([]);
    expect(h.plugins.find((p) => p.id === 'clock').tools).toEqual(['clock_now', 'clock_announce']);
    const now = await h.get('clock_now').run({});
    expect(now.text.length).toBeGreaterThan(5);
    expect(now.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await h.get('clock_now').gate({})).toEqual({});
    expect(await h.get('clock_announce').gate({ message: 'Dinner is ready' })).toEqual({ approval: { title: 'Announce a message on all devices', detail: 'Dinner is ready', tier: 'medium' } });
    expect(await h.get('clock_announce').run({ message: 'Dinner is ready' })).toEqual({ announced: 'Dinner is ready', text: 'Announced.' });
    expect(spoken).toEqual(['Announcement: Dinner is ready']);
  });
});
