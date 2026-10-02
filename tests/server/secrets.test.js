import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore, dpapiCipher, fileKeyCipher } from '../../server/accounts/secrets.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-sec-'));

describe('dpapiCipher', () => {
  it('passes secrets to PowerShell as base64 on stdin, never in the script', async () => {
    const calls = [];
    const run = async (script, input) => {
      calls.push({ script, input });
      return script.includes('::Protect(') ? `BLOB(${input})` : input.replace(/^BLOB\(|\)$/g, '');
    };
    const c = dpapiCipher(run);
    const blob = await c.protect('refresh-ドキュメント');
    expect(calls[0].input).toBe(Buffer.from('refresh-ドキュメント').toString('base64'));
    expect(calls[0].script).not.toContain('refresh');
    expect(await c.unprotect(blob)).toBe('refresh-ドキュメント');
  });

  it.runIf(process.platform === 'win32')('round-trips with real Windows DPAPI', async () => {
    const c = dpapiCipher();
    expect(await c.unprotect(await c.protect('real-secret-✓'))).toBe('real-secret-✓');
  }, 30000);
});

describe('SecretStore with fileKeyCipher', () => {
  it('stores encrypted values, reads them back across instances, deletes them', async () => {
    const dir = tmp();
    const make = () => new SecretStore({ file: path.join(dir, 'secrets.json'), cipher: fileKeyCipher(path.join(dir, 'secret.key')) });
    const store = make();
    await store.set('acc1', 'my-refresh-token');
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain('my-refresh-token');
    expect(await store.get('acc1')).toBe('my-refresh-token');
    expect(await make().get('acc1')).toBe('my-refresh-token');
    store.delete('acc1');
    expect(await store.get('acc1')).toBeNull();
    expect(await store.get('missing')).toBeNull();
  });
});
