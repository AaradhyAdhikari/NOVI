// Uploads to plugins (Novi Flick, 2026-11-16): the body streams to a temp file with a size cap, so a big
// photo or video never sits in memory. Plugins opt in per route: { upload: true } and, for phones, { phone: true }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function uploadAllowed(info, local) {
  if (!info?.upload) return false;
  return Boolean(local || info.phone);
}

export function receiveUpload(stream, { dir = os.tmpdir(), maxBytes = 300 * 1024 * 1024 } = {}) {
  const file = path.join(dir, `novi-up-${crypto.randomBytes(8).toString('hex')}`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      stream.unpipe?.(out);
      stream.destroy?.();
      out.destroy();
      fs.rm(file, { force: true }, () => reject(err));
    };
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) fail(new Error(`That file is too big (over ${Math.round(maxBytes / 1048576)} MB).`));
    });
    stream.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!failed) resolve({ file, size }); });
    stream.pipe(out);
  });
}
