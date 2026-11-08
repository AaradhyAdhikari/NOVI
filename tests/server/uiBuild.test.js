import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uiBuildOf } from '../../server/uiBuild.js';
import { staleUi } from '../../src/lib/pageBuild.js';

// Live 2026-11-08: the phone app kept its page open across a Novi restart (only the socket reconnected), so the
// new remote-control video never ran and the phone stayed on the slow pictures. Now the page reloads itself
// when Novi serves newer page code.
describe('which page code Novi serves', () => {
  it('reads the main script name from dist/index.html', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-BpOo3FEC.js"></script>');
    expect(uiBuildOf(dir)).toBe('index-BpOo3FEC.js');
  });
  it('no built page: nothing to compare', () => {
    expect(uiBuildOf(path.join(os.tmpdir(), 'no-such-dist-xyz'))).toBe(null);
  });
});

describe('when the page reloads itself', () => {
  it('only when both are known and differ, and only once per new build', () => {
    expect(staleUi('index-B.js', 'https://x:3001/assets/index-A.js', null)).toBe(true);
    expect(staleUi('index-A.js', 'https://x:3001/assets/index-A.js', null)).toBe(false);
    expect(staleUi(null, 'https://x:3001/assets/index-A.js', null)).toBe(false);
    expect(staleUi('index-B.js', '', null)).toBe(false); // dev server: no built script
    expect(staleUi('index-B.js', 'https://x:3001/assets/index-A.js', 'index-B.js')).toBe(false); // already reloaded for it
  });
});
