import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDriveUploader } from '../../plugins/backup/drive.js';

const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const account = { id: 'g1', label: 'me', scopes: [DRIVE] };

function fakeGoogle({ files = [], resolve = { account } } = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    resolve: () => resolve,
    async call(acc, url, init = {}) {
      calls.push({ url, ...init });
      if (url.endsWith('/drive/v3/files') && init.method === 'POST') return { id: 'folder1' };
      if (url.includes('uploadType=multipart')) return { id: `file${calls.length}`, name: 'x' };
      if (url.includes('/drive/v3/files?q=')) return { files };
      if (init.method === 'DELETE') return {};
      throw new Error(`unexpected ${url}`);
    },
  };
}

function setup(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-drive-'));
  const zip = path.join(dir, 'novi-data-2026-10-08-0230.zip');
  fs.writeFileSync(zip, 'ZIPBYTES');
  const google = fakeGoogle(opts);
  const drive = createDriveUploader({ google, stateFile: path.join(dir, 'drive.json') });
  return { drive, google, zip, dir };
}

describe('Drive backup uploader', () => {
  it('creates the "Novi backups" folder once, then uploads the zip into it', async () => {
    const { drive, google, zip } = setup();
    await drive.upload(zip);
    await drive.upload(zip);
    const folders = google.calls.filter((c) => c.url.endsWith('/drive/v3/files') && c.method === 'POST');
    expect(folders).toHaveLength(1);
    expect(JSON.parse(folders[0].body)).toEqual({ name: 'Novi backups', mimeType: 'application/vnd.google-apps.folder' });
    const up = google.calls.find((c) => c.url.includes('uploadType=multipart'));
    expect(up.raw).toBe(true);
    expect(up.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    const body = up.body.toString();
    expect(body).toContain('"name":"novi-data-2026-10-08-0230.zip"');
    expect(body).toContain('"parents":["folder1"]');
    expect(body).toContain('ZIPBYTES');
    expect(drive.state().lastUpload).toMatchObject({ name: 'novi-data-2026-10-08-0230.zip' });
  });

  it('keeps the newest 7 and deletes only its own older backups', async () => {
    const files = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, name: `novi-data-2026-10-0${i + 1}-0230.zip`, createdTime: `2026-10-0${i + 1}T02:30:00Z` }));
    files.push({ id: 'other', name: 'holiday-photos.zip', createdTime: '2026-01-01T00:00:00Z' });
    const { drive, google, zip } = setup({ files });
    await drive.upload(zip);
    await drive.prune(7);
    const list = google.calls.find((c) => c.url.includes('/drive/v3/files?q='));
    expect(decodeURIComponent(list.url)).toContain("'folder1' in parents and trashed=false and name contains 'novi-data-'");
    const deleted = google.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop());
    expect(deleted).toEqual(['f0', 'f1']);
  });

  it('explains what to do when Google is not connected or Drive is not allowed', async () => {
    await expect(setup({ resolve: { error: 'No Gmail account is connected yet' } }).drive.upload('x')).rejects.toThrow(/connect/i);
    await expect(setup({ resolve: { account: { ...account, scopes: [] } } }).drive.upload('x')).rejects.toThrow(/Drive/);
  });
});
