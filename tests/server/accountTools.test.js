import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addAccountTools } from '../../server/tools/accountTools.js';
import { ToolRegistry } from '../../server/tools/registry.js';
import { AccountRegistry } from '../../server/accounts/registry.js';
import { UserFacingError } from '../../server/errors.js';

function setup({ accounts: list = [['personal', 'p@gmail.com'], ['college', 'c@college.edu']], defaultLabel } = {}) {
  const accounts = new AccountRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-at-')), 'a.json'));
  for (const [label, email] of list) accounts.setLabel(accounts.add({ provider: 'google', email }).id, label);
  if (defaultLabel) accounts.setDefault('google', accounts.list().find((a) => a.label === defaultLabel).id);
  const calls = [];
  const gmail = {
    search: async (acc, opts) => { calls.push(['search', acc.label, opts]); return [{ id: `m-${acc.label}`, from: 'Sir', subject: 'Hi', date: 'd', snippet: 's', unread: true }]; },
    read: async (acc, id) => { calls.push(['read', acc.label, id]); return { id, from: 'Sir', subject: 'Hi', body: 'secret body' }; },
    send: async (acc, msg) => { calls.push(['send', acc.label, msg]); return { id: 's1' }; },
  };
  let finishConnect;
  const connected = [];
  const auth = { connect: async () => ({ url: 'https://accounts.google.com/x', done: new Promise((r) => { finishConnect = r; }) }) };
  const tools = addAccountTools(new ToolRegistry(), { accounts, auth, gmail, onConnected: (a) => connected.push(a) });
  return { tools, accounts, calls, connected, finishConnect: (a) => finishConnect(a) };
}

describe('account tools', () => {
  it('only sending needs approval', () => {
    const { tools } = setup();
    expect(tools.get('gmail_send').tier).toBe('medium');
    for (const n of ['accounts_list', 'accounts_set_default', 'accounts_rename', 'gmail_connect', 'gmail_search', 'gmail_read']) expect(tools.get(n).tier).toBe('low');
  });

  it('gmail_search asks which account when several are connected and none is default', async () => {
    const { tools, calls } = setup();
    const out = await tools.get('gmail_search').run({});
    expect(out.ask).toEqual([{ label: 'personal', email: 'p@gmail.com' }, { label: 'college', email: 'c@college.edu' }]);
    expect(out.note).toBe('Which account: personal (p@gmail.com) or college (c@college.edu)?');
    expect(calls).toEqual([]);
  });

  it('gmail_search uses the named account and marks results sensitive', async () => {
    const { tools, calls } = setup();
    const out = await tools.get('gmail_search').run({ account: 'college', query: 'is:unread' });
    expect(out.sensitive).toBe(true);
    expect(out.messages).toEqual([{ account: 'college', id: 'm-college', from: 'Sir', subject: 'Hi', date: 'd', snippet: 's', unread: true }]);
    expect(calls[0]).toEqual(['search', 'college', { query: 'is:unread', max: 10 }]);
  });

  it('gmail_search "all" searches every account; the default is used when set', async () => {
    const all = setup();
    const out = await all.tools.get('gmail_search').run({ account: 'all' });
    expect(out.messages.map((m) => m.account)).toEqual(['personal', 'college']);
    const def = setup({ defaultLabel: 'personal' });
    await def.tools.get('gmail_search').run({});
    expect(def.calls[0][1]).toBe('personal');
  });

  it('expired accounts ask to reconnect', async () => {
    const { tools, accounts } = setup({ accounts: [['personal', 'p@gmail.com']] });
    accounts.markExpired(accounts.list()[0].id);
    await expect(tools.get('gmail_search').run({})).rejects.toThrow(/reconnect/);
  });

  it('unknown account names are explained', async () => {
    const { tools } = setup();
    await expect(tools.get('gmail_read').run({ id: 'm1', account: 'work' })).rejects.toThrow(UserFacingError);
  });

  it('gmail_read returns the message as sensitive', async () => {
    const { tools } = setup({ defaultLabel: 'college' });
    expect(await tools.get('gmail_read').run({ id: 'm9' })).toEqual({ sensitive: true, account: 'college', message: { id: 'm9', from: 'Sir', subject: 'Hi', body: 'secret body' } });
  });

  it('gmail_send asks for the account before approval, then shows sender, recipient and full body', async () => {
    const { tools, calls } = setup();
    const send = tools.get('gmail_send');
    const args = { to: 'sir@c.edu', subject: 'Late', body: 'I will be 10 minutes late.' };
    expect((await send.precheck(args)).ask).toHaveLength(2);
    const chosen = { ...args, account: 'college' };
    expect(await send.precheck(chosen)).toBeNull();
    expect(send.describe(chosen)).toBe('Send from college (c@college.edu) to sir@c.edu: Late');
    expect(send.detail(chosen)).toBe('I will be 10 minutes late.');
    expect(send.detail({ ...chosen, cc: 'mom@x.com' })).toBe('Cc: mom@x.com\n\nI will be 10 minutes late.');
    expect(await send.run(chosen)).toMatchObject({ sent: true, from: 'college', to: 'sir@c.edu' });
    expect(calls).toEqual([['send', 'college', { to: 'sir@c.edu', cc: undefined, subject: 'Late', body: 'I will be 10 minutes late.', replyTo: undefined }]]);
  });

  it('gmail_send precheck reports unknown accounts without asking for approval', async () => {
    const { tools } = setup();
    expect((await tools.get('gmail_send').precheck({ to: 'a@b.c', subject: 's', body: 'b', account: 'work' })).error).toMatch(/No Gmail account called "work"/);
  });

  it('sets and clears the default by voice; lists accounts with the default flag', async () => {
    const { tools } = setup();
    expect(await tools.get('accounts_set_default').run({ service: 'gmail', account: 'college' })).toEqual({ default: 'college' });
    const listed = await tools.get('accounts_list').run({});
    expect(listed.accounts.find((a) => a.label === 'college').default).toBe(true);
    expect(await tools.get('accounts_set_default').run({ account: 'none' })).toEqual({ default: null });
    expect((await tools.get('accounts_list').run({})).accounts.every((a) => !a.default)).toBe(true);
  });

  it('renames accounts', async () => {
    const { tools } = setup();
    expect(await tools.get('accounts_rename').run({ account: 'college', label: 'Uni' })).toEqual({ renamed: 'uni' });
  });

  it('gmail_connect opens consent and reports when connected', async () => {
    const { tools, connected, finishConnect } = setup();
    const out = await tools.get('gmail_connect').run({});
    expect(out.note).toMatch(/opened Google's sign-in page/);
    finishConnect({ email: 'new@gmail.com', label: 'new' });
    await new Promise((r) => setTimeout(r, 0));
    expect(connected).toEqual([{ email: 'new@gmail.com', label: 'new' }]);
  });
});
