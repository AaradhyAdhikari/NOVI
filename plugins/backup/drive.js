import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Copies the newest local backup zip to the user's Google Drive ("Novi backups" folder) and keeps
// the newest 7 there. Uses only the drive.file permission, so Novi sees and deletes nothing but
// the files it created itself.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';

export function createDriveUploader({ google, stateFile }) {
  const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const write = (patch) => {
    const next = { ...read(), ...patch };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
    return next;
  };

  function account() {
    if (!google?.configured) throw new Error("Google isn't set up yet, so backups stay on the laptop.");
    const r = google.resolve();
    if (r.error) throw new Error(`${r.error} (connect Google in Settings for Drive backups).`);
    const acc = r.account || null;
    if (!acc) throw new Error('Choose a default Google account in Settings for Drive backups.');
    if (!(acc.scopes || []).includes(DRIVE_SCOPE)) throw new Error('Drive backups need the Drive files permission: reconnect Google in Settings and tick it.');
    return acc;
  }

  async function folder(acc) {
    const known = read().folderId;
    if (known) return known;
    const created = await google.call(acc, FILES, { method: 'POST', body: JSON.stringify({ name: 'Novi backups', mimeType: 'application/vnd.google-apps.folder' }) });
    write({ folderId: created.id });
    return created.id;
  }

  return {
    state: read,
    async upload(filePath) {
      const acc = account();
      const parent = await folder(acc);
      const name = path.basename(filePath);
      const boundary = `novi${crypto.randomBytes(8).toString('hex')}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: application/zip\r\n\r\n`),
        fs.readFileSync(filePath),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const file = await google.call(acc, UPLOAD, { method: 'POST', body, raw: true, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
      write({ lastUpload: { id: file.id, name, at: new Date().toISOString() }, lastError: null });
      return file;
    },
    async prune(keep = 7) {
      const acc = account();
      const parent = await folder(acc);
      const q = `'${parent}' in parents and trashed=false and name contains 'novi-data-'`;
      const { files = [] } = await google.call(acc, `${FILES}?q=${encodeURIComponent(q)}&orderBy=createdTime&fields=files(id,name,createdTime)&pageSize=100`);
      const ours = files.filter((f) => /^novi-data-.*\.zip$/.test(f.name)).sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
      for (const old of ours.slice(0, Math.max(0, ours.length - keep))) await google.call(acc, `${FILES}/${old.id}`, { method: 'DELETE' });
    },
    fail(err) {
      write({ lastError: { message: err.message, at: new Date().toISOString() } });
    },
  };
}
