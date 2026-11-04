import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createClaudeLinkPlugin } from '../../plugins/claude-link/index.js';
import { hookBody } from '../../tools/claude-hook.mjs';

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-hook-'));
  const asked = [];
  const said = [];
  const runtime = {
    dataDir,
    ask: async (card) => { asked.push(card); return { allow: true }; },
    say: (text) => said.push(text),
    projects: { list: () => [] },
  };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, info() {} } });
  expect(host.register(createClaudeLinkPlugin())).toBe(true);
  const token = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-hook.json'), 'utf8')).token;
  const post = (body, t = token()) => host.route('claude-hook')(body, { headers: { 'x-novi-hook': t } });
  return { asked, said, post, token };
}
const PERMISSION = { hook_event_name: 'PermissionRequest', session_id: 's', cwd: 'C:\\dev\\NOVI', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run the tests' } };

describe('Claude Code reaching Novi', () => {
  it('a permission prompt becomes a card and comes back as Claude needs it', async () => {
    const s = setup();
    const out = await s.post(PERMISSION);
    expect(s.asked.length).toBe(1);
    expect(out.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });

  it('nothing happens without the secret, so no local program can approve', async () => {
    const s = setup();
    await s.post(PERMISSION).catch(() => {});
    s.asked.length = 0;
    expect(await s.post(PERMISSION, 'wrong')).toEqual({});
    expect(await s.post(PERMISSION, '')).toEqual({});
    expect(s.asked).toEqual([]);
  });

  it('keeps one secret across restarts of the handler', () => {
    const s = setup();
    expect(s.token()).toMatch(/^[0-9a-f]{32,}$/);
  });
});

describe('what the hook script sends', () => {
  it('leaves big file contents out of the card request, keeps what the card needs', () => {
    const body = hookBody({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(50000) } }, {});
    expect(body.tool_input.file_path).toBe('a.js');
    expect(body.tool_input.content.length).toBeLessThan(500);
  });
  it('keeps a whole plan and whole questions', () => {
    const plan = 'p'.repeat(5000);
    expect(hookBody({ tool_name: 'ExitPlanMode', tool_input: { plan } }, {}).tool_input.plan).toBe(plan);
  });
  it('marks Novi\'s own Claude runs, which already ask through Novi', () => {
    expect(hookBody({ tool_name: 'Bash' }, { NOVI_TASK: '1' }).novi_task).toBe(true);
    expect(hookBody({ tool_name: 'Bash' }, {}).novi_task).toBeUndefined();
  });
});

describe('a card read out quickly', () => {
  it('says the project and the job, not a whole sentence about Claude', async () => {
    const s = setup();
    await s.post(PERMISSION);
    expect(s.asked[0].prompt).toBe('NOVI: run the tests.');
  });
});
