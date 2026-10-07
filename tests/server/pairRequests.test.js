import { describe, it, expect } from 'vitest';
import { PairRequests } from '../../server/pairRequests.js';

const make = () => {
  let t = 1_000_000;
  const issued = [];
  const reqs = new PairRequests({ issue: (name) => { issued.push(name); return { token: `tok-${name}`, deviceId: `id-${name}` }; }, now: () => t });
  return { reqs, issued, advance: (ms) => { t += ms; } };
};

describe('pair requests ("Ask the laptop")', () => {
  it('lets the phone pick up its token once after the laptop allows it', () => {
    const { reqs, issued } = make();
    const { id, secret } = reqs.create({ name: 'Galaxy S24+', ip: '192.168.1.40' });
    expect(reqs.check(id, secret)).toEqual({ status: 'pending' });
    expect(reqs.pending().map((r) => r.name)).toEqual(['Galaxy S24+']);
    reqs.decide(id, true);
    expect(issued).toEqual(['Galaxy S24+']);
    expect(reqs.check(id, secret)).toEqual({ status: 'allowed', token: 'tok-Galaxy S24+', deviceId: 'id-Galaxy S24+' });
    expect(reqs.check(id, secret).status).toBe('expired');
  });

  it('needs the secret to pick up the token', () => {
    const { reqs } = make();
    const { id } = reqs.create({ name: 'S24', ip: '1' });
    reqs.decide(id, true);
    expect(reqs.check(id, 'guess').status).toBe('expired');
  });

  it('denies, expires after 2 minutes, one request per address, at most 3 waiting', () => {
    const { reqs, advance, issued } = make();
    const a = reqs.create({ name: 'A', ip: '1' });
    expect(() => reqs.create({ name: 'A again', ip: '1' })).toThrow();
    reqs.create({ name: 'B', ip: '2' });
    reqs.create({ name: 'C', ip: '3' });
    expect(() => reqs.create({ name: 'D', ip: '4' })).toThrow();
    reqs.decide(a.id, false);
    expect(reqs.check(a.id, a.secret).status).toBe('denied');
    advance(2 * 60_000 + 1);
    expect(reqs.pending()).toEqual([]);
    expect(issued).toEqual([]);
  });

  it('cleans up names', () => {
    const { reqs } = make();
    reqs.create({ name: '<b>x</b>'.repeat(20), ip: '9' });
    expect(reqs.pending()[0].name.length).toBeLessThanOrEqual(40);
  });
});
