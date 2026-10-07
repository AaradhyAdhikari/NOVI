import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailscaleCert, findTailscale } from '../../server/tailscale.js';

const NAME = 'novi-laptop.tail1234.ts.net';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-ts-'));

function fakeRun({ state = 'Running', certFails = false } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push(args);
    if (args[0] === 'status') return { stdout: JSON.stringify({ BackendState: state, Self: { DNSName: `${NAME}.` } }) };
    if (args[0] === 'cert') {
      if (certFails) throw new Error('your Tailscale account does not support getting TLS certs');
      fs.writeFileSync(args[2], 'CERT');
      fs.writeFileSync(args[4], 'KEY');
      return { stdout: '' };
    }
    throw new Error(`unexpected ${args}`);
  };
  return { run, calls };
}

describe('tailscaleCert', () => {
  it('returns name, key and cert when status and cert succeed', async () => {
    const dir = tmp();
    const { run, calls } = fakeRun();
    const ts = await tailscaleCert({ run, exe: 'tailscale', dir });
    expect(ts.name).toBe(NAME);
    expect(String(ts.cert)).toBe('CERT');
    expect(String(ts.key)).toBe('KEY');
    expect(calls[1]).toEqual(['cert', '--cert-file', path.join(dir, 'ts.crt'), '--key-file', path.join(dir, 'ts.key'), NAME]);
  });

  it('returns null when logged out', async () => {
    const { run, calls } = fakeRun({ state: 'NeedsLogin' });
    expect(await tailscaleCert({ run, exe: 'tailscale', dir: tmp() })).toBeNull();
    expect(calls.some((a) => a[0] === 'cert')).toBe(false);
  });

  it('returns null when the cert command fails (HTTPS certificates off)', async () => {
    const { run } = fakeRun({ certFails: true });
    expect(await tailscaleCert({ run, exe: 'tailscale', dir: tmp() })).toBeNull();
  });

  it('returns null when tailscale is not installed', async () => {
    const { run } = fakeRun();
    expect(await tailscaleCert({ run, exe: null, dir: tmp() })).toBeNull();
  });
});

describe('findTailscale', () => {
  it('prefers the Program Files install and falls back to null', () => {
    expect(findTailscale({ exists: () => true })).toMatch(/Tailscale[\\/]tailscale\.exe$/);
    expect(findTailscale({ exists: () => false, onPath: false })).toBeNull();
  });
});
