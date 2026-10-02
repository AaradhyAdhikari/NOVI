import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountRegistry } from '../../server/accounts/registry.js';
import { resolveAccount, askNote } from '../../server/accounts/resolve.js';
import { UserFacingError } from '../../server/errors.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-acc-')), 'accounts.json');

function two() {
  const r = new AccountRegistry(file());
  const p = r.add({ provider: 'google', email: 'p@gmail.com' });
  r.setLabel(p.id, 'Personal');
  const c = r.add({ provider: 'google', email: 'c@college.edu' });
  r.setLabel(c.id, 'college');
  return { r, p, c };
}

describe('AccountRegistry', () => {
  it('labels new accounts from the email, unique per provider', () => {
    const r = new AccountRegistry(file());
    const a = r.add({ provider: 'google', email: 'Aaradhy.A@gmail.com', scopes: ['s'] });
    expect(a).toMatchObject({ provider: 'google', email: 'aaradhy.a@gmail.com', label: 'aaradhy-a', status: 'connected', scopes: ['s'] });
    expect(r.add({ provider: 'google', email: 'aaradhy.a@college.edu' }).label).toBe('aaradhy-a-2');
  });

  it('reconnecting the same email updates the existing account', () => {
    const r = new AccountRegistry(file());
    const a = r.add({ provider: 'google', email: 'x@gmail.com' });
    r.markExpired(a.id);
    expect(r.get(a.id).status).toBe('expired');
    const again = r.add({ provider: 'google', email: 'X@gmail.com', scopes: ['new'] });
    expect(again.id).toBe(a.id);
    expect(again).toMatchObject({ status: 'connected', scopes: ['new'] });
    expect(r.list('google')).toHaveLength(1);
  });

  it('renames, rejecting duplicate labels', () => {
    const { r, c } = two();
    expect(r.get(c.id).label).toBe('college');
    expect(() => r.setLabel(c.id, 'PERSONAL')).toThrow(UserFacingError);
  });

  it('sets, clears and persists defaults; removing the default clears it', () => {
    const f = file();
    const r = new AccountRegistry(f);
    const a = r.add({ provider: 'google', email: 'a@gmail.com' });
    r.setDefault('google', a.id);
    expect(new AccountRegistry(f).defaultFor('google').email).toBe('a@gmail.com');
    r.setDefault('google', null);
    expect(r.defaultFor('google')).toBeNull();
    r.setDefault('google', a.id);
    expect(r.remove(a.id)).toBe(true);
    expect(r.defaultFor('google')).toBeNull();
    expect(new AccountRegistry(f).list()).toEqual([]);
  });
});

describe('resolveAccount', () => {
  it('explains when nothing is connected', () => {
    expect(resolveAccount(new AccountRegistry(file()), 'google').error).toMatch(/No Gmail account is connected/);
  });

  it('uses the only account without asking', () => {
    const r = new AccountRegistry(file());
    r.add({ provider: 'google', email: 'solo@gmail.com' });
    expect(resolveAccount(r, 'google').account.email).toBe('solo@gmail.com');
  });

  it('matches label, email, or a unique prefix', () => {
    const { r } = two();
    expect(resolveAccount(r, 'google', 'College').account.email).toBe('c@college.edu');
    expect(resolveAccount(r, 'google', 'p@gmail.com').account.label).toBe('personal');
    expect(resolveAccount(r, 'google', 'coll').account.label).toBe('college');
  });

  it('lists connected accounts for unknown names', () => {
    const { r } = two();
    expect(resolveAccount(r, 'google', 'work').error).toBe('No Gmail account called "work". Connected: personal, college.');
  });

  it('asks when several are connected and there is no default, otherwise uses the default', () => {
    const { r, c } = two();
    const res = resolveAccount(r, 'google');
    expect(res.ask).toEqual([{ label: 'personal', email: 'p@gmail.com' }, { label: 'college', email: 'c@college.edu' }]);
    expect(askNote(res.ask)).toBe('Which account: personal (p@gmail.com) or college (c@college.edu)?');
    r.setDefault('google', c.id);
    expect(resolveAccount(r, 'google').account.label).toBe('college');
  });

  it('accepts "all" only where allowed', () => {
    const { r } = two();
    expect(resolveAccount(r, 'google', 'all', { allowAll: true }).accounts).toHaveLength(2);
    expect(resolveAccount(r, 'google', 'all').error).toMatch(/which Gmail account/);
  });
});
