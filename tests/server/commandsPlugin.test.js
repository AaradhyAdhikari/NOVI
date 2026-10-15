import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createCommandsPlugin } from '../../plugins/commands/index.js';
import { createHistory } from '../../plugins/commands/history.js';

function setup({ results = [], platform = 'win32' } = {}) {
  const runs = [];
  const runner = { run: async (a) => { runs.push(a); const r = results.shift(); if (r instanceof Error) throw r; return r || { ok: true, exitCode: 0, output: '' }; } };
  const history = createHistory({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-cmd-')), 'h.jsonl') });
  const host = new PluginHost({ logger: { warn() {} } });
  expect(host.register(createCommandsPlugin({ runner, history, platform }))).toBe(true);
  const tool = host.get('laptop_run');
  return { host, tool, runs, history };
}
const PHONE = { from: { deviceId: 'p1' } };

describe('laptop_run: look-only commands run at once', () => {
  it('runs with the parser check, passes the output to the AI, keeps it private, and logs it', async () => {
    const { tool, runs, history } = setup({ results: [{ ok: true, exitCode: 0, output: 'D  120 GB free' }] });
    const args = { command: 'Get-PSDrive D', purpose: 'Check free space on D:' };
    expect(await tool.gate(args)).toEqual({});
    const out = await tool.run(args);
    expect(runs).toEqual([{ command: 'Get-PSDrive D', look: true }]);
    expect(out).toMatchObject({ level: 'look', ok: true, output: 'D  120 GB free', sensitive: true });
    expect(history.list()[0]).toMatchObject({ level: 'look', ran: true, ok: true, from: 'laptop', purpose: 'Check free space on D:' });
  });

  it('empty output says Done.; output is never longer than 4,000 characters', async () => {
    const { tool } = setup({ results: [{ ok: true, exitCode: 0, output: '' }, { ok: true, exitCode: 0, output: 'y'.repeat(9000) }] });
    expect((await tool.run({ command: 'Get-Date', purpose: 'Time' })).note).toBe('Done.');
    expect((await tool.run({ command: 'Get-Date', purpose: 'Time' })).output.length).toBeLessThanOrEqual(4010);
  });

  it('a "look" the PowerShell parser rejects is asked as a change next time', async () => {
    const { tool, runs } = setup({ results: [{ ok: false, notLook: true, exitCode: 3, output: '' }] });
    const args = { command: 'Get-Thing | Sneaky-Write', purpose: 'Do a thing' };
    // classify says change for unknown commands, so use a command the JS check thinks is look:
    const looky = { command: 'Get-ChildItem C:\\x', purpose: 'List x' };
    const out = await tool.run(looky);
    expect(out).toMatchObject({ needsApproval: true, error: "That command does more than look, so I'll ask first." });
    expect((await tool.gate(looky)).approval).toMatchObject({ title: 'List x?' });
    expect(runs).toEqual([{ command: 'Get-ChildItem C:\\x', look: true }]);
    expect((await tool.gate(args)).approval).toBeTruthy();
  });
});

describe('laptop_run: changes ask, dangerous needs the PIN, never is refused', () => {
  it('change: the purpose is the question, the command is on the card, never "always allow"', async () => {
    const { tool } = setup();
    const gate = await tool.gate({ command: "gci *.jpeg | Rename-Item -NewName { $_.Name -replace '.jpeg','.jpg' }", purpose: 'Rename the .jpeg files to .jpg.' });
    expect(gate.approval).toMatchObject({ title: 'Rename the .jpeg files to .jpg?', detail: "gci *.jpeg | Rename-Item -NewName { $_.Name -replace '.jpeg','.jpg' }", tier: 'medium', category: 'commands', grantable: false });
    expect(gate.approval.pin).toBeUndefined();
  });

  it('danger: asks with pin: true', async () => {
    const { tool } = setup();
    const gate = await tool.gate({ command: 'Remove-Item $HOME\\Downloads\\temp -Recurse', purpose: 'Delete the temp folder in Downloads' });
    expect(gate.approval).toMatchObject({ title: 'Delete the temp folder in Downloads?', pin: true, grantable: false });
  });

  it('never: blocked with the reason and the command, and logged as not run', async () => {
    const { tool, history } = setup();
    const gate = await tool.gate({ command: 'Set-MpPreference -DisableRealtimeMonitoring $true', purpose: 'Turn off Defender' }, PHONE);
    expect(gate.block).toBe(true);
    expect(gate.blockReason).toBe("I won't run that: it would turn off your antivirus. Here's the command if you want to run it yourself: Set-MpPreference -DisableRealtimeMonitoring $true");
    expect(history.list()[0]).toMatchObject({ level: 'never', ran: false, from: 'phone' });
  });

  it('a change that was allowed runs without the parser check; a phone request is logged as phone', async () => {
    const { tool, runs, history } = setup();
    const args = { command: 'Stop-Process -Name notepad', purpose: 'Close Notepad' };
    await tool.gate(args, PHONE);
    await tool.run(args);
    expect(runs).toEqual([{ command: 'Stop-Process -Name notepad', look: false }]);
    expect(history.list()[0]).toMatchObject({ level: 'change', from: 'phone', ran: true });
  });

  it('a declined command is logged as not run', async () => {
    const { host, tool, history } = setup();
    const args = { command: 'Stop-Process -Name notepad', purpose: 'Close Notepad' };
    await tool.gate(args);
    await host.afterToolCall({ toolName: 'laptop_run', params: args, result: { error: 'The user declined this action.' }, error: 'The user declined this action.' });
    expect(history.list()[0]).toMatchObject({ purpose: 'Close Notepad', ran: false, level: 'change' });
  });
});

describe('laptop_run: honest failures', () => {
  it('error, timeout, not Windows', async () => {
    const { tool } = setup({ results: [{ ok: false, exitCode: 1, output: 'Access is denied.\nAt line:1' }, { ok: false, timedOut: true, output: '' }, new Error('not-windows')] });
    const a = { command: 'Stop-Process -Name x', purpose: 'Close x' };
    expect((await tool.run(a)).note).toBe("That didn't work: Access is denied.");
    expect((await tool.run(a)).note).toBe('That took too long, so I stopped it.');
    expect((await tool.run(a)).error).toBe('Commands work only on Windows.');
  });
});

describe('commands_history', () => {
  it('lists today\'s commands with a short summary (private)', async () => {
    const { host, tool } = setup({ results: [{ ok: true, exitCode: 0, output: 'x' }] });
    await tool.run({ command: 'Get-PSDrive D', purpose: 'Checked free space on D:' });
    const out = await host.get('commands_history').run({ today: true });
    expect(out.note).toBe('1 today. Last: checked free space on D:.');
    expect(out.entries).toHaveLength(1);
    expect(out.sensitive).toBe(true);
  });
});
