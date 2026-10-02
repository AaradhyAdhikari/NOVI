import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PS = (fn) => `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
const PS_PROTECT = PS('Protect');
const PS_UNPROTECT = PS('Unprotect');

export function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      resolve(String(stdout).trim());
    });
    child.stdin.end(input);
  });
}

// Windows DPAPI (current user). Secrets travel to PowerShell as base64 on stdin, never in argv.
export function dpapiCipher(run = runPowerShell) {
  return {
    protect: async (plain) => run(PS_PROTECT, Buffer.from(String(plain), 'utf8').toString('base64')),
    unprotect: async (blob) => Buffer.from(await run(PS_UNPROTECT, blob), 'base64').toString('utf8'),
  };
}

// Non-Windows fallback: AES-256-GCM with a key file next to Novi's data.
export function fileKeyCipher(keyFile) {
  const key = () => {
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    return fs.readFileSync(keyFile);
  };
  return {
    protect: async (plain) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    unprotect: async (blob) => {
      const b = Buffer.from(blob, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

export function defaultCipher(dataDir) {
  return process.platform === 'win32' ? dpapiCipher() : fileKeyCipher(path.join(dataDir, 'secret.key'));
}

export class SecretStore {
  constructor({ file, cipher }) {
    this.file = file;
    this.cipher = cipher;
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  _save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async set(id, plain) {
    const blob = await this.cipher.protect(plain);
    const data = this._load();
    data[id] = blob;
    this._save(data);
  }

  async get(id) {
    const blob = this._load()[id];
    return blob ? this.cipher.unprotect(blob) : null;
  }

  delete(id) {
    const data = this._load();
    if (!(id in data)) return;
    delete data[id];
    this._save(data);
  }
}
