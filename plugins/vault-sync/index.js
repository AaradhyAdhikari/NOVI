import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { syncOnce } from './sync.js';

// Two brains (user, 2026-11-05). Claude Brain holds Claude, its sessions and the laptop; Novi Brain holds all
// of that plus Novi. Every few minutes this writes session and project notes into Claude Brain's Sessions and
// Laptop folders, then copies Claude Brain into Novi Brain. The flow is one way: nothing of Novi's goes back.
const EVERY_MS = 5 * 60_000;

export function createVaultSyncPlugin({ everyMs = EVERY_MS } = {}) {
  return definePluginEntry({
    id: 'vault-sync',
    name: 'Two brains',
    description: 'Keeps Claude Brain filled with sessions and projects, and copies it into Novi Brain.',
    register(api) {
      const rt = api.runtime || {};
      const file = path.join(rt.dataDir || '.', 'vault-sync.json');
      let state = {};
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
      let timer = null;
      let running = false;

      async function run() {
        const brain = api.pluginConfig.brain;
        if (running || !brain || !rt.vaultDir || !fs.existsSync(brain)) return;
        running = true;
        try {
          const out = await syncOnce({ brain, novi: rt.vaultDir, projects: rt.projects?.list?.() || [], state });
          await fs.promises.writeFile(file, JSON.stringify(state));
          if (out.notes || out.copied || out.removed) api.logger?.info?.(`[vault-sync] ${out.notes} notes, ${out.copied} copied, ${out.removed} removed`);
        } catch (err) {
          api.logger?.warn?.(`[vault-sync] ${err.message}`);
        } finally {
          running = false;
        }
      }

      api.registerService({
        id: 'vault-sync',
        start() {
          setTimeout(run, 60_000).unref?.();
          timer = setInterval(run, everyMs);
          timer.unref?.();
        },
        stop() { clearInterval(timer); },
      });
    },
  });
}

export default createVaultSyncPlugin();
