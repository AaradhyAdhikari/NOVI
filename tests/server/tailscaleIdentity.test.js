import { describe, it, expect } from 'vitest';
import { createTailscaleIdentity, isTailscaleAddress } from '../../server/tailscaleIdentity.js';

function fakeRun({ owner = 'me@gmail.com', peers = {} } = {}) {
  const calls = [];
  return {
    calls,
    run: async (exe, args) => {
      calls.push(args);
      if (args[0] === 'status') return { stdout: JSON.stringify({ Self: { UserID: 7 }, User: { 7: { LoginName: owner } } }) };
      if (args[0] === 'whois') {
        const peer = peers[args[2]];
        if (!peer) throw new Error('no match');
        return { stdout: JSON.stringify({ Node: { ComputedName: peer.name, Hostinfo: { Hostname: peer.host } }, UserProfile: peer.login ? { LoginName: peer.login } : undefined }) };
      }
      throw new Error('unexpected');
    },
  };
}

describe('isTailscaleAddress', () => {
  it('knows the Tailscale ranges', () => {
    expect(isTailscaleAddress('100.78.167.22')).toBe(true);
    expect(isTailscaleAddress('::ffff:100.101.5.9')).toBe(true);
    expect(isTailscaleAddress('fd7a:115c:a1e0::1234')).toBe(true);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false); // outside 100.64.0.0/10
    expect(isTailscaleAddress('192.168.1.36')).toBe(false);
  });
});

describe('Tailscale identity', () => {
  it("recognises the laptop owner's own phone and names it", async () => {
    const { run, calls } = fakeRun({ peers: { '100.101.5.9': { login: 'me@gmail.com', name: 'galaxy-s24', host: 'Galaxy S24+' } } });
    const id = createTailscaleIdentity({ run, exe: 'tailscale' });
    expect(await id.ownerDevice('::ffff:100.101.5.9')).toEqual({ name: 'Galaxy S24+' });
    expect(calls.find((a) => a[0] === 'whois')).toEqual(['whois', '--json', '100.101.5.9']);
  });

  it('refuses other people, shared/tagged devices, and non-Tailscale addresses', async () => {
    const { run, calls } = fakeRun({ peers: { '100.101.5.10': { login: 'friend@gmail.com', name: 'x', host: 'x' }, '100.101.5.11': { name: 'server', host: 'server' } } });
    const id = createTailscaleIdentity({ run, exe: 'tailscale' });
    expect(await id.ownerDevice('100.101.5.10')).toBeNull();
    expect(await id.ownerDevice('100.101.5.11')).toBeNull();
    expect(await id.ownerDevice('100.101.5.99')).toBeNull();
    const before = calls.length;
    expect(await id.ownerDevice('192.168.1.20')).toBeNull();
    expect(calls.length).toBe(before);
  });

  it('is off without Tailscale', async () => {
    expect(await createTailscaleIdentity({ run: async () => { throw new Error('x'); }, exe: null }).ownerDevice('100.101.5.9')).toBeNull();
  });
});
